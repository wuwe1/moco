// Package term 在伪终端里开命令。
package term

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
)

type Session struct {
	cmd  *exec.Cmd
	tty  *os.File
	done chan struct{}
}

// Start 经登录 shell 启动命令：launchd、systemd 给的 PATH 很短，不经 shell 找不到 herdr，herdr 再开的 pi 也找不到 node
func Start(command []string, cols, rows uint16) (*Session, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-lc", "exec "+quote(command))
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if os.Getenv("LANG") == "" {
		cmd.Env = append(cmd.Env, "LANG=en_US.UTF-8")
	}
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	// pty.Start 会给子进程开新会话（Setsid）并把伪终端设为它的控制终端
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	s := &Session{cmd: cmd, tty: tty, done: make(chan struct{})}
	go func() {
		cmd.Wait()
		close(s.done)
	}()
	return s, nil
}

func (s *Session) Read(p []byte) (int, error)  { return s.tty.Read(p) }
func (s *Session) Write(p []byte) (int, error) { return s.tty.Write(p) }

func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.tty, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *Session) Done() <-chan struct{} { return s.done }

func (s *Session) ExitCode() int {
	if s.cmd.ProcessState == nil {
		return -1
	}
	return s.cmd.ProcessState.ExitCode()
}

// Close 给整个进程组发 SIGHUP（和关掉终端窗口一样），2 秒还没退就 SIGKILL
func (s *Session) Close() {
	pgid := -s.cmd.Process.Pid
	syscall.Kill(pgid, syscall.SIGHUP)
	select {
	case <-s.done:
	case <-time.After(2 * time.Second):
		syscall.Kill(pgid, syscall.SIGKILL)
		<-s.done
	}
	s.tty.Close()
}

// quote 按 sh 的规则给每个参数加单引号
func quote(args []string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return strings.Join(q, " ")
}
