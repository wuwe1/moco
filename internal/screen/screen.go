// Package screen 在电脑上维护终端画面，只把「现在是什么样」发给手机（mosh 的思路）：
// 程序的输出在这里全速被一个终端模拟器（third_party/vt）吃掉，手机收得慢也不会把程序堵住；
// 出帧时只发和上一帧比变了的行，中间那些手机来不及看的样子直接跳过。
//
// 帧本身仍是控制序列，手机上的 xterm.js 照常执行：每行从行首定位、整行重写，
// 再带上光标和变了的模式开关（鼠标上报、粘贴模式等，手机按它们给输入编码）。
package screen

import (
	"bytes"
	"fmt"
	"image/color"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

// SyncTimeout：程序说了「一帧开始」（?2026h）却迟迟不说结束时，最多等这么久就照样出帧
const SyncTimeout = 150 * time.Millisecond

// 转给手机的模式：手机上的 xterm.js 要按它们给按键、鼠标、粘贴编码
var forwarded = []int{
	1,    // 光标键用应用模式
	66,   // 小键盘用应用模式
	1004, // 焦点进出通知
	2004, // 粘贴时加标记
}

// 鼠标上报和编码各是一组：xterm.js 以最后打开的为准，关掉其中一个就全关，所以整组一起重发
var (
	mouseTracking = []int{9, 1000, 1002, 1003}
	mouseEncoding = []int{1005, 1006, 1015, 1016}
)

// Theme 是手机上的配色，用来回答程序对颜色的查询（OSC 10/11/4），和手机直接连时回答的一样
type Theme struct {
	Fg      string   `json:"fg"`
	Bg      string   `json:"bg"`
	Palette []string `json:"palette"` // 前 16 色，#rrggbb
}

type Screen struct {
	mu        sync.Mutex
	e         *vt.Emulator
	modes     map[int]bool
	syncSince time.Time // 正处在程序的一帧当中（?2026h 之后）
	dirty     bool
	palette   [256]color.Color

	// 上一帧发出去时手机上的样子
	sentCols, sentRows int
	sentLines          []string
	sentModes          map[int]bool
	sentCursor         uv.Position
	sentHidden         bool
	sentStyle          string
	sentAny            bool
	sentImages         map[uint32]bool

	cursorByProgram bool // 程序设过光标样式（CSI Ps SP q，Ps 不是 0）

	k *kitty // 图片（kitty 图形协议）

	cellW, cellH int // 手机上一格多少 CSS 像素；0 表示不知道
}

// Frame 是一帧：文字部分是控制序列，图片单独带（手机上的 xterm.js 不认 kitty 协议）
type Frame struct {
	Data       []byte // 控制序列；只有图变了时为空
	Cols, Rows int
	Forget     []uint32    // 手机该丢掉的图（删了，或同一个编号换了内容）
	Images     []*Image    // 放置里用到、手机还没有的图
	Placements []Placement // 现在所有的放置，从下往上；nil 表示没变
}

// New 建一块屏幕；模拟器对查询的回答（光标位置、颜色等）写进 respond，也就是程序的输入
func New(cols, rows int, theme Theme, respond io.Writer) *Screen {
	s := &Screen{e: vt.NewEmulator(cols, rows), modes: map[int]bool{}, sentModes: map[int]bool{}, sentImages: map[uint32]bool{}, k: newKitty()}
	s.e.SetScrollbackSize(0)
	s.setTheme(theme)
	s.e.SetCallbacks(vt.Callbacks{
		EnableMode:  func(m ansi.Mode) { s.mode(m, true) },
		DisableMode: func(m ansi.Mode) { s.mode(m, false) },
	})
	s.e.RegisterOscHandler(4, s.oscPalette)
	s.e.RegisterApcHandler(func(data []byte) bool { return s.k.handle(data, s.e.CursorPosition()) })
	s.e.RegisterCsiHandler('t', s.windowOps)
	s.e.RegisterCsiHandler(ansi.Command(0, ' ', 'q'), s.cursorStyleSet)
	go io.Copy(respond, s.e)
	return s
}

// SetTheme 换配色：手机上改了主题，之后的颜色查询按新的回答
func (s *Screen) SetTheme(t Theme) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setTheme(t)
}

// 只记下程序有没有自己设光标样式，样式本身交给模拟器（返回 false 让它接着处理）
func (s *Screen) cursorStyleSet(params ansi.Params) bool {
	n, _, _ := params.Param(0, 0)
	s.cursorByProgram = n != 0
	return false
}

func (s *Screen) setTheme(t Theme) {
	for i := range 256 {
		s.palette[i] = xtermColor(i)
	}
	for i, hex := range t.Palette {
		if c, ok := parseHex(hex); ok && i < 16 {
			s.palette[i] = c
		}
	}
	if c, ok := parseHex(t.Fg); ok {
		s.e.SetDefaultForegroundColor(c)
	}
	if c, ok := parseHex(t.Bg); ok {
		s.e.SetDefaultBackgroundColor(c)
	}
}

