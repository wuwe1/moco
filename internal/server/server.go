// Package server 是 mocod 的 HTTP 服务：/health、/pair、/ws。
//
// /ws 的协议（子协议 moco.v1）：
//
//	手机 → {type:"hello", key, cols, rows}
//	mocod → {type:"challenge", nonce, name}      nonce、签名都是 base64url
//	手机 → {type:"auth", sig}                    对 auth.Message(name, nonce) 的 Ed25519 签名
//	mocod → {type:"ready", name}                 之后开终端
//	之后二进制帧第一个字节是类型：手机发 0=输入、1=改大小（JSON {cols,rows}），mocod 发 0=输出；
//	命令退出时 mocod 发 {type:"exit", code} 再关连接
package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/auth"
	"github.com/wuwe1/moco/internal/config"
	"github.com/wuwe1/moco/internal/term"
)

const Protocol = "moco.v1"

// 关连接的原因码：App 看到 4401 就提示重新配对
const (
	CloseUnauthorized websocket.StatusCode = 4401
	CloseStartFailed  websocket.StatusCode = 4500
)

type Server struct {
	Cfg     config.Config
	Version string
	Log     *slog.Logger
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("OPTIONS /pair", s.preflight)
	mux.HandleFunc("POST /pair", s.pair)
	mux.HandleFunc("GET /ws", s.ws)
	if s.Cfg.Web != "" {
		mux.Handle("GET /", http.FileServer(http.Dir(s.Cfg.Web)))
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
	writeJSON(w, http.StatusOK, map[string]any{"name": s.Cfg.Name, "version": s.Version, "protocol": Protocol})
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
}

func (s *Server) ws(w http.ResponseWriter, r *http.Request) {
	if !s.allowed(r) {
		s.Log.Warn("origin rejected", "remote", r.RemoteAddr, "origin", r.Header.Get("Origin"), "host", r.Host)
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	// 来源上面自己查过了
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Protocol}, InsecureSkipVerify: true})
	if err != nil {
		s.Log.Warn("websocket accept failed", "remote", r.RemoteAddr, "err", err)
		return
	}
	defer c.CloseNow()
	if c.Subprotocol() != Protocol {
		c.Close(websocket.StatusPolicyViolation, "subprotocol "+Protocol+" required")
		return
	}
	c.SetReadLimit(1 << 20)

	key, cols, rows, err := s.handshake(r.Context(), c)
	if err != nil {
		s.Log.Warn("auth failed", "remote", r.RemoteAddr, "err", err)
		c.Close(CloseUnauthorized, err.Error())
		return
	}
	go auth.Touch(key)

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
	why := s.pump(r.Context(), c, sess)
	s.Log.Info("session closed", "remote", r.RemoteAddr, "why", why)
}

func (s *Server) handshake(ctx context.Context, c *websocket.Conn) (key string, cols, rows uint16, err error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var hello message
	if err = wsjson.Read(ctx, c, &hello); err != nil {
		return
	}
	if hello.Type != "hello" {
		return "", 0, 0, errors.New("expected hello")
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
	cols, rows = max(hello.Cols, 20), max(hello.Rows, 5)
	return hello.Key, cols, rows, nil
}

// pump 两头对拷，直到一边结束；另起一个心跳，及早发现手机那头已经没了的连接
// 返回结束的原因，记进日志
func (s *Server) pump(ctx context.Context, c *websocket.Conn, sess *term.Session) string {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var once sync.Once
	var why string
	note := func(reason string) { once.Do(func() { why = reason }) }
	stop := func(reason string) {
		note(reason)
		cancel()
	}

	go func() {
		defer stop("output closed")
		buf := make([]byte, 32*1024)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				if err := c.Write(ctx, websocket.MessageBinary, append([]byte{0}, buf[:n]...)); err != nil {
					stop("write: " + err.Error())
					return
				}
			}
			if err != nil {
				<-sess.Done()
				code := sess.ExitCode()
				note(fmt.Sprintf("command exited with code %d", code))
				wsjson.Write(ctx, c, message{Type: "exit", Code: &code})
				c.Close(websocket.StatusNormalClosure, "exit")
				return
			}
		}
	}()

	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				pcancel()
				if err != nil {
					stop("ping: " + err.Error())
					return
				}
			}
		}
	}()

	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			stop("read: " + err.Error())
			return why
		}
		if typ != websocket.MessageBinary || len(data) == 0 {
			continue
		}
		switch data[0] {
		case 0:
			sess.Write(data[1:])
		case 1:
			var sz struct{ Cols, Rows uint16 }
			if json.Unmarshal(data[1:], &sz) == nil && sz.Cols > 0 && sz.Rows > 0 {
				sess.Resize(sz.Cols, sz.Rows)
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
