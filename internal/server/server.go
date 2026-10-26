// Package server 是 mocod 的 HTTP 服务：/health、/pair、/ws。
//
// /ws 的协议（子协议 moco.v2）：
//
//	手机 → {type:"hello", key, cols, rows, theme}  theme：回答程序对颜色的查询
//	mocod → {type:"challenge", nonce, name}      nonce、签名都是 base64url
//	手机 → {type:"auth", sig}                    对 auth.Message(name, nonce) 的 Ed25519 签名
//	mocod → {type:"ready", name}                 之后开终端
//	之后二进制帧第一个字节是类型：手机发 0=输入、1=改大小（JSON {cols,rows,cell?,theme?}，换了主题也走这条）；
//	mocod 发 2=一帧（见 frames.go），手机画完回 3=确认（4 字节序号）。
//	命令退出时 mocod 发 {type:"exit", code} 再关连接
package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/auth"
	"github.com/wuwe1/moco/internal/config"
	"github.com/wuwe1/moco/internal/screen"
	"github.com/wuwe1/moco/internal/term"
)

// 在电脑上维护画面，只发变化（internal/screen）
const ProtocolFrames = "moco.v2"

// 关连接的原因码：App 看到 4401 就提示重新配对
const (
	CloseUnauthorized websocket.StatusCode = 4401
	CloseStartFailed  websocket.StatusCode = 4500
)

// features 写在 /health 里，手机看有没有再用：旧版 mocod 不认 watch，会照常开一个终端
var features = []string{"watch", "push"}

type Server struct {
	Cfg         config.Config
	Version     string
	Log         *slog.Logger
	HerdrSocket string       // 空就用 herdr 默认的位置；测试里指向假的 herdr
	PushHTTP    *http.Client // 发推送用的；测试里换成认假推送服务证书的

	hw   herdrWatch
	push pusher
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("OPTIONS /pair", s.preflight)
	mux.HandleFunc("POST /pair", s.pair)
	mux.HandleFunc("GET /ws", s.ws)
	if h := s.web(); h != nil {
		mux.Handle("GET /", h)
	}
	return mux
}

// allowed 判断网页来源：同源总是可以；否则主机名要在名单里，且必须是 https（本机调试除外）
func (s *Server) allowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return false
	}
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	if u.Host == r.Host {
		return true
	}
	host := u.Hostname()
	local := host == "localhost" || host == "127.0.0.1"
	if u.Scheme != "https" && !local {
		return false
	}
	for _, p := range s.Cfg.Origins {
		if ok, _ := path.Match(p, host); ok {
			return true
		}
	}
	return false
}

func (s *Server) cors(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Add("Vary", "Origin")
	if !s.allowed(r) {
		return false
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	h.Set("Access-Control-Allow-Methods", "GET, POST")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
		h.Set("Access-Control-Allow-Private-Network", "true")
	}
	return true
}

