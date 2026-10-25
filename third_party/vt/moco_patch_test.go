package vt

import (
	"strings"
	"testing"
)

func rowText(e *Emulator, y int) string {
	var b strings.Builder
	for x := 0; x < e.Width(); x++ {
		c := e.CellAt(x, y)
		if c.Content == "" {
			b.WriteString("·") // second half of a wide character
		} else {
			b.WriteString(c.Content)
		}
	}
	return b.String()
}

// moco patch: wide characters at the right margin behave like xterm
func TestWideCharAtRightMargin(t *testing.T) {
	for _, tc := range []struct{ name, in, row0, row1 string }{
		{"fits exactly", "01234567中x", "01234567中·", "x         "},
		{"one column left", "012345678中x", "012345678 ", "中·x       "},
		{"no autowrap drops it", "\x1b[?7l012345678中", "012345678 ", "          "},
	} {
		e := NewEmulator(10, 3)
		go func() {
			b := make([]byte, 256)
			for {
				if _, err := e.Read(b); err != nil {
					return
				}
			}
		}()
		e.WriteString(tc.in)
		if got := rowText(e, 0); got != tc.row0 {
			t.Errorf("%s: row 0 = %q, want %q", tc.name, got, tc.row0)
		}
		if got := rowText(e, 1); got != tc.row1 {
			t.Errorf("%s: row 1 = %q, want %q", tc.name, got, tc.row1)
		}
	}
}

// moco patch: writing a wide character over the first half of another one
// erases the other one whole
func TestWideCharOverWideChar(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"over first half", "ab说defg\x1b[1;2H中", "a中· defg"},
		{"over second half", "ab说defg\x1b[1;4H中", "ab 中·efg"},
		{"narrow over second half", "ab说defg\x1b[1;4HX", "ab Xdefg"},
	} {
		e := NewEmulator(8, 1)
		go func() {
			b := make([]byte, 256)
			for {
				if _, err := e.Read(b); err != nil {
					return
				}
			}
		}()
		e.WriteString(tc.in)
		if got := rowText(e, 0); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

// moco patch: narrowing the screen blanks a wide character cut at the new edge
func TestResizeCutsWideChar(t *testing.T) {
	e := NewEmulator(8, 1)
	go func() {
		b := make([]byte, 256)
		for {
			if _, err := e.Read(b); err != nil {
				return
			}
		}
	}()
	e.WriteString("abcd中ef")
	e.Resize(5, 1)
	if got := rowText(e, 0); got != "abcd " {
		t.Errorf("after resize %q, want %q", got, "abcd ")
	}
}
