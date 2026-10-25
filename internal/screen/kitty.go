package screen

// kitty 图形协议（https://sw.kovidgoyal.net/kitty/graphics-protocol/）里 herdr 用到的那部分：
//
//	a=t / a=T  传图（f=32 RGBA、f=24 RGB、f=100 PNG；t=d 数据直接跟在后面；m=1 分块；o=z 压缩）
//	a=p        把图放在光标处，占 c 列 r 行；x,y,w,h 是只显示原图的哪一块（滚出窗格一半时用）
//	a=d        删除：d=a/A 全部，d=i/I 某张图（大写连数据一起删）
//
// 手机上的 xterm.js 不认 kitty 协议，所以这里把图和位置记下来，单独发给手机，叠在终端上面画。

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"image"
	"image/png"
	"io"
	"log/slog"
	"strconv"
	"strings"

	uv "github.com/charmbracelet/ultraviolet"
)

const (
	maxImagePixels = 4096 * 4096
	maxImagesBytes = 128 << 20 // 所有图的 PNG 加起来最多这么多，超了先删最早的
)

// Image 是发给手机的一张图
type Image struct {
	ID   uint32
	W, H int
	PNG  []byte
}

// Placement 是一张图放在哪：左上角在第 X 列第 Y 行（从 0 数），占 Cols 列 Rows 行；
// 只显示原图从 (SX,SY) 起 SW×SH 像素的那一块
type Placement struct {
	Image uint32 `json:"i"`
	X     int    `json:"x"`
	Y     int    `json:"y"`
	Cols  int    `json:"c"`
	Rows  int    `json:"r"`
	SX    int    `json:"sx"`
	SY    int    `json:"sy"`
	SW    int    `json:"sw"`
	SH    int    `json:"sh"`
	Z     int    `json:"z"`
}

type placementKey struct{ image, placement uint32 }

type kitty struct {
	images     map[uint32]*Image
	order      []uint32 // 先来的在前，超出上限时先删
	bytes      int
	placements map[placementKey]Placement
	changed    bool     // 放置列表变了，还没告诉手机
	forgotten  []uint32 // 删掉的图，还没告诉手机
	auto       uint32   // 没给放置编号时自己编

	// 分块传输中的那一张
	pending        map[string]string
	pendingPayload strings.Builder
}

func newKitty() *kitty {
	return &kitty{images: map[uint32]*Image{}, placements: map[placementKey]Placement{}}
}

// handle 处理一条 APC：data 是 "G控制;数据"。cursor 是此刻的光标
func (k *kitty) handle(data []byte, cursor uv.Position) bool {
	if len(data) == 0 || data[0] != 'G' {
		return false
	}
	ctrl, payload, _ := strings.Cut(string(data[1:]), ";")
	params := map[string]string{}
	for _, kv := range strings.Split(ctrl, ",") {
		if key, val, ok := strings.Cut(kv, "="); ok {
			params[key] = val
		}
	}

	// 分块传输的后续块只带 m（可能还有 q）
	if k.pending != nil {
		k.pendingPayload.WriteString(payload)
		if params["m"] == "1" {
			return true
		}
		p := k.pending
		k.pending = nil
		k.transmit(p, k.pendingPayload.String(), cursor)
		k.pendingPayload.Reset()
		return true
	}

	switch params["a"] {
	case "", "t", "T":
		if params["m"] == "1" {
			k.pending = params
			k.pendingPayload.Reset()
			k.pendingPayload.WriteString(payload)
			return true
		}
		k.transmit(params, payload, cursor)
	case "p":
		k.place(params, cursor)
	case "d":
		k.delete(params)
	}
	return true
}

func num(p map[string]string, key string) int {
	n, _ := strconv.Atoi(p[key])
	return n
}

func (k *kitty) transmit(p map[string]string, payload string, cursor uv.Position) {
	if t := p["t"]; t != "" && t != "d" {
		slog.Debug("kitty: only direct transmission is supported", "t", t)
		return
	}
	id := uint32(num(p, "i"))
	if id == 0 {
		return // 没编号就没法引用；herdr 总会给
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(payload)
		if err != nil {
			return
		}
	}
	if p["o"] == "z" {
		r, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			return
		}
		if raw, err = io.ReadAll(io.LimitReader(r, maxImagePixels*4+1)); err != nil {
			return
		}
	}
	img, err := toPNG(p["f"], num(p, "s"), num(p, "v"), raw)
	if err != nil {
		slog.Debug("kitty: bad image", "err", err)
		return
	}
	img.ID = id
	k.store(img)
	if p["a"] == "T" {
		k.place(p, cursor)
	}
}

