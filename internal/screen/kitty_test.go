package screen

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"
)

// herdr 发图的样子：RGBA 原始像素，base64 分几块传（m=1 … m=0）
func transmitRGBA(id uint32, w, h int) string {
	raw := make([]byte, w*h*4)
	for i := range w * h {
		raw[i*4], raw[i*4+1], raw[i*4+2], raw[i*4+3] = byte(i), 100, 200, 255
	}
	b64 := base64.StdEncoding.EncodeToString(raw)
	var out strings.Builder
	const chunk = 4096
	for i := 0; i < len(b64); i += chunk {
		end := min(i+chunk, len(b64))
		more := 1
		if end == len(b64) {
			more = 0
		}
		if i == 0 {
			fmt.Fprintf(&out, "\x1b_Ga=t,t=d,f=32,s=%d,v=%d,i=%d,q=2,m=%d;%s\x1b\\", w, h, id, more, b64[i:end])
		} else {
			fmt.Fprintf(&out, "\x1b_Gm=%d;%s\x1b\\", more, b64[i:end])
		}
	}
	return out.String()
}

func mustFrame(t *testing.T, s *Screen) *Frame {
	t.Helper()
	f, wait := s.Frame()
	if f == nil || wait > 0 {
		t.Fatalf("want a frame, got %+v wait %v", f, wait)
	}
	return f
}

func TestKittyTransmitPlaceCropDelete(t *testing.T) {
	s := New(52, 24, Theme{}, io.Discard)
	defer s.Close()

	// 传图（64×48，分块）再在第 6 行放下，占 8 列 4 行，光标不动
	s.Write([]byte(transmitRGBA(7, 64, 48)))
	s.Write([]byte("\x1b[6;1H\x1b_Ga=p,i=7,p=3,c=8,r=4,z=0,C=1,q=2,w=64,h=48\x1b\\"))
	f := mustFrame(t, s)
	if len(f.Images) != 1 || f.Images[0].ID != 7 || f.Images[0].W != 64 || f.Images[0].H != 48 {
		t.Fatalf("images: %+v", f.Images)
	}
	img, err := png.Decode(bytes.NewReader(f.Images[0].PNG))
	if err != nil || img.Bounds().Dx() != 64 {
		t.Fatalf("png: %v %v", err, img)
	}
	want := Placement{Image: 7, X: 0, Y: 5, Cols: 8, Rows: 4, SW: 64, SH: 48}
	if len(f.Placements) != 1 || f.Placements[0] != want {
		t.Fatalf("placements: %+v, want %+v", f.Placements, want)
	}

	// 每帧重放同样的位置：不算变化，不再发
	s.Write([]byte("\x1b[6;1H\x1b_Ga=p,i=7,p=3,c=8,r=4,z=0,C=1,q=2,w=64,h=48\x1b\\x"))
	if f := mustFrame(t, s); f.Placements != nil || f.Images != nil {
		t.Fatalf("unchanged placement resent: %+v", f)
	}

	// 往上滚出一半：只显示原图下半部分，图不重发
	s.Write([]byte("\x1b[3;1H\x1b_Ga=p,i=7,p=3,c=8,r=2,z=0,C=1,q=2,y=24,w=64,h=24\x1b\\"))
	f = mustFrame(t, s)
	want = Placement{Image: 7, X: 0, Y: 2, Cols: 8, Rows: 2, SY: 24, SW: 64, SH: 24}
	if len(f.Placements) != 1 || f.Placements[0] != want || f.Images != nil {
		t.Fatalf("cropped: %+v", f)
	}

	// 删掉（连数据）：手机丢掉这张图，放置清空
	s.Write([]byte("\x1b_Ga=d,d=I,i=7,q=2\x1b\\"))
	f = mustFrame(t, s)
	if len(f.Forget) != 1 || f.Forget[0] != 7 || f.Placements == nil || len(f.Placements) != 0 {
		t.Fatalf("delete: %+v", f)
	}
}

// 重连（Reset）后图和放置都重发
func TestKittyResentAfterReset(t *testing.T) {
	s := New(20, 10, Theme{}, io.Discard)
	defer s.Close()
	s.Write([]byte(transmitRGBA(9, 4, 4) + "\x1b_Ga=p,i=9,p=1,c=2,r=1,C=1,q=2\x1b\\"))
	mustFrame(t, s)
	s.Reset()
	f := mustFrame(t, s)
	if len(f.Images) != 1 || len(f.Placements) != 1 {
		t.Fatalf("after reset: %+v", f)
	}
}

// a=T：传完就放；PNG 原样保留
func TestKittyTransmitAndDisplayPNG(t *testing.T) {
	var b bytes.Buffer
	// 用标准库生成一张 2×2 的 PNG
	s := New(20, 10, Theme{}, io.Discard)
	defer s.Close()
	s.Write([]byte(transmitRGBA(1, 2, 2)))
	f := mustFrame(t, s) // 只传不放：没有放置，也不用发图
	if f.Images != nil {
		t.Fatalf("unplaced image sent: %+v", f.Images)
	}
	b.Write(s.k.images[1].PNG)
	s.Write([]byte("\x1b[2;3H\x1b_Ga=T,f=100,i=2,c=1,r=1;" + base64.StdEncoding.EncodeToString(b.Bytes()) + "\x1b\\"))
	f = mustFrame(t, s)
	if len(f.Placements) != 1 || f.Placements[0].X != 2 || f.Placements[0].Y != 1 || len(f.Images) != 1 || f.Images[0].ID != 2 {
		t.Fatalf("a=T: %+v", f)
	}
	if !bytes.Equal(f.Images[0].PNG, b.Bytes()) {
		t.Fatal("png should be passed through unchanged")
	}
}

// 一格多少像素：知道了就回答 CSI 16 t / 14 t，不知道就不答
func TestAnswersCellSize(t *testing.T) {
	out := &buf{}
	s := New(40, 10, Theme{}, out)
	defer s.Close()
	s.Write([]byte("\x1b[16t"))
	s.SetCellSize(8, 17)
	s.Write([]byte("\x1b[16t\x1b[14t"))
	deadline := time.Now().Add(time.Second)
	for !strings.Contains(out.String(), "\x1b[4;") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := out.String(); got != "\x1b[6;17;8t\x1b[4;170;320t" {
		t.Fatalf("got %q", got)
	}
}
