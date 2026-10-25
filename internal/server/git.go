package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/term"
)

const (
	gitTimeout  = 10 * time.Second
	maxDiff     = 2 << 20
	maxFile     = 1 << 20
	binarySniff = 8000 // 和 git 判断二进制的长度一样
)

var revPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_./~^@{}-]*$`)

type request struct {
	ID        uint32 `json:"id"`
	Op        string `json:"op"`
	Repo      string `json:"repo"`
	Path      string `json:"path"`
	Rev       string `json:"rev"`
	Staged    bool   `json:"staged"`
	Untracked bool   `json:"untracked"`
	N         int    `json:"n"`
	Skip      int    `json:"skip"`
}

type reply struct {
	Type  string `json:"type"`
	ID    uint32 `json:"id"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

// answer 另起 goroutine 回答，慢的 git 命令不挡读循环，也不挡别的回答
func (s *Server) answer(ctx context.Context, c *websocket.Conn, data []byte) {
	go func() {
		var req request
		err := json.Unmarshal(data[1:], &req)
		var res any
		if err == nil {
			rctx, cancel := context.WithTimeout(ctx, gitTimeout)
			res, err = handle(rctx, req)
			cancel()
		}
		r := reply{Type: "reply", ID: req.ID, Data: res}
		if err != nil {
			r = reply{Type: "reply", ID: req.ID, Error: err.Error()}
			s.Log.Warn("request failed", "op", req.Op, "repo", req.Repo, "path", req.Path, "rev", req.Rev, "err", err)
		}
		wsjson.Write(ctx, c, r)
	}()
}

func handle(ctx context.Context, req request) (any, error) {
	if req.Op == "repos" {
		return listRepos(ctx), nil
	}
	op, ok := ops[req.Op]
	if !ok {
		return nil, fmt.Errorf("unknown op %q", req.Op)
	}
	repo, err := checkRepo(ctx, req.Repo)
	if err != nil {
		return nil, err
	}
	if req.Path, err = cleanPath(req.Path); err != nil {
		return nil, err
	}
	if req.Rev != "" && !revPattern.MatchString(req.Rev) {
		return nil, fmt.Errorf("bad rev %q", req.Rev)
	}
	return op(ctx, repo, req)
}

var ops = map[string]func(context.Context, string, request) (any, error){
	"status": gitStatus,
	"diff":   gitDiff,
	"log":    gitLog,
	"commit": gitCommit,
	"tree":   gitTree,
	"file":   gitFile,
}

// git 只跑只读的子命令。GIT_OPTIONAL_LOCKS=0：status 不去拿 index.lock，免得和正在这个仓库里干活的 agent 抢；
// GIT_LITERAL_PATHSPECS=1：路径按字面算，不认 ":(top)" 这类写法
func gitCmd(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-pager", "-c", "core.quotepath=off"}, args...)...)
	cmd.Dir = dir
	env := slices.DeleteFunc(os.Environ(), func(kv string) bool {
		k, _, _ := strings.Cut(kv, "=")
		return k == "GIT_DIR" || k == "GIT_WORK_TREE" || k == "GIT_INDEX_FILE"
	})
	cmd.Env = append(env, "GIT_OPTIONAL_LOCKS=0", "GIT_LITERAL_PATHSPECS=1", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	return cmd
}

func git(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, _, err := gitCapped(ctx, dir, -1, args...)
	return out, err
}

// gitCapped 最多读 limit 字节（-1 不限），超出就停下 git，截到最后一个整行
func gitCapped(ctx context.Context, dir string, limit int, args ...string) ([]byte, bool, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := gitCmd(ctx, dir, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	if err := cmd.Start(); err != nil {
		return nil, false, err
	}
	var r io.Reader = pipe
	if limit >= 0 {
		r = io.LimitReader(pipe, int64(limit)+1)
	}
	out, rerr := io.ReadAll(r)
	if limit >= 0 && len(out) > limit {
		cancel()
		cmd.Wait()
		out = out[:limit]
		if i := bytes.LastIndexByte(out, '\n'); i >= 0 {
			out = out[:i+1]
		}
		return out, true, nil
	}
	err = cmd.Wait()
	if err == nil {
		err = rerr
	}
	if err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			err = &gitError{err: err, msg: msg}
		}
	}
	return out, false, err
}

type gitError struct {
	err error
	msg string
}

func (e *gitError) Error() string { return e.msg }
func (e *gitError) Unwrap() error { return e.err }

