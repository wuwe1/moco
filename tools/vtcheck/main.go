// vtcheck：验证 mocod 用的终端模拟器（charmbracelet/x/vt）和手机上的 xterm.js 把同一段输出画成同一屏。
//
//	vtcheck capture -o herdr.jsonl -size 52x40 -script "wait 2; wheel down 10 20 15; resize 52x18; wait 1" -- herdr
//	vtcheck frames herdr.jsonl > f.jsonl       // 重新切段：每段结束在 herdr 的一帧结束（?2026l）上
//	vtcheck sync herdr.jsonl sent.jsonl > vt.json  // 过一遍 internal/screen：sent.jsonl 是发给手机的帧，vt.json 是每帧时电脑上的画面
//	vtcheck dump herdr.jsonl > vt.json        // x/vt 在各个检查点的整屏（-frames 只在一帧结束时截）
//	node tools/vtcheck/xterm.mjs herdr.jsonl   // xterm.js 同样的检查点，再和 vt.json 逐格对比
//
// 录下来的文件一行一条：{"d":"<base64 输出>"} 或 {"r":[列,行]}（这一刻改了尺寸）
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"image/color"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"

	"github.com/wuwe1/moco/internal/screen"

	uv "github.com/charmbracelet/ultraviolet"
)

type record struct {
	D []byte `json:"d,omitempty"`
	R []int  `json:"r,omitempty"`
	F bool   `json:"f,omitempty"` // 这段正好结束在一帧结束上
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: vtcheck capture|frames|dump ...")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "capture":
		err = capture(os.Args[2:])
	case "dump":
		err = dump(os.Args[2:])
	case "frames":
		err = frames(os.Args[2:])
	case "sync":
		err = syncFrames(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "vtcheck:", err)
		os.Exit(1)
	}
}

func parseSize(s string) (int, int, error) {
	c, r, ok := strings.Cut(s, "x")
	cols, err1 := strconv.Atoi(c)
	rows, err2 := strconv.Atoi(r)
	if !ok || err1 != nil || err2 != nil {
		return 0, 0, fmt.Errorf("bad size %q, want 52x40", s)
	}
	return cols, rows, nil
}

// capture 在 pty 里跑命令，按脚本给它输入、改尺寸，把输出原样录下来
func capture(args []string) error {
	fs := flag.NewFlagSet("capture", flag.ExitOnError)
	out := fs.String("o", "capture.jsonl", "output file")
	size := fs.String("size", "52x40", "initial size")
	script := fs.String("script", "wait 3", "steps separated by ;  wait N | wheel up|down N COL ROW | resize CxR | type TEXT")
	fs.Parse(args)
	if fs.NArg() == 0 {
		return fmt.Errorf("missing command after --")
	}
	cols, rows, err := parseSize(*size)
	if err != nil {
		return err
	}
	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	var mu sync.Mutex
	put := func(r record) {
		mu.Lock()
		defer mu.Unlock()
		enc.Encode(r)
	}

	cmd := exec.Command(fs.Arg(0), fs.Args()[1:]...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return err
	}
	put(record{R: []int{cols, rows}})
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := tty.Read(buf)
			if n > 0 {
				put(record{D: append([]byte(nil), buf[:n]...)})
			}
			if err != nil {
				return
			}
		}
	}()

	for _, step := range strings.Split(*script, ";") {
		f := strings.Fields(step)
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "wait":
			sec, _ := strconv.ParseFloat(f[1], 64)
			time.Sleep(time.Duration(sec * float64(time.Second)))
		case "wheel":
			btn := 64
			if f[1] == "down" {
				btn = 65
			}
			n, _ := strconv.Atoi(f[2])
			for range n {
				fmt.Fprintf(tty, "\x1b[<%d;%s;%sM", btn, f[3], f[4])
				time.Sleep(30 * time.Millisecond)
			}
		case "resize":
			c, r, err := parseSize(f[1])
			if err != nil {
				return err
			}
			// 先记下尺寸再改：之后读到的输出都是按新尺寸画的
			put(record{R: []int{c, r}})
			pty.Setsize(tty, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)})
		case "type":
			text := strings.TrimPrefix(strings.TrimSpace(step), "type ")
			tty.WriteString(strings.NewReplacer(`\r`, "\r", `\n`, "\n", `\e`, "\x1b").Replace(text))
		default:
			return fmt.Errorf("unknown step %q", step)
		}
	}
	cmd.Process.Signal(os.Interrupt)
	cmd.Process.Kill()
	<-done
	cmd.Wait()
	return nil
}

