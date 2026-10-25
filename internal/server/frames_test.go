package server

import (
	"context"
	"crypto/ed25519"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/auth"
)

// 用 moco.v2 连上并完成握手
func dialFrames(t *testing.T, ts *httptest.Server, key string, priv ed25519.PrivateKey) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{
		Subprotocols: []string{ProtocolFrames, Protocol},
		HTTPHeader:   http.Header{"Origin": {origin}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	if c.Subprotocol() != ProtocolFrames {
		t.Fatalf("negotiated %q", c.Subprotocol())
	}
	c.SetReadLimit(1 << 24)
	wsjson.Write(ctx, c, message{Type: "hello", Key: key, Cols: 40, Rows: 10})
	var ch message
	wsjson.Read(ctx, c, &ch)
	nonce, _ := b64.DecodeString(ch.Nonce)
	wsjson.Write(ctx, c, message{Type: "auth", Sig: b64.EncodeToString(ed25519.Sign(priv, auth.Message(ch.Name, nonce)))})
	var ready message
	if err := wsjson.Read(ctx, c, &ready); err != nil || ready.Type != "ready" {
		t.Fatalf("ready: %+v %v", ready, err)
	}
	return c, ctx
}

type frameMsg struct {
	seq        uint32
	cols, rows int
	body       string
}

func readFrame(ctx context.Context, c *websocket.Conn) (frameMsg, *message, error) {
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return frameMsg{}, nil, err
		}
		if typ == websocket.MessageText {
			var m message
			json.Unmarshal(data, &m)
			return frameMsg{}, &m, nil
		}
		if len(data) >= 9 && data[0] == msgFrame {
			return frameMsg{
				seq:  binary.BigEndian.Uint32(data[1:]),
				cols: int(binary.BigEndian.Uint16(data[5:])),
				rows: int(binary.BigEndian.Uint16(data[7:])),
				body: string(data[9:]),
			}, nil, nil
		}
	}
}

func ack(ctx context.Context, c *websocket.Conn, seq uint32) {
	msg := make([]byte, 5)
	msg[0] = msgAck
	binary.BigEndian.PutUint32(msg[1:], seq)
	c.Write(ctx, websocket.MessageBinary, msg)
}

// 打字 → 回显出现在帧里；确认之后接着收到新帧
func TestFramesRoundTrip(t *testing.T) {
	ts, key, priv, _ := setupCmd(t, "cat")
	c, ctx := dialFrames(t, ts, key, priv)

	c.Write(ctx, websocket.MessageBinary, append([]byte{0}, "hello moco\r"...))
	var seen strings.Builder
	for !strings.Contains(seen.String(), "hello moco") {
		f, _, err := readFrame(ctx, c)
		if err != nil {
			t.Fatalf("waiting for echo: %v (seen %q)", err, seen.String())
		}
		if f.cols != 40 || f.rows != 10 {
			t.Fatalf("frame size %dx%d", f.cols, f.rows)
		}
		seen.WriteString(f.body)
		ack(ctx, c, f.seq)
	}

	// 改尺寸后的帧带新尺寸
	c.Write(ctx, websocket.MessageBinary, append([]byte{1}, `{"cols":30,"rows":8}`...))
	c.Write(ctx, websocket.MessageBinary, append([]byte{0}, "again\r"...))
	for {
		f, _, err := readFrame(ctx, c)
		if err != nil {
			t.Fatal(err)
		}
		ack(ctx, c, f.seq)
		if f.cols == 30 && f.rows == 8 && strings.Contains(f.body, "again") {
			break
		}
	}
}

// 手机一直不确认：最多收到 framesInFlight 帧加最后一帧，程序照样把 20 万行写完、退出
func TestFramesSlowClientNeverBlocksProgram(t *testing.T) {
	ts, key, priv, logs := setupCmd(t, "sh", "-c", "i=0; while [ $i -lt 200000 ]; do echo line $i; i=$((i+1)); done; echo END")
	c, ctx := dialFrames(t, ts, key, priv)

	frames := 0
	start := time.Now()
	for {
		f, exit, err := readFrame(ctx, c)
		if exit != nil {
			break
		}
		if err != nil {
			// 服务端发完 exit 就关连接：以日志为准
			break
		}
		frames++
		if strings.Contains(f.body, "END") {
			break
		}
	}
	deadline := time.Now().Add(15 * time.Second)
	for !strings.Contains(logs.String(), "command exited with code 0") {
		if time.Now().After(deadline) {
			t.Fatalf("program did not finish; frames=%d logs:\n%s", frames, logs)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if frames > framesInFlight+1 {
		t.Errorf("got %d frames without acking, want at most %d", frames, framesInFlight+1)
	}
	t.Logf("%d frames, program finished in %v", frames, time.Since(start))
}
