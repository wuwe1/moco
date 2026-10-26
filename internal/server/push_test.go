package server

import (
	"crypto/ecdh"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SherClockHolmes/webpush-go"

	"github.com/wuwe1/moco/internal/config"
	"github.com/wuwe1/moco/internal/herdr"
	"github.com/wuwe1/moco/internal/herdr/herdrtest"
)

// 假的推送服务：记下收到的请求，回答 status 里的状态码
type pushService struct {
	*httptest.Server
	mu     sync.Mutex
	got    []*http.Request
	status atomic.Int32
}

func startPushService(t *testing.T) *pushService {
	p := &pushService{}
	p.status.Store(http.StatusCreated)
	p.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.got = append(p.got, r)
		p.mu.Unlock()
		w.WriteHeader(int(p.status.Load()))
	}))
	t.Cleanup(p.Close)
	return p
}

func (p *pushService) wait(t *testing.T, n int) *http.Request {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for time.Now().Before(end) {
		p.mu.Lock()
		if len(p.got) >= n {
			r := p.got[n-1]
			p.mu.Unlock()
			return r
		}
		p.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("push %d never arrived", n)
	return nil
}

func subscription(t *testing.T, endpoint string) map[string]any {
	t.Helper()
	priv, _ := ecdh.P256().GenerateKey(rand.Reader)
	authKey := make([]byte, 16)
	rand.Read(authKey)
	vPriv, vPub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"host":     "phone-host-1",
		"endpoint": endpoint,
		"keys":     map[string]string{"p256dh": b64.EncodeToString(priv.PublicKey().Bytes()), "auth": b64.EncodeToString(authKey)},
		"vapid":    map[string]string{"public": vPub, "private": vPriv},
	}
}

const working = `{"workspaces": [{"workspace_id": "w1", "label": "moco"}], "tabs": [], "agents": [{"pane_id": "w1:p1", "workspace_id": "w1", "agent": "claude", "agent_status": "%s", "terminal_title_stripped": "修 bug"}]}`

// 订阅之后 agent 变成「等你」就推一条；push.test 也推；推送服务说订阅没了就删掉
func TestPush(t *testing.T) {
	h := herdrtest.Start(t)
	h.SetSnapshot(snapshotOf(t, strings.Replace(working, "%s", "working", 1)))
	svc := startPushService(t)
	ts, key, priv, _ := setupWith(t, func(s *Server) {
		s.HerdrSocket = h.Path
		s.PushHTTP = svc.Client()
	}, "cat")
	c, ctx := dialWatch(t, ts, key, priv)

	var ok map[string]bool
	ask(t, ctx, c, "push.subscribe", map[string]any{"params": subscription(t, svc.URL+"/sub/1")}, &ok)
	subs, _ := config.PushSubs()
	if len(subs) != 1 || subs[0].Key != key || subs[0].Host != "phone-host-1" {
		t.Fatalf("saved: %+v", subs)
	}

	time.Sleep(herdr.Interval + 200*time.Millisecond) // 先看到 working
	h.SetSnapshot(snapshotOf(t, strings.Replace(working, "%s", "blocked", 1)))
	r := svc.wait(t, 1)
	if r.URL.Path != "/sub/1" || !strings.HasPrefix(r.Header.Get("Authorization"), "vapid t=") || r.Header.Get("TTL") != "3600" ||
		r.Header.Get("Urgency") != "high" || r.Header.Get("Content-Encoding") != "aes128gcm" {
		t.Fatalf("push request: %s %v", r.URL, r.Header)
	}

	ask(t, ctx, c, "push.test", nil, &ok)
	svc.wait(t, 2)

	svc.status.Store(http.StatusGone)
	sendRequest(ctx, c, 7, "push.test", nil)
	if rep := readReply(t, ctx, c); rep.Error == "" {
		t.Fatal("push.test succeeded against a gone subscription")
	}
	if subs, _ := config.PushSubs(); len(subs) != 0 {
		t.Fatalf("gone subscription kept: %+v", subs)
	}
}

func TestPushRejectsBadSubscriptions(t *testing.T) {
	ts, key, priv, _ := setupCmd(t, "cat")
	c, ctx := dialWatch(t, ts, key, priv)
	for i, endpoint := range []string{"http://push.example.com/x", "file:///etc/passwd", ""} {
		sendRequest(ctx, c, uint32(i+1), "push.subscribe", map[string]any{"params": subscription(t, endpoint)})
		if r := readReply(t, ctx, c); r.Error == "" {
			t.Errorf("accepted endpoint %q", endpoint)
		}
	}
	if subs, _ := config.PushSubs(); len(subs) != 0 {
		t.Fatalf("saved: %+v", subs)
	}
}

func TestAgentEvents(t *testing.T) {
	s := &Server{}
	s.Cfg.Name = "mac"
	last := map[string]string{}
	st := func(status string) *herdr.State {
		return &herdr.State{
			Workspaces: []herdr.Workspace{{ID: "w1", Label: "moco"}},
			Agents:     []herdr.Agent{{Pane: "w1:p1", Workspace: "w1", Name: "claude", Status: status, Title: "修 bug"}},
		}
	}
	if ev := s.agentEvents(last, st("done")); len(ev) != 0 {
		t.Fatalf("first sight pushed: %+v", ev)
	}
	s.agentEvents(last, st("working"))
	ev := s.agentEvents(last, st("blocked"))
	if len(ev) != 1 || ev[0].Title != "claude 在等你" || ev[0].Body != "mac · moco · 修 bug" || ev[0].Pane != "w1:p1" {
		t.Fatalf("blocked: %+v", ev)
	}
	if ev := s.agentEvents(last, st("blocked")); len(ev) != 0 {
		t.Fatalf("pushed twice: %+v", ev)
	}
	if ev := s.agentEvents(last, st("done")); len(ev) != 1 || ev[0].Title != "claude 干完了" {
		t.Fatalf("done: %+v", ev)
	}
	if ev := s.agentEvents(last, st("idle")); len(ev) != 0 {
		t.Fatalf("idle pushed: %+v", ev)
	}
}
