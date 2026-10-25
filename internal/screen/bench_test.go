package screen

import (
	"fmt"
	"io"
	"strings"
	"testing"
)

// 模拟器吃输出有多快：herdr 输出最密时每秒几 MB，这里要吃得过
func BenchmarkWritePlainLines(b *testing.B) {
	var sb strings.Builder
	for i := range 2000 {
		fmt.Fprintf(&sb, "line %d some text to fill the row a little bit more\r\n", i)
	}
	data := []byte(sb.String())
	s := New(52, 40, Theme{}, io.Discard)
	defer s.Close()
	b.SetBytes(int64(len(data)))
	for b.Loop() {
		s.Write(data)
	}
}

// herdr 那样的输出：每个字单独定位、带真彩色、中文
func BenchmarkWriteHerdrLike(b *testing.B) {
	var sb strings.Builder
	sb.WriteString("\x1b[?2026h")
	for y := 1; y <= 40; y++ {
		for x := 1; x <= 50; x += 2 {
			fmt.Fprintf(&sb, "\x1b[%d;%dH\x1b[0;38;2;214;216;224;48;2;30;30;30m格", y, x)
		}
	}
	sb.WriteString("\x1b[?2026l")
	data := []byte(sb.String())
	s := New(52, 40, Theme{}, io.Discard)
	defer s.Close()
	b.SetBytes(int64(len(data)))
	for b.Loop() {
		s.Write(data)
	}
}

func BenchmarkFrameFullScreen(b *testing.B) {
	s := New(52, 40, Theme{}, io.Discard)
	defer s.Close()
	for b.Loop() {
		s.Write([]byte("\x1b[H\x1b[2J" + strings.Repeat("\x1b[1;38;2;1;2;3mx\x1b[m中文", 400)))
		s.Reset()
		s.Frame()
	}
}