// OSC 4 ; 号 ; ? —— 查调色板。x/vt 不回答，照 xterm.js 的格式回答
func (s *Screen) oscPalette(data []byte) bool {
	parts := strings.Split(string(data), ";")
	for i := 1; i+1 < len(parts); i += 2 {
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 || n > 255 || parts[i+1] != "?" {
			continue
		}
		r, g, b, _ := s.palette[n].RGBA()
		fmt.Fprintf(s.e.InputPipe(), "\x1b]4;%d;rgb:%04x/%04x/%04x\x1b\\", n, r, g, b)
	}
	return true
}

func (s *Screen) mode(m ansi.Mode, on bool) {
	if _, ok := m.(ansi.DECMode); !ok {
		return
	}
	n := m.Mode()
	if n == 2026 {
		if on {
			s.syncSince = time.Now()
		} else {
			s.syncSince = time.Time{}
		}
		return
	}
	s.modes[n] = on
}

// SetCellSize 记下手机上一格的大小（CSS 像素）：程序问 CSI 16 t 时照这个回答，
// herdr 用它把图片的像素尺寸换算成占几列几行，答错了图会被拉扁
func (s *Screen) SetCellSize(w, h int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cellW, s.cellH = w, h
}

// CSI 16 t 问一格多少像素，CSI 14 t 问整个文字区多少像素（XTWINOPS）。不知道就不答，和以前一样
func (s *Screen) windowOps(params ansi.Params) bool {
	if s.cellW <= 0 || s.cellH <= 0 {
		return false
	}
	switch n, _, _ := params.Param(0, 0); n {
	case 16:
		fmt.Fprintf(s.e.InputPipe(), "\x1b[6;%d;%dt", s.cellH, s.cellW)
	case 14:
		fmt.Fprintf(s.e.InputPipe(), "\x1b[4;%d;%dt", s.cellH*s.e.Height(), s.cellW*s.e.Width())
	default:
		return false
	}
	return true
}

// Close 关掉回答的管道，转发回答的协程随之退出。
// 不调 Emulator.Close：它和 Read 读写同一个标志、没加锁（-race 会报）
func (s *Screen) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.e.InputPipe().(io.Closer); ok {
		return c.Close()
	}
	return nil
}

// Write 喂程序的输出
func (s *Screen) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dirty = true
	return s.e.Write(p)
}

func (s *Screen) Resize(cols, rows int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dirty = true
	s.e.Resize(cols, rows)
}

func (s *Screen) Size() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.e.Width(), s.e.Height()
}

// Frame 出一帧：从上一帧到现在的变化。nil 表示没有可发的；
// 这时 wait > 0 说明程序正画到一半，过 wait 再来问
func (s *Screen) Frame() (*Frame, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cols, rows := s.e.Width(), s.e.Height()
	if !s.dirty {
		return nil, 0
	}
	if !s.syncSince.IsZero() {
		if left := SyncTimeout - time.Since(s.syncSince); left > 0 {
			return nil, left
		}
	}
	s.dirty = false
	f := &Frame{Cols: cols, Rows: rows}

	var b bytes.Buffer
	b.WriteString("\x1b[?2026h") // 手机上也整帧一起显示

	full := !s.sentAny || cols != s.sentCols || rows != s.sentRows
	if full {
		s.sentLines = make([]string, rows)
		s.sentCols, s.sentRows = cols, rows
	}
	changed := s.writeModes(&b)
	for y := range rows {
		line := s.renderLine(y, cols)
		if !full && line == s.sentLines[y] {
			continue
		}
		s.sentLines[y] = line
		fmt.Fprintf(&b, "\x1b[%d;1H", y+1)
		b.WriteString(line)
		changed = true
	}

	pos := s.e.CursorPosition()
	hidden := s.e.CursorHidden()
	style := "\x1b[0 q" // 恢复成手机设置里的样式
	if s.cursorByProgram {
		style = cursorStyle(s.e.CursorStyle())
	}
	if changed || full || pos != s.sentCursor {
		fmt.Fprintf(&b, "\x1b[%d;%dH", pos.Y+1, pos.X+1)
		changed = true
	}
	if full || hidden != s.sentHidden {
		if hidden {
			b.WriteString("\x1b[?25l")
		} else {
			b.WriteString("\x1b[?25h")
		}
		changed = true
	}
	if full || style != s.sentStyle {
		b.WriteString(style)
		changed = true
	}
	s.sentCursor, s.sentHidden, s.sentStyle, s.sentAny = pos, hidden, style, true
	if changed {
		b.WriteString("\x1b[?2026l")
		f.Data = b.Bytes()
	}

	// 图：先让手机丢掉过时的，再补上缺的，最后是放置
	for _, id := range s.k.forgotten {
		if s.sentImages[id] {
			f.Forget = append(f.Forget, id)
			delete(s.sentImages, id)
		}
	}
	s.k.forgotten = nil
	if s.k.changed || full {
		s.k.changed = false
		f.Placements = s.k.list()
		for _, pl := range f.Placements {
			if !s.sentImages[pl.Image] {
				f.Images = append(f.Images, s.k.images[pl.Image])
				s.sentImages[pl.Image] = true
			}
		}
	}

	if f.Data == nil && f.Placements == nil && f.Forget == nil {
		return nil, 0
	}
	return f, 0
}