func exitCode(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// checkRepo 要求 repo 是绝对路径、就是工作区的顶层；返回解开符号链接后的路径
func checkRepo(ctx context.Context, repo string) (string, error) {
	if !filepath.IsAbs(repo) {
		return "", fmt.Errorf("repo must be an absolute path: %q", repo)
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(repo))
	if err != nil {
		return "", err
	}
	if fi, err := os.Stat(real); err != nil {
		return "", err
	} else if !fi.IsDir() {
		return "", fmt.Errorf("not a directory: %s", repo)
	}
	top, err := toplevel(ctx, real)
	if err != nil {
		return "", err
	}
	if top != real {
		return "", fmt.Errorf("not a repository top level: %s", repo)
	}
	return real, nil
}

func toplevel(ctx context.Context, dir string) (string, error) {
	out, err := git(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(strings.TrimSpace(string(out)))
}

// cleanPath 只收仓库里的相对路径；"" 是仓库根
func cleanPath(p string) (string, error) {
	if p == "" {
		return "", nil
	}
	if filepath.IsAbs(p) || strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("bad path %q", p)
	}
	c := filepath.Clean(p)
	if c == "." {
		return "", nil
	}
	for _, part := range strings.Split(c, "/") {
		if part == ".." || part == ".git" {
			return "", fmt.Errorf("bad path %q", p)
		}
	}
	return c, nil
}

// onDisk 是工作区里的这个路径解开符号链接后的位置，不许跑出仓库
func onDisk(repo, path string) (string, error) {
	real, err := filepath.EvalSymlinks(filepath.Join(repo, path))
	if err != nil {
		return "", err
	}
	if real != repo && !strings.HasPrefix(real, repo+"/") {
		return "", fmt.Errorf("path %q is outside the repository", path)
	}
	return real, nil
}

type agentInfo struct {
	Agent  string `json:"agent"`
	Status string `json:"status"`
	Cwd    string `json:"cwd"`
}

type repoInfo struct {
	Path   string      `json:"path"`
	Name   string      `json:"name"`
	Branch string      `json:"branch"`
	Agents []agentInfo `json:"agents"`
}

// herdrAgentList 经登录 shell 跑：mocod 的 PATH 里不一定有 ~/.local/bin。测试里换掉
var herdrAgentList = func(ctx context.Context) ([]byte, error) {
	cmd := exec.CommandContext(ctx, term.Shell(), "-lc", "herdr agent list")
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	return cmd.Output()
}

// listRepos 找 herdr 里每个 agent 所在的仓库；herdr 不在或出错就是空列表
func listRepos(ctx context.Context) map[string][]repoInfo {
	repos := []repoInfo{}
	out, err := herdrAgentList(ctx)
	var list struct {
		Result struct {
			Agents []struct {
				Agent  string `json:"agent"`
				Status string `json:"agent_status"`
				Cwd    string `json:"cwd"`
			} `json:"agents"`
		} `json:"result"`
	}
	// 登录 shell 的启动文件可能先打印别的东西
	if i := bytes.IndexByte(out, '{'); err != nil || i < 0 || json.NewDecoder(bytes.NewReader(out[i:])).Decode(&list) != nil {
		return map[string][]repoInfo{"repos": repos}
	}
	tops := map[string]string{}
	index := map[string]int{}
	for _, a := range list.Result.Agents {
		if !filepath.IsAbs(a.Cwd) {
			continue
		}
		top, ok := tops[a.Cwd]
		if !ok {
			top, _ = toplevel(ctx, a.Cwd)
			tops[a.Cwd] = top
		}
		if top == "" {
			continue
		}
		i, ok := index[top]
		if !ok {
			branch, _ := git(ctx, top, "branch", "--show-current")
			i = len(repos)
			index[top] = i
			repos = append(repos, repoInfo{Path: top, Name: filepath.Base(top), Branch: strings.TrimSpace(string(branch)), Agents: []agentInfo{}})
		}
		repos[i].Agents = append(repos[i].Agents, agentInfo{Agent: a.Agent, Status: a.Status, Cwd: a.Cwd})
	}
	return map[string][]repoInfo{"repos": repos}
}

type fileStatus struct {
	Path     string `json:"path"`
	Orig     string `json:"orig,omitempty"`
	Staged   string `json:"staged"`
	Unstaged string `json:"unstaged"`
	Kind     string `json:"kind"`
}

type statusResult struct {
	Branch string       `json:"branch"`
	Head   string       `json:"head"`
	Ahead  int          `json:"ahead"`
	Behind int          `json:"behind"`
	Files  []fileStatus `json:"files"`
}

// git status --porcelain=v2 -z：每条用 NUL 隔开，改名的那条后面再跟一条原路径
func gitStatus(ctx context.Context, repo string, _ request) (any, error) {
	out, err := git(ctx, repo, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	res := statusResult{Files: []fileStatus{}}
	recs := strings.Split(string(out), "\x00")
	for i := 0; i < len(recs); i++ {
		rec := recs[i]
		if len(rec) < 2 {
			continue
		}
		switch rec[0] {
		case '#':
			f := strings.Fields(rec)
			if len(f) < 3 {
				continue
			}
			switch f[1] {
			case "branch.head":
				if f[2] != "(detached)" {
					res.Branch = f[2]
				}
			case "branch.oid":
				if f[2] != "(initial)" {
					if short, err := git(ctx, repo, "rev-parse", "--short", f[2]); err == nil {
						res.Head = strings.TrimSpace(string(short))
					}
				}
			case "branch.ab":
				if len(f) == 4 {
					res.Ahead, _ = strconv.Atoi(strings.TrimPrefix(f[2], "+"))
					res.Behind, _ = strconv.Atoi(strings.TrimPrefix(f[3], "-"))
				}
			}
		case '1', '2', 'u':
			n := map[byte]int{'1': 9, '2': 10, 'u': 11}[rec[0]]
			f := strings.SplitN(rec, " ", n)
			if len(f) < n || len(f[1]) != 2 {
				continue
			}
			fs := fileStatus{Path: f[n-1], Staged: dot(f[1][0]), Unstaged: dot(f[1][1])}
			switch {
			case rec[0] == 'u':
				fs.Kind = "conflict"
			case rec[0] == '2':
				fs.Kind = "renamed"
				if i+1 < len(recs) {
					i++
					fs.Orig = recs[i]
				}
			case strings.ContainsRune(f[1], 'D'):
				fs.Kind = "deleted"
			case strings.ContainsRune(f[1], 'A'):
				fs.Kind = "added"
			default:
				fs.Kind = "modified"
			}
			res.Files = append(res.Files, fs)
		case '?':
			res.Files = append(res.Files, fileStatus{Path: rec[2:], Staged: "?", Unstaged: "?", Kind: "untracked"})
		}
	}
	return res, nil
}

func dot(b byte) string {
	if b == '.' {
		return " "
	}
	return string(b)
}

type diffResult struct {
	Diff      string `json:"diff"`
	Truncated bool   `json:"truncated"`
}

func gitDiff(ctx context.Context, repo string, req request) (any, error) {
	if req.Untracked {
		if req.Path == "" {
			return nil, errors.New("untracked diff needs a path")
		}
		if _, err := onDisk(repo, req.Path); err != nil {
			return nil, err
		}
		out, cut, err := gitCapped(ctx, repo, maxDiff, "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", req.Path)
		// --no-index 有差别时退出码是 1
		if err != nil && exitCode(err) != 1 {
			return nil, err
		}
		return diffResult{string(out), cut}, nil
	}
	args := []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"}
	if req.Staged {
		args = append(args, "--cached")
	}
	args = append(args, "--")
	if req.Path != "" {
		args = append(args, req.Path)
	}
	out, cut, err := gitCapped(ctx, repo, maxDiff, args...)
	if err != nil {
		return nil, err
	}
	return diffResult{string(out), cut}, nil
}

type commitInfo struct {
	Sha     string `json:"sha"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Time    int64  `json:"time"`
	Subject string `json:"subject"`
}

const commitFormat = "--format=%H%x00%h%x00%an%x00%at%x00%s"

func parseCommit(f []string) commitInfo {
	t, _ := strconv.ParseInt(f[3], 10, 64)
	return commitInfo{Sha: f[0], Short: f[1], Author: f[2], Time: t, Subject: f[4]}
}

func gitLog(ctx context.Context, repo string, req request) (any, error) {
	n := req.N
	if n <= 0 {
		n = 50
	}
	n = min(n, 200)
	args := []string{"log", commitFormat, "-n", strconv.Itoa(n), "--skip", strconv.Itoa(max(req.Skip, 0)), "--"}
	if req.Path != "" {
		args = append(args, req.Path)
	}
	commits := []commitInfo{}
	out, err := git(ctx, repo, args...)
	if err != nil {
		// 还没有提交
		if _, herr := git(ctx, repo, "rev-parse", "--verify", "-q", "HEAD"); herr != nil {
			return map[string][]commitInfo{"commits": commits}, nil
		}
		return nil, err
	}
	for line := range strings.Lines(string(out)) {
		if f := strings.Split(strings.TrimSuffix(line, "\n"), "\x00"); len(f) == 5 {
			commits = append(commits, parseCommit(f))
		}
	}
	return map[string][]commitInfo{"commits": commits}, nil
}

type commitResult struct {
	commitInfo
	Body      string `json:"body"`
	Diff      string `json:"diff"`
	Truncated bool   `json:"truncated"`
}

func gitCommit(ctx context.Context, repo string, req request) (any, error) {
	if req.Rev == "" {
		return nil, errors.New("commit needs a rev")
	}
	out, cut, err := gitCapped(ctx, repo, maxDiff, "show", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--diff-merges=first-parent",
		commitFormat+"%x00%b%x00", req.Rev, "--")
	if err != nil {
		return nil, err
	}
	f := strings.SplitN(string(out), "\x00", 7)
	if len(f) < 7 {
		return nil, errors.New("commit message too large")
	}
	return commitResult{
		commitInfo: parseCommit(f),
		Body:       strings.TrimRight(f[5], "\n "),
		Diff:       strings.TrimLeft(f[6], "\n"),
		Truncated:  cut,
	}, nil
}

type treeEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Size *int64 `json:"size,omitempty"`
}

func gitTree(ctx context.Context, repo string, req request) (any, error) {
	var entries []treeEntry
	var err error
	if req.Rev == "" {
		entries, err = diskTree(repo, req.Path)
	} else {
		entries, err = revTree(ctx, repo, req.Rev, req.Path)
	}
	if err != nil {
		return nil, err
	}
	slices.SortFunc(entries, func(a, b treeEntry) int {
		if (a.Type == "dir") != (b.Type == "dir") {
			if a.Type == "dir" {
				return -1
			}
			return 1
		}
		return cmp.Compare(a.Name, b.Name)
	})
	return map[string][]treeEntry{"entries": entries}, nil
}

func diskTree(repo, path string) ([]treeEntry, error) {
	dir, err := onDisk(repo, path)
	if err != nil {
		return nil, err
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := []treeEntry{}
	for _, de := range des {
		if de.Name() == ".git" {
			continue
		}
		full := filepath.Join(dir, de.Name())
		fi, err := os.Stat(full)
		if err != nil {
			if fi, err = os.Lstat(full); err != nil {
				continue
			}
		}
		e := treeEntry{Name: de.Name(), Type: "file"}
		if fi.IsDir() {
			e.Type = "dir"
			if _, err := os.Lstat(filepath.Join(full, ".git")); err == nil {
				e.Type = "submodule"
			}
		} else {
			size := fi.Size()
			e.Size = &size
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// lsTree 解析 git ls-tree -z --long：<mode> <type> <object> <size>\t<path>
func lsTree(ctx context.Context, repo, rev string, paths ...string) ([]treeEntry, error) {
	out, err := git(ctx, repo, append([]string{"ls-tree", "-z", "--long", rev, "--"}, paths...)...)
	if err != nil {
		return nil, err
	}
	entries := []treeEntry{}
	for rec := range strings.SplitSeq(string(out), "\x00") {
		meta, name, ok := strings.Cut(rec, "\t")
		f := strings.Fields(meta)
		if !ok || len(f) != 4 {
			continue
		}
		e := treeEntry{Name: filepath.Base(name)}
		switch f[1] {
		case "tree":
			e.Type = "dir"
		case "commit":
			e.Type = "submodule"
		default:
			e.Type = "file"
			size, _ := strconv.ParseInt(f[3], 10, 64)
			e.Size = &size
		}
		entries = append(entries, e)
	}
	return entries, nil
}

func revTree(ctx context.Context, repo, rev, path string) ([]treeEntry, error) {
	if path == "" {
		return lsTree(ctx, repo, rev)
	}
	entries, err := lsTree(ctx, repo, rev, path+"/")
	if err == nil && len(entries) == 0 {
		return nil, fmt.Errorf("no directory %q at %s", path, rev)
	}
	return entries, err
}

type fileResult struct {
	Content  *string `json:"content,omitempty"`
	Binary   bool    `json:"binary,omitempty"`
	TooLarge bool    `json:"tooLarge,omitempty"`
	Size     int64   `json:"size"`
}

func gitFile(ctx context.Context, repo string, req request) (any, error) {
	if req.Path == "" {
		return nil, errors.New("file needs a path")
	}
	var size int64
	var read func() ([]byte, error)
	if req.Rev == "" {
		full, err := onDisk(repo, req.Path)
		if err != nil {
			return nil, err
		}
		fi, err := os.Stat(full)
		if err != nil {
			return nil, err
		}
		if !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("not a file: %s", req.Path)
		}
		size = fi.Size()
		read = func() ([]byte, error) { return os.ReadFile(full) }
	} else {
		entries, err := lsTree(ctx, repo, req.Rev, req.Path)
		if err != nil {
			return nil, err
		}
		if len(entries) != 1 || entries[0].Size == nil {
			return nil, fmt.Errorf("no file %q at %s", req.Path, req.Rev)
		}
		size = *entries[0].Size
		read = func() ([]byte, error) { return git(ctx, repo, "show", req.Rev+":"+req.Path) }
	}
	if size > maxFile {
		return fileResult{TooLarge: true, Size: size}, nil
	}
	data, err := read()
	if err != nil {
		return nil, err
	}
	if bytes.IndexByte(data[:min(len(data), binarySniff)], 0) >= 0 {
		return fileResult{Binary: true, Size: int64(len(data))}, nil
	}
	content := string(data)
	return fileResult{Content: &content, Size: int64(len(data))}, nil
}
