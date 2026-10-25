package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/auth"
	"github.com/wuwe1/moco/internal/config"
)

var b64 = base64.RawURLEncoding

const origin = "https://moco.example.com"

func setup(t *testing.T) (*httptest.Server, string, ed25519.PrivateKey) {
	t.Helper()
	t.Setenv("MOCOD_HOME", t.TempDir())
	t.Setenv("SHELL", "/bin/sh")
	pub, priv, _ := ed25519.GenerateKey(nil)
	key := b64.EncodeToString(pub)
	code, _, _ := auth.NewPairing()
	if err := auth.Pair(code, key, "test"); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Cfg:     config.Config{Name: "box", Origins: []string{"moco.example.com"}, Command: []string{"cat"}},
		Version: "test",
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, key, priv
}

func dial(t *testing.T, ts *httptest.Server, from string) (*websocket.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{
		Subprotocols: []string{Protocol},
		HTTPHeader:   http.Header{"Origin": {from}},
	})
	return c, err
}

func TestTerminalRoundTrip(t *testing.T) {
	ts, key, priv := setup(t)
	c, err := dial(t, ts, origin)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	wsjson.Write(ctx, c, message{Type: "hello", Key: key, Cols: 80, Rows: 24})
	var ch message
	if err := wsjson.Read(ctx, c, &ch); err != nil || ch.Type != "challenge" || ch.Name != "box" {
		t.Fatalf("challenge: %+v %v", ch, err)
	}
	nonce, _ := b64.DecodeString(ch.Nonce)
	wsjson.Write(ctx, c, message{Type: "auth", Sig: b64.EncodeToString(ed25519.Sign(priv, auth.Message(ch.Name, nonce)))})
	var ready message
	if err := wsjson.Read(ctx, c, &ready); err != nil || ready.Type != "ready" {
		t.Fatalf("ready: %+v %v", ready, err)
	}

	c.Write(ctx, websocket.MessageBinary, append([]byte{1}, `{"cols":100,"rows":30}`...))
	c.Write(ctx, websocket.MessageBinary, append([]byte{0}, "hello moco\n"...))
	var got []byte
	for !bytes.Contains(got, []byte("hello moco")) {
		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (got %q)", err, got)
		}
		if typ == websocket.MessageBinary && data[0] == 0 {
			got = append(got, data[1:]...)
		}
	}
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
