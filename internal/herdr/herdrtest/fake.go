// Package herdrtest 是测试用的假 herdr：在 unix socket 上按 herdr 的格式回答
package herdrtest

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type Call struct {
	Method string
	Params json.RawMessage
}

type Fake struct {
	Path string

	mu       sync.Mutex
	snapshot any
	calls    []Call
}

// Start 开一个假 herdr。socket 放在短路径下：macOS 的 unix socket 路径最长 104 字节，t.TempDir() 太长
func Start(t *testing.T) *Fake {
	t.Helper()
	dir, err := os.MkdirTemp("", "herdr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &Fake{Path: filepath.Join(dir, "h.sock")}
	l, err := net.Listen("unix", f.Path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

// SetSnapshot 换掉 session.snapshot 回答的 snapshot（herdr 的原始格式）
func (f *Fake) SetSnapshot(s any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snapshot = s
}

func (f *Fake) Calls() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Call(nil), f.calls...)
}

func (f *Fake) serve(c net.Conn) {
	defer c.Close()
	var req struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil || json.Unmarshal(line, &req) != nil {
		return
	}
	f.mu.Lock()
	var result any = map[string]string{"type": "ok"}
	switch req.Method {
	case "session.snapshot":
		result = map[string]any{"type": "session_snapshot", "snapshot": f.snapshot}
	case "agent.list":
		agents := []any{}
		if s, ok := f.snapshot.(map[string]any); ok && s["agents"] != nil {
			agents = s["agents"].([]any)
		}
		result = map[string]any{"type": "agent_list", "agents": agents}
	default:
		f.calls = append(f.calls, Call{req.Method, req.Params})
	}
	f.mu.Unlock()
	out, _ := json.Marshal(map[string]any{"id": req.ID, "result": result})
	c.Write(append(out, '\n'))
}
