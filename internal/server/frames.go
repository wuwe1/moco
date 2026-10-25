package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/screen"
	"github.com/wuwe1/moco/internal/term"
)

// moco.v2 的帧（大端）：
//
//	mocod → [2][序号 uint32][列 uint16][行 uint16][控制序列]  一帧：从上一帧到现在的变化
//	手机 → [3][序号 uint32]                                  这一帧画完了
//
// 手机没确认的帧最多 framesInFlight 个；再有变化就攒着，确认回来时把攒下的合成一帧发。
// 手机收得慢时帧变少、画面跳着更新，但不会越积越多，程序那边也从不等网络。
const framesInFlight = 2

const (
	msgFrame = 2
	msgAck   = 3
)

func (s *Server) pumpFrames(ctx context.Context, c *websocket.Conn, sess *term.Session, hello message) string {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var once sync.Once
	var why string
	note := func(reason string) { once.Do(func() { why = reason }) }
	stop := func(reason string) {
		note(reason)
		cancel()
	}

	// 模拟器对查询的回答（光标位置、颜色）直接写回终端，就像手机上的 xterm.js 回答的一样
	scr := screen.New(int(hello.Cols), int(hello.Rows), hello.Theme, sess)
	defer scr.Close()

	wake := make(chan struct{}, 1)
	signal := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	acks := make(chan struct{}, framesInFlight*4)

	// 读终端：全速喂进模拟器，从不等网络
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		buf := make([]byte, 32*1024)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				scr.Write(buf[:n])
				signal()
			}
			if err != nil {
				return
			}
		}
	}()

	// 出帧
	go func() {
		defer stop("frames closed")
		var seq uint32
		inflight := 0
		retry := time.NewTimer(time.Hour)
		retry.Stop()
		send := func(f []byte, cols, rows int) bool {
			seq++
			msg := make([]byte, 9+len(f))
			msg[0] = msgFrame
			binary.BigEndian.PutUint32(msg[1:], seq)
			binary.BigEndian.PutUint16(msg[5:], uint16(cols))
			binary.BigEndian.PutUint16(msg[7:], uint16(rows))
			copy(msg[9:], f)
			if err := c.Write(ctx, websocket.MessageBinary, msg); err != nil {
				stop("write: " + err.Error())
				return false
			}
			inflight++
			return true
		}
		finished := ended
		for {
			select {
			case <-ctx.Done():
				return
			case <-wake:
			case <-acks:
				inflight = max(0, inflight-1)
			case <-retry.C:
			case <-finished:
				// 程序退出了：把最后的样子发出去（不管手机确认没有），再告诉手机退出码
				<-sess.Done()
				if f, cols, rows, _ := scr.Frame(); f != nil && !send(f, cols, rows) {
					return
				}
				code := sess.ExitCode()
				note(fmt.Sprintf("command exited with code %d", code))
				wsjson.Write(ctx, c, message{Type: "exit", Code: &code})
				c.Close(websocket.StatusNormalClosure, "exit")
				return
			}
			for inflight < framesInFlight {
				f, cols, rows, wait := scr.Frame()
				if f == nil {
					if wait > 0 {
						retry.Reset(wait)
					}
					break
				}
				if !send(f, cols, rows) {
					return
				}
			}
		}
	}()

	go heartbeat(ctx, c, stop)

	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			stop("read: " + err.Error())
			return why
		}
		if typ != websocket.MessageBinary || len(data) == 0 {
			continue
		}
		switch data[0] {
		case 0:
			sess.Write(data[1:])
		case 1:
			var sz struct{ Cols, Rows uint16 }
			if json.Unmarshal(data[1:], &sz) == nil && sz.Cols > 0 && sz.Rows > 0 {
				sess.Resize(sz.Cols, sz.Rows)
				scr.Resize(int(sz.Cols), int(sz.Rows))
				signal()
			}
		case msgAck:
			select {
			case acks <- struct{}{}:
			case <-ctx.Done():
			}
		}
	}
}

// heartbeat 每 25 秒 ping 一次，及早发现手机那头已经没了的连接
func heartbeat(ctx context.Context, c *websocket.Conn, stop func(string)) {
	t := time.NewTicker(25 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.Ping(pctx)
			pcancel()
			if err != nil {
				stop("ping: " + err.Error())
				return
			}
		}
	}
}
