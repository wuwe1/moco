// Package config 管 mocod 在磁盘上的东西：~/.config/mocod/ 下的配置、设备名单、待用的配对码。
// 服务和命令行（pair、revoke）都会写设备名单，所以每次都现读现写，写用临时文件再改名。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	Name    string   `json:"name"`    // 这台电脑在 App 里显示的名字，也写进签名，防止签名被拿到别的机器上用
	Listen  string   `json:"listen"`  // 只听本机，外面经 tailscale serve 进来
	Origins []string `json:"origins"` // 允许的网页来源（主机名，可用 * 通配）；同源总是允许
	Command []string `json:"command"` // 每条连接开的命令，经登录 shell 启动
	Web     string   `json:"web"`     // 可选：同时提供这个目录下的网页
}

type Device struct {
	Name     string    `json:"name"`
	Key      string    `json:"key"` // Ed25519 公钥，base64url 无填充
	Added    time.Time `json:"added"`
	LastSeen time.Time `json:"lastSeen,omitzero"`
}

type Pairing struct {
	CodeHash string    `json:"codeHash"` // sha256(配对码)，十六进制
	Expires  time.Time `json:"expires"`
	Failures int       `json:"failures"`
}

func Dir() string {
	if d := os.Getenv("MOCOD_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "mocod")
}

func path(name string) string { return filepath.Join(Dir(), name) }

func Load() (Config, error) {
	host, _ := os.Hostname()
	c := Config{
		Name:    strings.TrimSuffix(host, ".local"),
		Listen:  "127.0.0.1:7681",
		Origins: []string{"localhost", "127.0.0.1"},
		Command: []string{"herdr"},
	}
	err := read("config.json", &c)
	if errors.Is(err, fs.ErrNotExist) {
		err = nil
	}
	return c, err
}

func Devices() ([]Device, error) {
	var ds []Device
	err := read("devices.json", &ds)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return ds, err
}

func SaveDevices(ds []Device) error { return write("devices.json", ds) }

// PushSub 是一台手机的推送订阅（Web Push）：agent 等人、干完活时 mocod 用它给手机发通知
type PushSub struct {
	Key      string `json:"key"`  // 哪台手机（设备公钥）；手机被 revoke 了就不再发
	Host     string `json:"host"` // 手机上给这台电脑的编号，点开通知时手机按它找电脑
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
	// 一个订阅只认一把 VAPID 密钥：手机自己生成一把，交给它连着的每台电脑
	VAPIDPublic  string `json:"vapidPublic"`
	VAPIDPrivate string `json:"vapidPrivate"`
}

func PushSubs() ([]PushSub, error) {
	var ps []PushSub
	err := read("push.json", &ps)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return ps, err
}

func SavePushSubs(ps []PushSub) error { return write("push.json", ps) }

func LoadPairing() (*Pairing, error) {
	var p Pairing
	err := read("pair.json", &p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func SavePairing(p *Pairing) error { return write("pair.json", p) }

func ClearPairing() error {
	err := os.Remove(path("pair.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func read(name string, v any) error {
	b, err := os.ReadFile(path(name))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%s: %w", path(name), err)
	}
	return nil
}

func write(name string, v any) error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(Dir(), name+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path(name))
}