// 一个检查点：整屏、光标、模式开关。格式和 xterm.mjs 导出的一致
type checkpoint struct {
	At     int        `json:"at"` // 第几条记录之后
	Cols   int        `json:"cols"`
	Rows   int        `json:"rows"`
	Cursor [2]int     `json:"cursor"`
	Hidden bool       `json:"hidden"`
	Modes  []string   `json:"modes"`
	Cells  [][]string `json:"cells"` // 每格 "字␟宽␟前景␟背景␟属性␟链接"，␟ 是 \x1f
}

func readRecords(name string) ([]record, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var recs []record
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		var r record
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			return nil, err
		}
		recs = append(recs, r)
	}
	if len(recs) == 0 || recs[0].R == nil {
		return nil, fmt.Errorf("first record must be a size")
	}
	return recs, nil
}

// frames 把输出重新切段，让检查点都落在 herdr 画完一帧的时刻：mocod 只在这时截屏发帧，
// 画到一半的样子（例 改尺寸后、重画完之前）不会发到手机上
func frames(args []string) error {
	recs, err := readRecords(args[0])
	if err != nil {
		return err
	}
	end := []byte("\x1b[?2026l")
	enc := json.NewEncoder(os.Stdout)
	var pending []byte
	for _, r := range recs {
		if r.R != nil {
			if len(pending) > 0 {
				enc.Encode(record{D: pending})
				pending = nil
			}
			enc.Encode(record{R: r.R})
			continue
		}
		pending = append(pending, r.D...)
		for {
			i := bytes.Index(pending, end)
			if i < 0 {
				break
			}
			n := i + len(end)
			enc.Encode(record{D: pending[:n], F: true})
			pending = append([]byte(nil), pending[n:]...)
		}
	}
	if len(pending) > 0 {
		enc.Encode(record{D: pending})
	}
	return nil
}

// syncFrames 把录下的输出喂给 internal/screen（mocod 用的那一套），记下它出的每一帧；
// 同时另起一个模拟器跟着吃同样的输出，在每帧发出时截下电脑上的画面。
// 拿 xterm.mjs 回放这些帧再对比，就知道手机画出来的和电脑上的是不是一样
func syncFrames(args []string) error {
	recs, err := readRecords(args[0])
	if err != nil {
		return err
	}
	out, err := os.Create(args[1])
	if err != nil {
		return err
	}
	defer out.Close()
	enc := json.NewEncoder(out)

	cols, rows := recs[0].R[0], recs[0].R[1]
	scr := screen.New(cols, rows, screen.Theme{}, io.Discard)
	defer scr.Close()
	ref := vt.NewEmulator(cols, rows)
	go io.Copy(io.Discard, ref)
	modes := map[string]bool{"?7": true, "?25": true}
	ref.SetCallbacks(vt.Callbacks{
		EnableMode:  func(m ansi.Mode) { modes[modeName(m)] = true },
		DisableMode: func(m ansi.Mode) { delete(modes, modeName(m)) },
	})

	n := 0 // sent.jsonl 里第几条
	enc.Encode(record{R: []int{cols, rows}})
	var cps []checkpoint
	emit := func() {
		f, _ := scr.Frame()
		if f == nil {
			return
		}
		// 图片事件打到 stderr，看 herdr 的图有没有被正确接住
		for _, id := range f.Forget {
			fmt.Fprintf(os.Stderr, "frame %d: forget image %d\n", n+1, id)
		}
		for _, img := range f.Images {
			fmt.Fprintf(os.Stderr, "frame %d: image %d %dx%d, png %d bytes\n", n+1, img.ID, img.W, img.H, len(img.PNG))
		}
		if f.Placements != nil {
			fmt.Fprintf(os.Stderr, "frame %d: placements %+v\n", n+1, f.Placements)
		}
		if f.Data == nil {
			return
		}
		enc.Encode(record{D: f.Data})
		n++
		cp := snapshot(ref, n, modes)
		cps = append(cps, cp)
	}
	for i, r := range recs {
		if i > 0 && r.R != nil {
			scr.Resize(r.R[0], r.R[1])
			ref.Resize(r.R[0], r.R[1])
			enc.Encode(record{R: r.R})
			n++
		}
		if r.D != nil {
			scr.Write(r.D)
			ref.Write(r.D)
		}
		emit()
	}
	return json.NewEncoder(os.Stdout).Encode(cps)
}

