// Package auth 认设备：配对码换来登记公钥，之后每次连接用私钥签一个随机数。
package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"time"

	"github.com/wuwe1/moco/internal/config"
)

const (
	PairTTL      = 5 * time.Minute
	pairAttempts = 5
)

var (
	ErrUnknownDevice = errors.New("unknown device")
	ErrBadSignature  = errors.New("bad signature")
	ErrNoPairing     = errors.New("no pairing code active: run `mocod pair`")
	ErrBadCode       = errors.New("wrong pairing code")
)

var b64 = base64.RawURLEncoding

// Message 是设备要签的内容：带上机器名，签名拿到别的机器上无效
func Message(name string, nonce []byte) []byte {
	return []byte("moco-auth-v1\n" + name + "\n" + b64.EncodeToString(nonce))
}

func Nonce() []byte {
	b := make([]byte, 32)
	rand.Read(b)
	return b
}

func ParseKey(s string) (ed25519.PublicKey, error) {
	b, err := b64.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("bad public key")
	}
	return ed25519.PublicKey(b), nil
}

// Find 按公钥找已登记的设备
func Find(key string) (*config.Device, error) {
	ds, err := config.Devices()
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(ds, func(d config.Device) bool { return d.Key == key })
	if i < 0 {
		return nil, ErrUnknownDevice
	}
	return &ds[i], nil
}

func Verify(key, sig string, name string, nonce []byte) error {
	pub, err := ParseKey(key)
	if err != nil {
		return err
	}
	s, err := b64.DecodeString(sig)
	if err != nil || !ed25519.Verify(pub, Message(name, nonce), s) {
		return ErrBadSignature
	}
	return nil
}

// Touch 记下设备最后一次连上的时间
func Touch(key string) {
	ds, err := config.Devices()
	if err != nil {
		return
	}
	for i := range ds {
		if ds[i].Key == key {
			ds[i].LastSeen = time.Now()
		}
	}
	config.SaveDevices(ds)
}

// NewPairing 生成 6 位配对码，存它的哈希，返回明文给命令行显示
func NewPairing() (string, time.Time, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", time.Time{}, err
	}
	code := fmt.Sprintf("%06d", n.Int64())
	exp := time.Now().Add(PairTTL)
	err = config.SavePairing(&config.Pairing{CodeHash: hash(code), Expires: exp})
	return code, exp, err
}

// Pair 用配对码登记一台设备；码只能成功用一次，错 5 次作废
func Pair(code, key, device string) error {
	if _, err := ParseKey(key); err != nil {
		return err
	}
	p, err := config.LoadPairing()
	if err != nil {
		return err
	}
	if p == nil || time.Now().After(p.Expires) {
		config.ClearPairing()
		return ErrNoPairing
	}
	if subtle.ConstantTimeCompare([]byte(hash(code)), []byte(p.CodeHash)) != 1 {
		p.Failures++
		if p.Failures >= pairAttempts {
			config.ClearPairing()
		} else {
			config.SavePairing(p)
		}
		return ErrBadCode
	}
	config.ClearPairing()

	ds, err := config.Devices()
	if err != nil {
		return err
	}
	ds = slices.DeleteFunc(ds, func(d config.Device) bool { return d.Key == key })
	if device == "" {
		device = "device"
	}
	ds = append(ds, config.Device{Name: uniqueName(ds, device), Key: key, Added: time.Now()})
	return config.SaveDevices(ds)
}

func uniqueName(ds []config.Device, name string) string {
	taken := func(n string) bool {
		return slices.ContainsFunc(ds, func(d config.Device) bool { return d.Name == n })
	}
	out := name
	for i := 2; taken(out); i++ {
		out = fmt.Sprintf("%s-%d", name, i)
	}
	return out
}

func hash(code string) string {
	h := sha256.Sum256([]byte(code))
	return hex.EncodeToString(h[:])
}