func (s *Server) preflight(w http.ResponseWriter, r *http.Request) {
	if !s.cors(w, r) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	s.cors(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"name": s.Cfg.Name, "version": s.Version, "protocol": ProtocolFrames, "protocols": []string{ProtocolFrames}, "features": features})
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	if !s.cors(w, r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin not allowed"})
		return
	}
	var req struct{ Code, Key, Device string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if err := auth.Pair(req.Code, req.Key, req.Device); err != nil {
		s.Log.Warn("pair failed", "device", req.Device, "err", err)
		status := http.StatusForbidden
		if !errors.Is(err, auth.ErrBadCode) && !errors.Is(err, auth.ErrNoPairing) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	s.Log.Info("paired", "device", req.Device)
	writeJSON(w, http.StatusOK, map[string]string{"name": s.Cfg.Name})
}

type message struct {
	Type  string `json:"type"`
	Key   string `json:"key,omitempty"`
	Sig   string `json:"sig,omitempty"`
	Nonce string `json:"nonce,omitempty"`
	Name  string `json:"name,omitempty"`
	Cols  uint16 `json:"cols,omitempty"`
	Rows  uint16 `json:"rows,omitempty"`
	Code  *int   `json:"code,omitempty"`
	Watch bool   `json:"watch,omitempty"` // 只看 herdr、不开终端（herdr.go）
	ID    uint32 `json:"id,omitempty"`
	Path  string `json:"path,omitempty"`
	Error string `json:"error,omitempty"`
	Text  string `json:"text,omitempty"`

	Theme screen.Theme `json:"theme,omitzero"`
	Cell  *cellSize    `json:"cell,omitempty"` // 手机上一格多少 CSS 像素，回答 CSI 16 t 用
}

type cellSize struct {
	W int `json:"w"`
	H int `json:"h"`
}

func (s *Server) ws(w http.ResponseWriter, r *http.Request) {
	if !s.allowed(r) {
		s.Log.Warn("origin rejected", "remote", r.RemoteAddr, "origin", r.Header.Get("Origin"), "host", r.Host)
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	// 来源上面自己查过了
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{ProtocolFrames},
		InsecureSkipVerify: true,
		// 终端输出里大量重复的控制序列，压缩后大约只剩五分之一；手机在外面用流量时差别很大
		CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		s.Log.Warn("websocket accept failed", "remote", r.RemoteAddr, "err", err)
		return
	}
	defer c.CloseNow()
	if c.Subprotocol() != ProtocolFrames {
		c.Close(websocket.StatusPolicyViolation, "subprotocol "+ProtocolFrames+" required")
		return
	}
	c.SetReadLimit(1 << 20)

	hello, err := s.handshake(r.Context(), c)
	if err != nil {
		s.Log.Warn("auth failed", "remote", r.RemoteAddr, "err", err)
		c.Close(CloseUnauthorized, err.Error())
		return
	}
	c.SetReadLimit(maxUpload + 5)
	go auth.Touch(hello.Key)
	if hello.Watch {
		if err := wsjson.Write(r.Context(), c, message{Type: "ready", Name: s.Cfg.Name}); err != nil {
			return
		}
		s.Log.Info("watch open", "remote", r.RemoteAddr)
		s.Log.Info("watch closed", "remote", r.RemoteAddr, "why", s.watch(r.Context(), c, hello.Key))
		return
	}
	cols, rows := hello.Cols, hello.Rows

	sess, err := term.Start(s.Cfg.Command, cols, rows)
	if err != nil {
		s.Log.Error("start failed", "err", err)
		c.Close(CloseStartFailed, err.Error())
		return
	}
	defer sess.Close()
	if err := wsjson.Write(r.Context(), c, message{Type: "ready", Name: s.Cfg.Name}); err != nil {
		return
	}
	s.Log.Info("session open", "remote", r.RemoteAddr, "cols", cols, "rows", rows)
	s.Log.Info("session closed", "remote", r.RemoteAddr, "why", s.pumpFrames(r.Context(), c, sess, hello))
}

// handshake 验明手机身份，返回它的 hello（行列已经兜过底）
func (s *Server) handshake(ctx context.Context, c *websocket.Conn) (hello message, err error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err = wsjson.Read(ctx, c, &hello); err != nil {
		return
	}
	if hello.Type != "hello" {
		return hello, errors.New("expected hello")
	}
	if _, err = auth.Find(hello.Key); err != nil {
		return
	}
	nonce := auth.Nonce()
	if err = wsjson.Write(ctx, c, message{Type: "challenge", Nonce: base64.RawURLEncoding.EncodeToString(nonce), Name: s.Cfg.Name}); err != nil {
		return
	}
	var a message
	if err = wsjson.Read(ctx, c, &a); err != nil {
		return
	}
	if err = auth.Verify(hello.Key, a.Sig, s.Cfg.Name, nonce); err != nil {
		return
	}
	hello.Cols, hello.Rows = max(hello.Cols, 20), max(hello.Rows, 5)
	return hello, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
