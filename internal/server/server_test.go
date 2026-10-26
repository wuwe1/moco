package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/auth"
	"github.com/wuwe1/moco/internal/config"
)

// 整个包的测试都在一个临时的 MOCOD_HOME 里跑。每个测试的 t.Setenv 结束时还原成它，而不是用户真的 ~/.config/mocod：
// 测试结束后还没跑完的协程（比如连上时记最后连接时间的 auth.Touch）不会写坏用户的设备名单
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "mocod-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("MOCOD_HOME", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

var b64 = base64.RawURLEncoding

const origin = "https://moco.example.com"

func setup(t *testing.T) (*httptest.Server, string, ed25519.PrivateKey) {
	ts, key, priv, _ := setupCmd(t, "cat")
	return ts, key, priv
}

// 日志写进这里，测试结束后查结束原因
type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func setupCmd(t *testing.T, command ...string) (*httptest.Server, string, ed25519.PrivateKey, *logBuf) {
	t.Helper()
	return setupWith(t, func(*Server) {}, command...)
}

func setupWith(t *testing.T, tweak func(*Server), command ...string) (*httptest.Server, string, ed25519.PrivateKey, *logBuf) {
	t.Helper()
	t.Setenv("MOCOD_HOME", t.TempDir())
	t.Setenv("SHELL", "/bin/sh")
	pub, priv, _ := ed25519.GenerateKey(nil)
	key := b64.EncodeToString(pub)
	logs := &logBuf{}
	code, _, _ := auth.NewPairing()
	if err := auth.Pair(code, key, "test"); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Cfg:     config.Config{Name: "box", Origins: []string{"moco.example.com"}, Command: command},
		Version: "test",
		Log:     slog.New(slog.NewTextHandler(logs, nil)),
	}
	tweak(s)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, key, priv, logs
}

func dial(t *testing.T, ts *httptest.Server, from string) (*websocket.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{
		Subprotocols: []string{ProtocolFrames},
		HTTPHeader:   http.Header{"Origin": {from}},
	})
	return c, err
}

func TestRejectsForeignOrigin(t *testing.T) {
	ts, _, _ := setup(t)
	if _, err := dial(t, ts, "https://evil.example.org"); err == nil {
		t.Fatal("foreign origin accepted")
	}
	if _, err := dial(t, ts, "http://moco.example.com"); err == nil {
		t.Fatal("plain http origin accepted")
	}
}

func TestRejectsUnknownKeyAndBadSignature(t *testing.T) {
	ts, key, _ := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 没登记的公钥：hello 之后直接被关
	other, _, _ := ed25519.GenerateKey(nil)
	c, _ := dial(t, ts, origin)
	wsjson.Write(ctx, c, message{Type: "hello", Key: b64.EncodeToString(other), Cols: 80, Rows: 24})
	var m message
	if err := wsjson.Read(ctx, c, &m); websocket.CloseStatus(err) != CloseUnauthorized {
		t.Fatalf("unknown key: got %+v, %v", m, err)
	}

	// 登记过的公钥、但签名不是它的私钥签的
	_, wrong, _ := ed25519.GenerateKey(nil)
	c, _ = dial(t, ts, origin)
	wsjson.Write(ctx, c, message{Type: "hello", Key: key, Cols: 80, Rows: 24})
	wsjson.Read(ctx, c, &m)
	nonce, _ := b64.DecodeString(m.Nonce)
	wsjson.Write(ctx, c, message{Type: "auth", Sig: b64.EncodeToString(ed25519.Sign(wrong, auth.Message(m.Name, nonce)))})
	if err := wsjson.Read(ctx, c, &m); websocket.CloseStatus(err) != CloseUnauthorized {
		t.Fatalf("bad signature: got %+v, %v", m, err)
	}
}

func TestPairEndpointCORS(t *testing.T) {
	ts, _, _ := setup(t)
	req, _ := http.NewRequest("OPTIONS", ts.URL+"/pair", nil)
	req.Header.Set("Origin", origin)
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != http.StatusNoContent || res.Header.Get("Access-Control-Allow-Origin") != origin {
		t.Fatalf("preflight: %v %v", res, err)
	}
	req, _ = http.NewRequest("OPTIONS", ts.URL+"/pair", nil)
	req.Header.Set("Origin", "https://evil.example.org")
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign preflight: %d", res.StatusCode)
	}
}
