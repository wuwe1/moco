package herdr_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/wuwe1/moco/internal/herdr"
	"github.com/wuwe1/moco/internal/herdr/herdrtest"
)

func snapshot(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

const twoTabs = `{
	"focused_workspace_id": "w1", "focused_tab_id": "w1:t2", "focused_pane_id": "w1:p2",
	"workspaces": [{"workspace_id": "w1", "label": "moco", "number": 1, "agent_status": "blocked", "focused": true}],
	"tabs": [
		{"tab_id": "w1:t1", "workspace_id": "w1", "label": "1", "number": 1, "agent_status": "done", "focused": false, "pane_count": 1},
		{"tab_id": "w1:t2", "workspace_id": "w1", "label": "api", "number": 2, "agent_status": "blocked", "focused": true, "pane_count": 2}
	],
	"layouts": [{"tab_id": "w1:t2", "zoomed": true}],
	"agents": [
		{"pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1", "agent": "pi", "agent_status": "done", "terminal_title_stripped": "π - moco", "cwd": "/r/moco", "focused": false},
		{"pane_id": "w1:p2", "tab_id": "w1:t2", "workspace_id": "w1", "agent": "claude", "name": "reviewer", "agent_status": "blocked", "cwd": "/r/moco", "focused": true}
	],
	"panes": []
}`

func TestSnapshot(t *testing.T) {
	f := herdrtest.Start(t)
	f.SetSnapshot(snapshot(t, twoTabs))
	st, err := herdr.Client{Path: f.Path}.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Tab != "w1:t2" || st.Pane != "w1:p2" || len(st.Tabs) != 2 || !st.Tabs[1].Zoomed || st.Tabs[0].Zoomed || st.Tabs[1].Panes != 2 {
		t.Errorf("tabs: %+v", st)
	}
	if st.Workspaces[0] != (herdr.Workspace{ID: "w1", Label: "moco", Number: 1, Status: "blocked", Focused: true}) {
		t.Errorf("workspace: %+v", st.Workspaces[0])
	}
	if st.Agents[0].Name != "pi" || st.Agents[0].Title != "π - moco" || st.Agents[1].Name != "reviewer" || st.Agents[1].Status != "blocked" {
		t.Errorf("agents: %+v", st.Agents)
	}
}

func TestCallError(t *testing.T) {
	_, err := herdr.Client{Path: "/nonexistent/h.sock"}.Call(context.Background(), "session.snapshot", nil)
	if err == nil {
		t.Fatal("no error without herdr")
	}
	var he *herdr.Error
	if errors.As(err, &he) {
		t.Fatalf("dial error reported as herdr error: %v", err)
	}
}

func wait(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * herdr.Interval):
		t.Fatal("no notification")
	}
}

// 有人听才问；变了才通知；herdr 不在时状态是 nil
func TestWatcher(t *testing.T) {
	f := herdrtest.Start(t)
	f.SetSnapshot(snapshot(t, twoTabs))
	w := herdr.NewWatcher(herdr.Client{Path: f.Path})
	ch, stop := w.Subscribe()
	wait(t, ch)
	if st := w.State(); st == nil || st.Tab != "w1:t2" {
		t.Fatalf("state: %+v", st)
	}
	select {
	case <-ch:
		t.Fatal("notified without a change")
	case <-time.After(herdr.Interval + 300*time.Millisecond):
	}
	f.SetSnapshot(snapshot(t, `{"focused_tab_id": "w1:t1", "workspaces": [], "tabs": [], "agents": []}`))
	wait(t, ch)
	if st := w.State(); st.Tab != "w1:t1" {
		t.Fatalf("state after change: %+v", st)
	}
	// 后来的人马上拿到一次
	ch2, stop2 := w.Subscribe()
	wait(t, ch2)
	stop()
	stop2()

	gone := herdr.NewWatcher(herdr.Client{Path: f.Path + ".missing"})
	ch3, stop3 := gone.Subscribe()
	defer stop3()
	wait(t, ch3)
	if gone.State() != nil {
		t.Fatal("state without herdr")
	}
}