// Reset 让下一帧整屏重发（手机重连、刚打开时）
func (s *Screen) Reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sentAny = false
	s.sentModes = map[int]bool{}
	s.sentImages = map[uint32]bool{}
	s.dirty = true
}

func (s *Screen) writeModes(b *bytes.Buffer) bool {
	changed := false
	set := func(n int, on bool) {
		if on {
			fmt.Fprintf(b, "\x1b[?%dh", n)
		} else {
			fmt.Fprintf(b, "\x1b[?%dl", n)
		}
	}
	for _, n := range forwarded {
		if s.modes[n] != s.sentModes[n] {
			set(n, s.modes[n])
			s.sentModes[n] = s.modes[n]
			changed = true
		}
	}
	for _, group := range [][]int{mouseTracking, mouseEncoding} {
		same := true
		for _, n := range group {
			same = same && s.modes[n] == s.sentModes[n]
		}
		if same {
			continue
		}
		for _, n := range group {
			set(n, false)
		}
		for _, n := range group { // 从小到大打开：xterm.js 以最后一个为准，最细的那个在后面
			if s.modes[n] {
				set(n, true)
			}
			s.sentModes[n] = s.modes[n]
		}
		changed = true
	}
	return changed
}

// renderLine 把一行写成控制序列：从无样式开始，样式、链接变了才换；宽字符的后半格跳过
func (s *Screen) renderLine(y, cols int) string {
	var b strings.Builder
	b.WriteString("\x1b[m")
	var style uv.Style
	var link uv.Link
	for x := 0; x < cols; x++ {
		c := s.e.CellAt(x, y)
		if c == nil {
			c = &uv.EmptyCell
		}
		if c.Width == 0 && c.Content == "" {
			continue
		}
		if !c.Style.Equal(&style) {
			b.WriteString("\x1b[m")
			if !c.Style.IsZero() {
				b.WriteString(c.Style.String())
			}
			style = c.Style
		}
		if c.Link != link {
			fmt.Fprintf(&b, "\x1b]8;%s;%s\x1b\\", c.Link.Params, c.Link.URL)
			link = c.Link
		}
		if c.Content == "" {
			b.WriteByte(' ')
		} else {
			b.WriteString(c.Content)
		}
	}
	if link != (uv.Link{}) {
		b.WriteString("\x1b]8;;\x1b\\")
	}
	b.WriteString("\x1b[m")
	return b.String()
}

// DECSCUSR：1/2 方块，3/4 下划线，5/6 竖线；单数闪烁
func cursorStyle(st vt.CursorStyle, blink bool) string {
	n := 2
	switch st {
	case vt.CursorUnderline:
		n = 4
	case vt.CursorBar:
		n = 6
	}
	if blink {
		n--
	}
	return fmt.Sprintf("\x1b[%d q", n)
}

func parseHex(s string) (color.Color, bool) {
	var r, g, b uint8
	if _, err := fmt.Sscanf(s, "#%02x%02x%02x", &r, &g, &b); err != nil {
		return nil, false
	}
	return color.RGBA{r, g, b, 255}, true
}

// xterm 的 256 色：前 16 色是默认值（会被主题覆盖），16–231 是 6×6×6 立方体，232–255 是灰阶
func xtermColor(i int) color.Color {
	base := [16][3]uint8{
		{0, 0, 0}, {205, 0, 0}, {0, 205, 0}, {205, 205, 0}, {0, 0, 238}, {205, 0, 205}, {0, 205, 205}, {229, 229, 229},
		{127, 127, 127}, {255, 0, 0}, {0, 255, 0}, {255, 255, 0}, {92, 92, 255}, {255, 0, 255}, {0, 255, 255}, {255, 255, 255},
	}
	switch {
	case i < 16:
		return color.RGBA{base[i][0], base[i][1], base[i][2], 255}
	case i < 232:
		i -= 16
		level := func(v int) uint8 {
			if v == 0 {
				return 0
			}
			return uint8(55 + v*40)
		}
		return color.RGBA{level(i / 36), level(i / 6 % 6), level(i % 6), 255}
	default:
		v := uint8(8 + (i-232)*10)
		return color.RGBA{v, v, v, 255}
	}
}
