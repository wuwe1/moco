package server

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/auth"
	"github.com/wuwe1/moco/internal/herdr"
	"github.com/wuwe1/moco/internal/herdr/herdrtest"
)

func dialWatch(t *testing.T, ts *httptest.Server, key string, priv ed25519.PrivateKey) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{
		Subprotocols: []string{ProtocolFrames},
		HTTPHeader:   http.Header{"Origin": {origin}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	wsjson.Write(ctx, c, message{Type: "hello", Key: key, Watch: true})
	var ch message
	wsjson.Read(ctx, c, &ch)
	nonce, _ := b64.DecodeString(ch.Nonce)
	wsjson.Write(ctx, c, message{Type: "auth", Sig: b64.EncodeToString(ed25519.Sign(priv, auth.Message(ch.Name, nonce)))})
	var ready message
	if err := wsjson.Read(ctx, c, &ready); err != nil || ready.Type != "ready" {
		t.Fatalf("ready: %+v %v", ready, err)
	}
	return c, ctx
}

func readHerdr(t *testing.T, ctx context.Context, c *websocket.Conn) *herdr.State {
	t.Helper()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var m struct {
			Type  string
			Herdr *herdr.State
		}
		if typ == websocket.MessageText && json.Unmarshal(data, &m) == nil && m.Type == "herdr" {
			return m.Herdr
		}
	}
}

func snapshotOf(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// watch 连接：不开终端；herdr 的状态先来一次、变了再来；切 tab 转给 herdr，不许的 method 拒掉
func TestWatchHerdr(t *testing.T) {
	h := herdrtest.Start(t)
	h.SetSnapshot(snapshotOf(t, `{"focused_tab_id": "w1:t1", "workspaces": [], "tabs": [{"tab_id": "w1:t1", "workspace_id": "w1", "number": 1}], "agents": []}`))
	marker := filepath.Join(t.TempDir(), "started")
	ts, key, priv, _ := setupWith(t, func(s *Server) { s.HerdrSocket = h.Path }, "touch", marker)
	c, ctx := dialWatch(t, ts, key, priv)

	if st := readHerdr(t, ctx, c); st == nil || st.Tab != "w1:t1" {
		t.Fatalf("first state: %+v", st)
	}
	h.SetSnapshot(snapshotOf(t, `{"focused_tab_id": "w1:t2", "workspaces": [], "tabs": [], "agents": [{"pane_id": "w1:p2", "agent": "claude", "agent_status": "blocked"}]}`))
	st := readHerdr(t, ctx, c)
	if st.Tab != "w1:t2" || len(st.Agents) != 1 || st.Agents[0].Status != "blocked" {
		t.Fatalf("changed state: %+v", st)
	}

	var out map[string]any
	ask(t, ctx, c, "herdr", map[string]any{"method": "tab.focus", "params": map[string]string{"tab_id": "w1:t1"}}, &out)
	calls := h.Calls()
	if len(calls) != 1 || calls[0].Method != "tab.focus" || !strings.Contains(string(calls[0].Params), `"w1:t1"`) {
		t.Fatalf("herdr calls: %+v", calls)
	}
	sendRequest(ctx, c, 2, "herdr", map[string]any{"method": "server.stop"})
	if r := readReply(t, ctx, c); r.Error == "" {
		t.Fatalf("server.stop allowed: %+v", r)
	}
	if len(h.Calls()) != 1 {
		t.Fatal("disallowed method reached herdr")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("watch connection started the command")
	}
}

// herdr 没开：状态是 null
func TestWatchWithoutHerdr(t *testing.T) {
	ts, key, priv, _ := setupWith(t, func(s *Server) { s.HerdrSocket = "/nonexistent/h.sock" }, "cat")
	c, ctx := dialWatch(t, ts, key, priv)
	if st := readHerdr(t, ctx, c); st != nil {
		t.Fatalf("state without herdr: %+v", st)
	}
}