// toPNG 把传来的像素换成 PNG：手机上用浏览器解 PNG 最省事
func toPNG(format string, w, h int, raw []byte) (*Image, error) {
	if format == "100" {
		cfg, err := png.DecodeConfig(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		return &Image{W: cfg.Width, H: cfg.Height, PNG: raw}, nil
	}
	if w <= 0 || h <= 0 || w*h > maxImagePixels {
		return nil, errBadSize
	}
	px := 4
	if format == "24" {
		px = 3
	}
	if len(raw) < w*h*px {
		return nil, errBadSize
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := range w * h {
		copy(img.Pix[i*4:i*4+3], raw[i*px:i*px+3])
		if px == 4 {
			img.Pix[i*4+3] = raw[i*4+3]
		} else {
			img.Pix[i*4+3] = 255
		}
	}
	var b bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&b, img); err != nil {
		return nil, err
	}
	return &Image{W: w, H: h, PNG: b.Bytes()}, nil
}

type sizeError struct{}

func (sizeError) Error() string { return "kitty: image size missing or too large" }

var errBadSize = sizeError{}

func (k *kitty) store(img *Image) {
	if old, ok := k.images[img.ID]; ok {
		k.bytes -= len(old.PNG)
		k.dropOrder(img.ID)
		// 同一个编号换了内容，手机上那张要丢掉、重新发
		k.forgotten = append(k.forgotten, img.ID)
	}
	k.images[img.ID] = img
	k.order = append(k.order, img.ID)
	k.bytes += len(img.PNG)
	for k.bytes > maxImagesBytes && len(k.order) > 1 {
		k.forget(k.order[0])
	}
	k.changed = true
}

func (k *kitty) dropOrder(id uint32) {
	for i, x := range k.order {
		if x == id {
			k.order = append(k.order[:i], k.order[i+1:]...)
			return
		}
	}
}

func (k *kitty) forget(id uint32) {
	img, ok := k.images[id]
	if !ok {
		return
	}
	k.bytes -= len(img.PNG)
	delete(k.images, id)
	k.dropOrder(id)
	k.forgotten = append(k.forgotten, id)
	for key := range k.placements {
		if key.image == id {
			delete(k.placements, key)
		}
	}
	k.changed = true
}

func (k *kitty) place(p map[string]string, cursor uv.Position) {
	id := uint32(num(p, "i"))
	img, ok := k.images[id]
	if !ok {
		return
	}
	pid := uint32(num(p, "p"))
	if pid == 0 {
		k.auto++
		pid = 1<<31 | k.auto
	}
	pl := Placement{
		Image: id, X: cursor.X, Y: cursor.Y, Cols: num(p, "c"), Rows: num(p, "r"),
		SX: num(p, "x"), SY: num(p, "y"), SW: num(p, "w"), SH: num(p, "h"), Z: num(p, "z"),
	}
	if pl.SW == 0 {
		pl.SW = img.W - pl.SX
	}
	if pl.SH == 0 {
		pl.SH = img.H - pl.SY
	}
	key := placementKey{id, pid}
	if old, ok := k.placements[key]; !ok || old != pl {
		k.placements[key] = pl
		k.changed = true
	}
}

func (k *kitty) delete(p map[string]string) {
	switch d := p["d"]; d {
	case "", "a", "A":
		if len(k.placements) > 0 {
			k.placements = map[placementKey]Placement{}
			k.changed = true
		}
		if d == "A" {
			for _, id := range append([]uint32(nil), k.order...) {
				k.forget(id)
			}
		}
	case "i", "I":
		id := uint32(num(p, "i"))
		pid := uint32(num(p, "p"))
		for key := range k.placements {
			if key.image == id && (pid == 0 || key.placement == pid) {
				delete(k.placements, key)
				k.changed = true
			}
		}
		if d == "I" {
			k.forget(id)
		}
	default:
		slog.Debug("kitty: delete mode not supported", "d", d)
	}
}

// list 是现在的放置，按图层从下往上
func (k *kitty) list() []Placement {
	out := make([]Placement, 0, len(k.placements))
	for _, pl := range k.placements {
		out = append(out, pl)
	}
	// 先按 z，再按位置，保证同样的状态得到同样的顺序
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && less(out[j], out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func less(a, b Placement) bool {
	if a.Z != b.Z {
		return a.Z < b.Z
	}
	if a.Y != b.Y {
		return a.Y < b.Y
	}
	if a.X != b.X {
		return a.X < b.X
	}
	return a.Image < b.Image
}
