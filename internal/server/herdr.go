package server

import (
	"context"
	"fmt"
	"sync"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/wuwe1/moco/internal/herdr"
)

// 手机看 herdr 用另一条连接：hello 里带 watch:true，握手同样要过，但不开终端。之后 herdr 的状态一变就发
//
//	mocod → {type:"herdr", herdr}   herdr 见 herdr.State；null 表示这台电脑上 herdr 没开
//
// 切 tab 这类操作走请求（[9]，见 frames.go）：op "herdr"，带 method、params，原样转给 herdr 的 socket，
// method 只许 herdrMethods 里的这几个

var herdrMethods = map[string]bool{
	"tab.focus":       true,
	"tab.create":      true,
	"workspace.focus": true,
	"pane.focus":      true, // 切到这个窗格（agent 所在的），herdr 顺带把「干完了」标成看过
	"pane.zoom":       true,
}

type herdrWatch struct {
	once    sync.Once
	watcher *herdr.Watcher
}

func (s *Server) herdr() herdr.Client {
	if s.HerdrSocket != "" {
		return herdr.Client{Path: s.HerdrSocket}
	}
	return herdr.Client{Path: herdr.SocketPath()}
}

// 所有连接共用一个：手机开着几条 watch 连接也只每秒问一次
func (s *Server) herdrWatcher() *herdr.Watcher {
	s.hw.once.Do(func() { s.hw.watcher = herdr.NewWatcher(s.herdr()) })
	return s.hw.watcher
}

func (s *Server) herdrCall(ctx context.Context, req request) (any, error) {
	if !herdrMethods[req.Method] {
		return nil, fmt.Errorf("herdr method %q not allowed", req.Method)
	}
	var params any = req.Params
	if len(req.Params) == 0 {
		params = struct{}{}
	}
	return s.herdr().Call(ctx, req.Method, params)
}

type herdrMsg struct {
	Type  string       `json:"type"`
	Herdr *herdr.State `json:"herdr"`
}

func (s *Server) watch(ctx context.Context, c *websocket.Conn, key string) string {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var once sync.Once
	var why string
	stop := func(reason string) {
		once.Do(func() { why = reason })
		cancel()
	}
	w := s.herdrWatcher()
	changed, unsubscribe := w.Subscribe()
	defer unsubscribe()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-changed:
				if err := wsjson.Write(ctx, c, herdrMsg{Type: "herdr", Herdr: w.State()}); err != nil {
					stop("write: " + err.Error())
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
		case msgRequest:
			s.answer(ctx, c, key, data)
		case msgLog:
			s.Log.Info("phone", "msg", string(data[1:]))
		}
	}
}
