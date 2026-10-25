// mocod：每台电脑上的 moco 后端。手机上的 App 经 Tailscale 连进来，认过设备才开终端。
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/wuwe1/moco/internal/auth"
	"github.com/wuwe1/moco/internal/config"
	"github.com/wuwe1/moco/internal/server"
	"github.com/wuwe1/moco/internal/service"
)

var version = "dev"

const usage = `mocod — moco 的后端

用法：
  mocod serve [-listen 地址] [-web 目录]   启动服务（默认只听 127.0.0.1:7681）
  mocod pair                               生成配对码，5 分钟内在手机 App 里输入
  mocod devices                            列出已配对的设备
  mocod revoke <名字>                      删掉一台设备
  mocod install                            设成开机自启（Mac 用 launchd，WSL 用 systemd）
  mocod version

配置和设备名单在 ` + "`~/.config/mocod/`" + `（可用 MOCOD_HOME 改）。
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "pair":
		err = pair()
	case "devices":
		err = devices()
	case "revoke":
		err = revoke(os.Args[2:])
	case "install":
		err = install()
	case "version":
		fmt.Println(version)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "mocod:", err)
		os.Exit(1)
	}
}

func serve(args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	fs.StringVar(&cfg.Listen, "listen", cfg.Listen, "监听地址")
	fs.StringVar(&cfg.Web, "web", cfg.Web, "同时提供这个目录下的网页")
	fs.StringVar(&cfg.Dev, "dev", cfg.Dev, "网页请求先转给这个地址（Vite 开发服务），连不上再用 -web")
	fs.Parse(args)

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	s := &server.Server{Cfg: cfg, Version: version, Log: log}
	log.Info("mocod listening", "addr", cfg.Listen, "name", cfg.Name, "origins", cfg.Origins, "command", cfg.Command)
	srv := &http.Server{Addr: cfg.Listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	return srv.ListenAndServe()
}

func pair() error {
	code, exp, err := auth.NewPairing()
	if err != nil {
		return err
	}
	fmt.Printf("配对码：%s %s\n\n在手机 App 里添加这台电脑时输入，%s 前有效（5 分钟），只能用一次。\n",
		code[:3], code[3:], exp.Format("15:04:05"))
	return nil
}

func devices() error {
	ds, err := config.Devices()
	if err != nil {
		return err
	}
	if len(ds) == 0 {
		fmt.Println("还没有配对的设备。运行 `mocod pair` 开始配对。")
		return nil
	}
	for _, d := range ds {
		seen := "从没连过"
		if !d.LastSeen.IsZero() {
			seen = "最后连接 " + d.LastSeen.Format("2006-01-02 15:04")
		}
		fmt.Printf("%-16s 配对于 %s，%s\n", d.Name, d.Added.Format("2006-01-02 15:04"), seen)
	}
	return nil
}

func revoke(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("用法：mocod revoke <名字>")
	}
	ds, err := config.Devices()
	if err != nil {
		return err
	}
	out := ds[:0]
	for _, d := range ds {
		if d.Name != args[0] {
			out = append(out, d)
		}
	}
	if len(out) == len(ds) {
		return fmt.Errorf("没有叫 %q 的设备（`mocod devices` 看名单）", args[0])
	}
	if err := config.SaveDevices(out); err != nil {
		return err
	}
	fmt.Printf("已删除 %s。它已经开着的连接不受影响，下次连接会被拒绝。\n", args[0])
	return nil
}

func install() error {
	bin, err := os.Executable()
	if err != nil {
		return err
	}
	bin, _ = filepath.EvalSymlinks(bin)
	file, next, err := service.Install(bin)
	if err != nil {
		return err
	}
	fmt.Printf("已写好 %s\n让它生效：\n", file)
	for _, c := range next {
		fmt.Println("  " + c)
	}
	return nil
}
