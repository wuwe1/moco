package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
)

type rawReply struct {
	Type  string          `json:"type"`
	ID    uint32          `json:"id"`
	Data  json.RawMessage `json:"data"`
	Error string          `json:"error"`
}

func sendRequest(ctx context.Context, c *websocket.Conn, id uint32, op string, params map[string]any) {
	req := map[string]any{"id": id, "op": op}
	for k, v := range params {
		req[k] = v
	}
	body, _ := json.Marshal(req)
	c.Write(ctx, websocket.MessageBinary, append([]byte{msgRequest}, body...))
}

func readReply(t *testing.T, ctx context.Context, c *websocket.Conn) rawReply {
	t.Helper()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ == websocket.MessageBinary {
			if len(data) >= 9 && data[0] == msgFrame {
				ack(ctx, c, binary.BigEndian.Uint32(data[1:]))
			}
			continue
		}
		var r rawReply
		if json.Unmarshal(data, &r) == nil && r.Type == "reply" {
			return r
		}
	}
}

// ask 问一次，把 data 解进 out；回答是错误就让测试失败
func ask(t *testing.T, ctx context.Context, c *websocket.Conn, op string, params map[string]any, out any) {
	t.Helper()
	sendRequest(ctx, c, 1, op, params)
	r := readReply(t, ctx, c)
	if r.ID != 1 || r.Error != "" {
		t.Fatalf("%s %v: %+v", op, params, r)
	}
	if err := json.Unmarshal(r.Data, out); err != nil {
		t.Fatalf("%s: %v in %s", op, err, r.Data)
	}
}

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 两个提交；工作区里 a.txt 改了没暂存、staged.txt 新加已暂存、sub/b.txt 暂存改名成 sub/c.txt、new.txt 没跟踪
func gitRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	repo := t.TempDir()
	run(t, repo, "git", "init", "-q", "-b", "main")
	run(t, repo, "git", "config", "user.name", "Tester")
	run(t, repo, "git", "config", "user.email", "tester@example.com")
	write(t, filepath.Join(repo, "a.txt"), "one\ntwo\n")
	write(t, filepath.Join(repo, "sub/b.txt"), "bee\n")
	write(t, filepath.Join(repo, "bin.dat"), "PK\x00\x01\x02binary")
	run(t, repo, "git", "add", ".")
	run(t, repo, "git", "commit", "-q", "-m", "first")
	write(t, filepath.Join(repo, "sub/b.txt"), "bee\nbuzz\n")
	run(t, repo, "git", "commit", "-q", "-am", "second", "-m", "the body")

	write(t, filepath.Join(repo, "a.txt"), "one\nTWO\n")
	write(t, filepath.Join(repo, "staged.txt"), "staged line\n")
	run(t, repo, "git", "add", "staged.txt")
	run(t, repo, "git", "mv", "sub/b.txt", "sub/c.txt")
	write(t, filepath.Join(repo, "new.txt"), "untracked line\n")
	return repo
}

