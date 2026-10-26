package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/SherClockHolmes/webpush-go"

	"github.com/wuwe1/moco/internal/auth"
	"github.com/wuwe1/moco/internal/config"
	"github.com/wuwe1/moco/internal/herdr"
)

// 推送：手机打开通知后，把自己的订阅交给每台电脑上的 mocod（请求 op "push.subscribe"，见 frames.go）。
// 有订阅时 mocod 一直盯着 herdr（手机没连着也盯），agent 变成「等你」或「干完了」就给每个订阅发一条：
//
//	{title, body, tag, host, pane}   host 是手机上这台电脑的编号，手机点开通知时切到 pane

const (
	pushSubscriber = "https://github.com/wuwe1/moco" // VAPID 的 sub：Apple 要求是 https 网址或 mailto
	pushTTL        = 3600
	pushTimeout    = 15 * time.Second
)

type pusher struct {
	mu      sync.Mutex // 管 running，也管 push.json 的读改写
	running bool
}

type pushPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`
	Host  string `json:"host"`
	Pane  string `json:"pane,omitempty"`
}

// StartPush 在 mocod 启动时调：已经有订阅就开始盯 herdr
func (s *Server) StartPush() {
	s.push.mu.Lock()
	defer s.push.mu.Unlock()
	if s.push.running {
		return
	}
	if subs, _ := config.PushSubs(); len(subs) == 0 {
		return
	}
	s.push.running = true
	go s.watchForPush()
}

func (s *Server) watchForPush() {
	w := s.herdrWatcher()
	changed, unsubscribe := w.Subscribe()
	defer unsubscribe()
	last := map[string]string{} // 面板 → 上次看到的状态
	for range changed {
		s.push.mu.Lock()
		subs, _ := config.PushSubs()
		if len(subs) == 0 {
			s.push.running = false
			s.push.mu.Unlock()
			return
		}
		s.push.mu.Unlock()
		st := w.State()
		if st == nil {
			continue
		}
		for _, p := range s.agentEvents(last, st) {
			for _, sub := range subs {
				s.sendPush(sub, p)
			}
		}
	}
}

// agentEvents 比较这次和上次的状态：变成 blocked、done 的各出一条。第一次见到的面板不算
func (s *Server) agentEvents(last map[string]string, st *herdr.State) []pushPayload {
	var out []pushPayload
	labels := map[string]string{}
	for _, w := range st.Workspaces {
		labels[w.ID] = w.Label
	}
	seen := map[string]bool{}
	for _, a := range st.Agents {
		seen[a.Pane] = true
		prev, ok := last[a.Pane]
		last[a.Pane] = a.Status
		if !ok || prev == a.Status || (a.Status != "blocked" && a.Status != "done") {
			continue
		}
		title := a.Name + " 在等你"
		if a.Status == "done" {
			title = a.Name + " 干完了"
		}
		var body []string
		for _, part := range []string{s.Cfg.Name, labels[a.Workspace], a.Title} {
			if part != "" {
				body = append(body, part)
			}
		}
		out = append(out, pushPayload{Title: title, Body: strings.Join(body, " · "), Pane: a.Pane})
	}
	for pane := range last {
		if !seen[pane] {
			delete(last, pane)
		}
	}
	return out
}

// sendPush 发一条；订阅失效了（手机关了通知、设备被 revoke）就删掉它
func (s *Server) sendPush(sub config.PushSub, p pushPayload) error {
	err := s.deliver(sub, p)
	if errors.Is(err, errSubscriptionGone) {
		s.Log.Info("push subscription gone", "host", sub.Host, "err", err)
		s.editPushSubs(func(ps []config.PushSub) []config.PushSub {
			return slices.DeleteFunc(ps, func(x config.PushSub) bool { return x.Endpoint == sub.Endpoint })
		})
	} else if err != nil {
		s.Log.Warn("push failed", "host", sub.Host, "err", err)
	}
	return err
}

var errSubscriptionGone = errors.New("subscription gone")

func (s *Server) deliver(sub config.PushSub, p pushPayload) error {
	if _, err := auth.Find(sub.Key); err != nil {
		return fmt.Errorf("%w: device: %v", errSubscriptionGone, err)
	}
	p.Host = sub.Host
	p.Tag = sub.Host + ":" + p.Pane
	body, _ := json.Marshal(p)
	ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
	defer cancel()
	client := s.PushHTTP
	if client == nil {
		client = &http.Client{Timeout: pushTimeout}
	}
	resp, err := webpush.SendNotificationWithContext(ctx, body, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		HTTPClient:      client,
		Subscriber:      pushSubscriber,
		TTL:             pushTTL,
		Urgency:         webpush.UrgencyHigh,
		VAPIDPublicKey:  sub.VAPIDPublic,
		VAPIDPrivateKey: sub.VAPIDPrivate,
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return fmt.Errorf("%w: %s %s", errSubscriptionGone, resp.Status, msg)
	case resp.StatusCode >= 400:
		return fmt.Errorf("push service: %s %s", resp.Status, msg)
	}
	return nil
}

func (s *Server) editPushSubs(edit func([]config.PushSub) []config.PushSub) error {
	s.push.mu.Lock()
	defer s.push.mu.Unlock()
	ps, err := config.PushSubs()
	if err != nil {
		return err
	}
	return config.SavePushSubs(edit(ps))
}

type pushParams struct {
	Host     string `json:"host"`
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	VAPID struct {
		Public  string `json:"public"`
		Private string `json:"private"`
	} `json:"vapid"`
}

// pushOp 回答 push.subscribe、push.unsubscribe、push.test；key 是发请求的那台手机
func (s *Server) pushOp(req request, key string) (any, error) {
	switch req.Op {
	case "push.subscribe":
		var p pushParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, err
		}
		u, err := url.Parse(p.Endpoint)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return nil, fmt.Errorf("bad push endpoint %q", p.Endpoint)
		}
		if p.Host == "" || p.Keys.P256dh == "" || p.Keys.Auth == "" || p.VAPID.Public == "" || p.VAPID.Private == "" {
			return nil, errors.New("incomplete push subscription")
		}
		sub := config.PushSub{Key: key, Host: p.Host, Endpoint: p.Endpoint, P256dh: p.Keys.P256dh, Auth: p.Keys.Auth, VAPIDPublic: p.VAPID.Public, VAPIDPrivate: p.VAPID.Private}
		err = s.editPushSubs(func(ps []config.PushSub) []config.PushSub {
			return append(slices.DeleteFunc(ps, func(x config.PushSub) bool { return x.Key == key }), sub)
		})
		if err != nil {
			return nil, err
		}
		s.StartPush()
		return map[string]bool{"ok": true}, nil
	case "push.unsubscribe":
		err := s.editPushSubs(func(ps []config.PushSub) []config.PushSub {
			return slices.DeleteFunc(ps, func(x config.PushSub) bool { return x.Key == key })
		})
		return map[string]bool{"ok": true}, err
	case "push.test":
		ps, err := config.PushSubs()
		if err != nil {
			return nil, err
		}
		i := slices.IndexFunc(ps, func(x config.PushSub) bool { return x.Key == key })
		if i < 0 {
			return nil, errors.New("这台手机在这台电脑上没有订阅通知")
		}
		if err := s.sendPush(ps[i], pushPayload{Title: "moco 通知试一下", Body: s.Cfg.Name + " 能给这台手机发通知了"}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
	return nil, fmt.Errorf("unknown op %q", req.Op)
}
