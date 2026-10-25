// Package service 生成开机自启的配置：Mac 上是 launchd，Linux（WSL）上是 systemd 用户服务。
package service

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const label = "com.moco.mocod"

// Install 写好配置文件，返回路径和让它生效要跑的命令
func Install(bin string) (file string, next []string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", nil, err
	}
	switch runtime.GOOS {
	case "darwin":
		file = filepath.Join(home, "Library", "LaunchAgents", label+".plist")
		logf := filepath.Join(home, "Library", "Logs", "mocod.log")
		body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>%s</string>
	<key>ProgramArguments</key><array><string>%s</string><string>serve</string></array>
	<key>EnvironmentVariables</key><dict><key>SHELL</key><string>%s</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>%s</string>
	<key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, label, bin, shell(), logf, logf)
		next = []string{"launchctl bootstrap gui/$(id -u) " + file}
		return file, next, writeFile(file, body)
	case "linux":
		file = filepath.Join(home, ".config", "systemd", "user", "mocod.service")
		body := fmt.Sprintf(`[Unit]
Description=moco terminal daemon
After=network-online.target

[Service]
ExecStart=%s serve
Environment=SHELL=%s
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`, bin, shell())
		next = []string{"systemctl --user daemon-reload", "systemctl --user enable --now mocod", "loginctl enable-linger $USER"}
		return file, next, writeFile(file, body)
	}
	return "", nil, fmt.Errorf("unsupported OS %s", runtime.GOOS)
}

func shell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	return "/bin/sh"
}

func writeFile(file, body string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	return os.WriteFile(file, []byte(body), 0o644)
}