func TestGitRequests(t *testing.T) {
	repo := gitRepo(t)
	ts, key, priv, _ := setupCmd(t, "cat")
	c, ctx := dialFrames(t, ts, key, priv)
	in := func(kv ...any) map[string]any {
		m := map[string]any{"repo": repo}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		return m
	}

	var st statusResult
	ask(t, ctx, c, "status", in(), &st)
	if st.Branch != "main" || st.Head == "" {
		t.Fatalf("status branch %q head %q", st.Branch, st.Head)
	}
	kinds := map[string]fileStatus{}
	for _, f := range st.Files {
		kinds[f.Path] = f
	}
	want := map[string]fileStatus{
		"a.txt":      {Path: "a.txt", Staged: " ", Unstaged: "M", Kind: "modified"},
		"staged.txt": {Path: "staged.txt", Staged: "A", Unstaged: " ", Kind: "added"},
		"sub/c.txt":  {Path: "sub/c.txt", Orig: "sub/b.txt", Staged: "R", Unstaged: " ", Kind: "renamed"},
		"new.txt":    {Path: "new.txt", Staged: "?", Unstaged: "?", Kind: "untracked"},
	}
	if len(kinds) != len(want) {
		t.Fatalf("status files %+v", st.Files)
	}
	for p, w := range want {
		if kinds[p] != w {
			t.Errorf("status %s = %+v, want %+v", p, kinds[p], w)
		}
	}

	var d diffResult
	ask(t, ctx, c, "diff", in("path", "a.txt"), &d)
	if !strings.Contains(d.Diff, "+TWO\n") || !strings.Contains(d.Diff, "-two\n") || d.Truncated {
		t.Errorf("diff a.txt: %+v", d)
	}
	ask(t, ctx, c, "diff", in("staged", true), &d)
	if !strings.Contains(d.Diff, "+staged line") || !strings.Contains(d.Diff, "rename to sub/c.txt") || strings.Contains(d.Diff, "TWO") {
		t.Errorf("staged diff: %s", d.Diff)
	}
	ask(t, ctx, c, "diff", in("path", "new.txt", "untracked", true), &d)
	if !strings.Contains(d.Diff, "+untracked line") {
		t.Errorf("untracked diff: %s", d.Diff)
	}

	var log struct{ Commits []commitInfo }
	ask(t, ctx, c, "log", in(), &log)
	if len(log.Commits) != 2 || log.Commits[0].Subject != "second" || log.Commits[1].Subject != "first" {
		t.Fatalf("log: %+v", log.Commits)
	}
	head := log.Commits[0]
	if len(head.Sha) != 40 || !strings.HasPrefix(head.Sha, head.Short) || head.Author != "Tester" || head.Time == 0 {
		t.Errorf("log head: %+v", head)
	}
	ask(t, ctx, c, "log", in("n", 1, "skip", 1), &log)
	if len(log.Commits) != 1 || log.Commits[0].Subject != "first" {
		t.Errorf("log skip: %+v", log.Commits)
	}

	var cm commitResult
	ask(t, ctx, c, "commit", in("rev", "HEAD"), &cm)
	if cm.Sha != head.Sha || cm.Subject != "second" || cm.Body != "the body" || !strings.HasPrefix(cm.Diff, "diff --git a/sub/b.txt") || !strings.Contains(cm.Diff, "+buzz") {
		t.Errorf("commit: %+v", cm)
	}

	var tr struct{ Entries []treeEntry }
	names := func() []string {
		var n []string
		for _, e := range tr.Entries {
			n = append(n, e.Name+":"+e.Type)
		}
		return n
	}
	ask(t, ctx, c, "tree", in("rev", "HEAD"), &tr)
	if got := names(); !slices.Equal(got, []string{"sub:dir", "a.txt:file", "bin.dat:file"}) {
		t.Errorf("tree HEAD: %v", got)
	}
	if tr.Entries[1].Size == nil || *tr.Entries[1].Size != 8 {
		t.Errorf("tree HEAD a.txt size: %+v", tr.Entries[1])
	}
	ask(t, ctx, c, "tree", in("rev", "HEAD", "path", "sub"), &tr)
	if got := names(); !slices.Equal(got, []string{"b.txt:file"}) {
		t.Errorf("tree HEAD sub: %v", got)
	}
	ask(t, ctx, c, "tree", in(), &tr)
	if got := names(); !slices.Equal(got, []string{"sub:dir", "a.txt:file", "bin.dat:file", "new.txt:file", "staged.txt:file"}) {
		t.Errorf("tree working: %v", got)
	}

	var f fileResult
	ask(t, ctx, c, "file", in("rev", "HEAD", "path", "a.txt"), &f)
	if f.Content == nil || *f.Content != "one\ntwo\n" || f.Size != 8 {
		t.Errorf("file HEAD: %+v", f)
	}
	ask(t, ctx, c, "file", in("path", "a.txt"), &f)
	if f.Content == nil || *f.Content != "one\nTWO\n" {
		t.Errorf("file working: %+v", f)
	}
	f = fileResult{}
	ask(t, ctx, c, "file", in("rev", "HEAD", "path", "bin.dat"), &f)
	if !f.Binary || f.Content != nil || f.Size != 11 {
		t.Errorf("file binary: %+v", f)
	}
	write(t, filepath.Join(repo, "big.txt"), strings.Repeat("x", maxFile+1))
	f = fileResult{}
	ask(t, ctx, c, "file", in("path", "big.txt"), &f)
	if !f.TooLarge || f.Content != nil || f.Size != maxFile+1 {
		t.Errorf("file too large: %+v", f)
	}
	write(t, filepath.Join(repo, "huge.txt"), strings.Repeat("line\n", 600000))
	ask(t, ctx, c, "diff", in("path", "huge.txt", "untracked", true), &d)
	if !d.Truncated || len(d.Diff) > maxDiff || !strings.HasSuffix(d.Diff, "+line\n") {
		t.Errorf("huge diff: truncated=%v %d bytes", d.Truncated, len(d.Diff))
	}

	// 这些都该被拒绝：同时发出去，回答不按顺序回来
	outside := t.TempDir()
	write(t, filepath.Join(outside, "secret"), "secret\n")
	os.Symlink(outside, filepath.Join(repo, "link"))
	bad := map[uint32]struct {
		op     string
		params map[string]any
	}{
		10: {"file", in("path", "../x")},
		11: {"file", in("path", "/etc/passwd")},
		12: {"commit", in("rev", "--output="+filepath.Join(outside, "x"))},
		13: {"file", in("rev", "--output="+filepath.Join(outside, "x"), "path", "a.txt")},
		14: {"status", map[string]any{"repo": filepath.Join(repo, "sub")}},
		15: {"rm", in()},
		16: {"file", in("path", "link/secret")},
		17: {"tree", in("path", "link")},
		18: {"status", map[string]any{"repo": "relative/repo"}},
		19: {"diff", in("path", "sub/../../x")},
		20: {"file", in("path", ".git/config")},
	}
	for id, b := range bad {
		sendRequest(ctx, c, id, b.op, b.params)
	}
	for len(bad) > 0 {
		r := readReply(t, ctx, c)
		b, ok := bad[r.ID]
		if !ok {
			t.Fatalf("unexpected reply %+v", r)
		}
		if r.Error == "" || r.Data != nil {
			t.Errorf("%d %s %v accepted: %s", r.ID, b.op, b.params, r.Data)
		}
		t.Logf("%d %s rejected: %s", r.ID, b.op, r.Error)
		delete(bad, r.ID)
	}
	if _, err := os.Stat(filepath.Join(outside, "x")); err == nil {
		t.Error("--output wrote a file")
	}
}