func dump(args []string) error {
	fs := flag.NewFlagSet("dump", flag.ExitOnError)
	every := fs.Int("every", 25, "checkpoint every N records (and after each resize, and at the end)")
	onlyFrames := fs.Bool("frames", false, "checkpoint only where a herdr frame ends (records from vtcheck frames)")
	fs.Parse(args)
	recs, err := readRecords(fs.Arg(0))
	if err != nil {
		return err
	}

	e := vt.NewEmulator(recs[0].R[0], recs[0].R[1])
	// 对查询的回答写进一个管道，没人读写终端就会卡住
	go func() {
		buf := make([]byte, 4096)
		for {
			if _, err := e.Read(buf); err != nil {
				return
			}
		}
	}()
	// 回调只报变化，默认开着的两个先记上（见 x/vt 的 resetModes）
	modes := map[string]bool{"?7": true, "?25": true}
	e.SetCallbacks(vt.Callbacks{
		EnableMode:  func(m ansi.Mode) { modes[modeName(m)] = true },
		DisableMode: func(m ansi.Mode) { delete(modes, modeName(m)) },
	})

	var cps []checkpoint
	for i, r := range recs {
		if i > 0 && r.R != nil {
			e.Resize(r.R[0], r.R[1])
		}
		if r.D != nil {
			e.Write(r.D)
		}
		next := i+1 < len(recs) && recs[i+1].R != nil
		if *onlyFrames {
			if r.F {
				cps = append(cps, snapshot(e, i, modes))
			}
		} else if i == len(recs)-1 || next || (i+1)%*every == 0 {
			cps = append(cps, snapshot(e, i, modes))
		}
	}
	return json.NewEncoder(os.Stdout).Encode(cps)
}

func modeName(m ansi.Mode) string {
	if _, ok := m.(ansi.DECMode); ok {
		return "?" + strconv.Itoa(m.Mode())
	}
	return strconv.Itoa(m.Mode())
}

func snapshot(e *vt.Emulator, at int, modes map[string]bool) checkpoint {
	cp := checkpoint{At: at, Cols: e.Width(), Rows: e.Height(), Hidden: e.CursorHidden()}
	pos := e.CursorPosition()
	cp.Cursor = [2]int{pos.X, pos.Y}
	for m := range modes {
		cp.Modes = append(cp.Modes, m)
	}
	for y := range cp.Rows {
		row := make([]string, 0, cp.Cols)
		for x := 0; x < cp.Cols; x++ {
			row = append(row, cellString(e.CellAt(x, y)))
		}
		cp.Cells = append(cp.Cells, row)
	}
	return cp
}

func cellString(c *uv.Cell) string {
	if c == nil {
		return "nil"
	}
	ch := c.Content
	if ch == "" && c.Width != 0 {
		ch = " "
	}
	s := c.Style
	var a []string
	for _, x := range []struct {
		bit  uint8
		name string
	}{{uv.AttrBold, "b"}, {uv.AttrFaint, "f"}, {uv.AttrItalic, "i"}, {uv.AttrBlink, "k"}, {uv.AttrReverse, "r"}, {uv.AttrConceal, "c"}, {uv.AttrStrikethrough, "s"}} {
		if s.Attrs&x.bit != 0 {
			a = append(a, x.name)
		}
	}
	if s.Underline != uv.UnderlineNone {
		a = append(a, "u")
	}
	return strings.Join([]string{ch, strconv.Itoa(c.Width), colorString(s.Fg), colorString(s.Bg), strings.Join(a, ""), c.Link.URL}, "\x1f")
}

func colorString(c color.Color) string {
	switch v := c.(type) {
	case nil:
		return "d"
	case ansi.BasicColor:
		return "p" + strconv.Itoa(int(v))
	case ansi.IndexedColor:
		return "p" + strconv.Itoa(int(v))
	default:
		r, g, b, _ := c.RGBA()
		return fmt.Sprintf("#%02x%02x%02x", r>>8, g>>8, b>>8)
	}
}
