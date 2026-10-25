package screen

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/vt"
)

// 手机那头：一个全新的模拟器，只吃帧
func newClient(cols, rows int) *vt.Emulator {
	c := vt.NewEmulator(cols, rows)
	go io.Copy(io.Discard, c)
	return c
}

func cellsOf(e *vt.Emulator) string {
	var b strings.Builder
	for y := range e.Height() {
		for x := range e.Width() {
			c := e.CellAt(x, y)
			fmt.Fprintf(&b, "%s/%d/%s|", c.Content, c.Width, c.Style.String())
		}
		b.WriteByte('\n')
	}
	return b.String()
}

type buf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (w *buf) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

func (w *buf) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.String()
}

func frame(t *testing.T, s *Screen) []byte {
	t.Helper()
	f, _, _, wait := s.Frame()
	if wait > 0 {
		t.Fatalf("unexpected wait %v", wait)
	}
	return f
}

// 帧喂给手机后，手机上的画面和电脑上的一格不差（字、宽度、样式），光标也在同一处
func TestFramesReproduceScreen(t *testing.T) {
	s := New(20, 6, Theme{}, io.Discard)
	defer s.Close()
	client := newClient(20, 6)
	steps := []string{
		"hello \x1b[1;31mred\x1b[m 中文 😀\r\n",
		"\x1b[3;5H\x1b[44mblue bg\x1b[m",
		"\x1b[2J\x1b[Hcleared\r\nline2 \x1b[4munder\x1b[m",
		"\x1b[6;1Hbottom row that is longer than twenty",
		"\x1b[?7l\x1b[1;19H中文", // 自动换行关掉时放不下的宽字符被丢掉
		"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
	}
	for i, step := range steps {
		s.Write([]byte(step))
		if f := frame(t, s); f != nil {
			client.Write(f)
		}
		if got, want := cellsOf(client), cellsOf(s.e); got != want {
			t.Fatalf("step %d: client differs\nclient:\n%s\nserver:\n%s", i, got, want)
		}
		if client.CursorPosition() != s.e.CursorPosition() {
			t.Fatalf("step %d: cursor %v vs %v", i, client.CursorPosition(), s.e.CursorPosition())
		}
	}
}

// 第二帧只带变了的行
func TestOnlyChangedLines(t *testing.T) {
	s := New(20, 6, Theme{}, io.Discard)
	defer s.Close()
	s.Write([]byte("a\r\nb\r\nc"))
	frame(t, s)
	s.Write([]byte("\x1b[2;1Hchanged"))
	f := string(frame(t, s))
	if !strings.Contains(f, "\x1b[2;1H") || strings.Contains(f, "\x1b[1;1H\x1b[m") || strings.Contains(f, "\x1b[3;1H") {
		t.Fatalf("frame should only rewrite row 2: %q", f)
	}
	if f := frame(t, s); f != nil {
		t.Fatalf("nothing changed, want no frame, got %q", f)
	}
}

// 程序说「一帧开始」后，等到「结束」才出帧；迟迟不结束就超时出帧
func TestWaitsForSynchronizedUpdate(t *testing.T) {
	s := New(20, 6, Theme{}, io.Discard)
	defer s.Close()
	s.Write([]byte("\x1b[?2026hhalf"))
	if f, _, _, wait := s.Frame(); f != nil || wait <= 0 {
		t.Fatalf("mid-update: frame %q wait %v", f, wait)
	}
	s.Write([]byte(" done\x1b[?2026l"))
	if f := frame(t, s); !strings.Contains(string(f), "half done") {
		t.Fatalf("after update: %q", f)
	}
	s.Write([]byte("\x1b[?2026hstuck"))
	time.Sleep(SyncTimeout + 20*time.Millisecond)
	if f, _, _, _ := s.Frame(); !strings.Contains(string(f), "stuck") {
		t.Fatalf("after timeout: %q", f)
	}
}

// 鼠标、粘贴模式这些转给手机；鼠标整组按从小到大重发
func TestForwardsModes(t *testing.T) {
	s := New(20, 6, Theme{}, io.Discard)
	defer s.Close()
	s.Write([]byte("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1049h"))
	f := string(frame(t, s))
	for _, want := range []string{"\x1b[?2004h", "\x1b[?1006h"} {
		if !strings.Contains(f, want) {
			t.Errorf("missing %q in %q", want, f)
		}
	}
	if i, j := strings.Index(f, "\x1b[?1000h"), strings.Index(f, "\x1b[?1003h"); i < 0 || j < i {
		t.Errorf("mouse modes should be set ascending: %q", f)
	}
	if strings.Contains(f, "1049") {
		t.Errorf("alternate screen must not be forwarded: %q", f)
	}
	s.Write([]byte("\x1b[?2004l"))
	if f := string(frame(t, s)); !strings.Contains(f, "\x1b[?2004l") {
		t.Errorf("missing reset: %q", f)
	}
}

// 颜色查询照手机的配色回答
func TestAnswersColorQueries(t *testing.T) {
	out := &buf{}
	s := New(20, 6, Theme{Fg: "#ebdbb2", Bg: "#282828", Palette: []string{"#282828", "#cc241d"}}, out)
	defer s.Close()
	s.Write([]byte("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]4;1;?;200;?\x1b\\"))
	deadline := time.Now().Add(time.Second)
	for !strings.Contains(out.String(), "4;200;") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	got := out.String()
	for _, want := range []string{"10;rgb:ebeb/dbdb/b2b2", "11;rgb:2828/2828/2828", "4;1;rgb:cccc/2424/1d1d", "4;200;rgb:ffff/0000/d7d7"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
}

// 改了尺寸整屏重发
func TestResizeRepaintsAll(t *testing.T) {
	s := New(20, 4, Theme{}, io.Discard)
	defer s.Close()
	s.Write([]byte("a\r\nb\r\nc\r\nd"))
	frame(t, s)
	s.Resize(10, 3)
	f, cols, rows, _ := s.Frame()
	if cols != 10 || rows != 3 {
		t.Fatalf("size %dx%d", cols, rows)
	}
	for y := 1; y <= 3; y++ {
		if !strings.Contains(string(f), fmt.Sprintf("\x1b[%d;1H", y)) {
			t.Errorf("row %d not repainted: %q", y, f)
		}
	}
}