func TestGitRepos(t *testing.T) {
	repo := gitRepo(t)
	notRepo := t.TempDir()
	agents, _ := json.Marshal(map[string]any{"result": map[string]any{"agents": []map[string]any{
		{"agent": "claude", "agent_status": "working", "cwd": repo},
		{"agent": "pi", "agent_status": "done", "cwd": filepath.Join(repo, "sub")},
		{"agent": "codex", "agent_status": "idle", "cwd": notRepo},
		{"agent": "pi", "agent_status": "idle", "cwd": ""},
	}}})
	out := append([]byte("motd from .zprofile\n"), agents...)
	var canned atomic.Pointer[[]byte]
	canned.Store(&out)
	old := herdrAgentList
	herdrAgentList = func(context.Context) ([]byte, error) {
		if p := canned.Load(); p != nil {
			return *p, nil
		}
		return nil, exec.ErrNotFound
	}
	t.Cleanup(func() { herdrAgentList = old })

	ts, key, priv, _ := setupCmd(t, "cat")
	c, ctx := dialFrames(t, ts, key, priv)
	var res struct{ Repos []repoInfo }
	ask(t, ctx, c, "repos", nil, &res)
	real, _ := filepath.EvalSymlinks(repo)
	if len(res.Repos) != 1 {
		t.Fatalf("repos: %+v", res.Repos)
	}
	r := res.Repos[0]
	if r.Path != real || r.Name != filepath.Base(real) || r.Branch != "main" {
		t.Errorf("repo: %+v", r)
	}
	wantAgents := []agentInfo{
		{Agent: "claude", Status: "working", Cwd: repo},
		{Agent: "pi", Status: "done", Cwd: filepath.Join(repo, "sub")},
	}
	if !slices.Equal(r.Agents, wantAgents) {
		t.Errorf("agents: %+v", r.Agents)
	}

	// 没装 herdr：空列表，不是错误
	canned.Store(nil)
	res.Repos = nil
	ask(t, ctx, c, "repos", nil, &res)
	if res.Repos == nil || len(res.Repos) != 0 {
		t.Errorf("repos without herdr: %+v", res.Repos)
	}
}
