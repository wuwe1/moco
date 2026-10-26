// Package herdr 经 herdr 的 socket 问它的状态（workspace、tab、各个 agent 在干什么）、替手机切 tab。
// socket 上每行一个 JSON：发 {id, method, params}，回 {id, result} 或 {id, error:{code, message}}
package herdr

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SocketPath：herdr 设在面板里的 HERDR_SOCKET_PATH，否则默认会话的位置
func SocketPath() string {
	if p := os.Getenv("HERDR_SOCKET_PATH"); p != "" {
		return p
	}
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "herdr", "herdr.sock")
}

type Client struct{ Path string }

type Error struct{ Code, Message string }

func (e *Error) Error() string { return "herdr: " + e.Code + ": " + e.Message }

const maxReply = 16 << 20

func (c Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if params == nil {
		params = struct{}{}
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.Path)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	req, err := json.Marshal(map[string]any{"id": "moco", "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(req, '\n')); err != nil {
		return nil, err
	}
	r := bufio.NewReaderSize(conn, 64<<10)
	var line []byte
	for {
		chunk, more, err := r.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) > maxReply {
			return nil, errors.New("herdr: reply too large")
		}
		if !more {
			break
		}
	}
	var res struct {
		Result json.RawMessage `json:"result"`
		Error  *Error          `json:"error"`
	}
	if err := json.Unmarshal(line, &res); err != nil {
		return nil, err
	}
	if res.Error != nil {
		return nil, res.Error
	}
	return res.Result, nil
}

// State 是手机要的那部分：哪些 workspace、tab，各个 agent 的状态，现在看着哪个
type State struct {
	Workspaces []Workspace `json:"workspaces"`
	Tabs       []Tab       `json:"tabs"`
	Agents     []Agent     `json:"agents"`
	Workspace  string      `json:"workspace"` // 现在看着的
	Tab        string      `json:"tab"`
	Pane       string      `json:"pane"`
}

type Workspace struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Number  int    `json:"number"`
	Status  string `json:"status"` // 里面 agent 的状态汇总：idle、working、blocked、done、unknown
	Focused bool   `json:"focused"`
}

type Tab struct {
	ID        string `json:"id"`
	Workspace string `json:"workspace"`
	Label     string `json:"label"`
	Number    int    `json:"number"`
	Status    string `json:"status"`
	Focused   bool   `json:"focused"`
	Panes     int    `json:"panes"`
	Zoomed    bool   `json:"zoomed"`
}

type Agent struct {
	Pane      string `json:"pane"`
	Tab       string `json:"tab"`
	Workspace string `json:"workspace"`
	Name      string `json:"name"` // 起了名字就是名字，否则是 claude、pi 这样的种类
	Status    string `json:"status"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd"`
	Focused   bool   `json:"focused"`
}

func (c Client) Snapshot(ctx context.Context) (*State, error) {
	raw, err := c.Call(ctx, "session.snapshot", nil)
	if err != nil {
		return nil, err
	}
	var res struct {
		Snapshot struct {
			Workspace  string `json:"focused_workspace_id"`
			Tab        string `json:"focused_tab_id"`
			Pane       string `json:"focused_pane_id"`
			Workspaces []struct {
				ID      string `json:"workspace_id"`
				Label   string `json:"label"`
				Number  int    `json:"number"`
				Status  string `json:"agent_status"`
				Focused bool   `json:"focused"`
			} `json:"workspaces"`
			Tabs []struct {
				ID        string `json:"tab_id"`
				Workspace string `json:"workspace_id"`
				Label     string `json:"label"`
				Number    int    `json:"number"`
				Status    string `json:"agent_status"`
				Focused   bool   `json:"focused"`
				Panes     int    `json:"pane_count"`
			} `json:"tabs"`
			Layouts []struct {
				Tab    string `json:"tab_id"`
				Zoomed bool   `json:"zoomed"`
			} `json:"layouts"`
			Agents []struct {
				Pane      string `json:"pane_id"`
				Tab       string `json:"tab_id"`
				Workspace string `json:"workspace_id"`
				Agent     string `json:"agent"`
				Name      string `json:"name"`
				Status    string `json:"agent_status"`
				Title     string `json:"terminal_title_stripped"`
				Cwd       string `json:"cwd"`
				Focused   bool   `json:"focused"`
			} `json:"agents"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	s := res.Snapshot
	st := &State{Workspace: s.Workspace, Tab: s.Tab, Pane: s.Pane, Workspaces: []Workspace{}, Tabs: []Tab{}, Agents: []Agent{}}
	for _, w := range s.Workspaces {
		st.Workspaces = append(st.Workspaces, Workspace(w))
	}
	zoomed := map[string]bool{}
	for _, l := range s.Layouts {
		zoomed[l.Tab] = l.Zoomed
	}
	for _, t := range s.Tabs {
		st.Tabs = append(st.Tabs, Tab{ID: t.ID, Workspace: t.Workspace, Label: t.Label, Number: t.Number, Status: t.Status, Focused: t.Focused, Panes: t.Panes, Zoomed: zoomed[t.ID]})
	}
	for _, a := range s.Agents {
		name := a.Name
		if name == "" {
			name = a.Agent
		}
		st.Agents = append(st.Agents, Agent{Pane: a.Pane, Tab: a.Tab, Workspace: a.Workspace, Name: name, Status: a.Status, Title: a.Title, Cwd: a.Cwd, Focused: a.Focused})
	}
	return st, nil
}

// Interval 是问 herdr 的间隔。agent 状态的事件只能按面板一个个订，面板随时增减，不如每秒问一次快照（本机 socket，几 KB）
const Interval = time.Second

// Watcher 有人听的时候每 Interval 问一次快照，变了就告诉每个听的人；没人听就停下
type Watcher struct {
	Client Client

	mu      sync.Mutex
	subs    map[chan struct{}]struct{}
	running bool
	polled  bool
	state   *State // nil：herdr 没开，或者问不到
	raw     []byte
}

func NewWatcher(c Client) *Watcher {
	return &Watcher{Client: c, subs: map[chan struct{}]struct{}{}}
}

// State 是最近一次问到的；nil 表示 herdr 不在
func (w *Watcher) State() *State {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.state
}

// Subscribe 返回的通道在状态变了时收到一个信号（攒着的只留一个）；已经问到过的话马上先来一个
func (w *Watcher) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	w.mu.Lock()
	w.subs[ch] = struct{}{}
	if w.polled {
		ch <- struct{}{}
	}
	start := !w.running
	w.running = true
	w.mu.Unlock()
	if start {
		go w.run()
	}
	return ch, func() {
		w.mu.Lock()
		delete(w.subs, ch)
		w.mu.Unlock()
	}
}

func (w *Watcher) run() {
	t := time.NewTicker(Interval)
	defer t.Stop()
	for {
		w.poll()
		<-t.C
		w.mu.Lock()
		if len(w.subs) == 0 {
			w.running = false
			w.polled = false
			w.mu.Unlock()
			return
		}
		w.mu.Unlock()
	}
}

func (w *Watcher) poll() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	st, err := w.Client.Snapshot(ctx)
	cancel()
	if err != nil {
		st = nil
	}
	raw, _ := json.Marshal(st)
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.polled && bytes.Equal(raw, w.raw) {
		return
	}
	w.polled, w.state, w.raw = true, st, raw
	for ch := range w.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
