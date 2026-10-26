package auth

import (
	"crypto/ed25519"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/wuwe1/moco/internal/config"
)

// 整个包的测试都在一个临时的 MOCOD_HOME 里跑。每个测试的 t.Setenv 结束时还原成它，而不是用户真的 ~/.config/mocod：
// 测试结束后还没跑完的协程（比如连上时记最后连接时间的 auth.Touch）不会写坏用户的设备名单
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "mocod-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("MOCOD_HOME", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func newKey(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return b64.EncodeToString(pub), priv
}

func TestPairThenVerify(t *testing.T) {
	t.Setenv("MOCOD_HOME", t.TempDir())
	key, priv := newKey(t)

	code, _, err := NewPairing()
	if err != nil {
		t.Fatal(err)
	}
	if err := Pair(code, key, "iphone"); err != nil {
		t.Fatalf("pair: %v", err)
	}
	if err := Pair(code, key, "iphone"); !errors.Is(err, ErrNoPairing) {
		t.Fatalf("code reused: got %v", err)
	}
	if _, err := Find(key); err != nil {
		t.Fatalf("find: %v", err)
	}

	nonce := Nonce()
	sig := b64.EncodeToString(ed25519.Sign(priv, Message("tidbit", nonce)))
	if err := Verify(key, sig, "tidbit", nonce); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if err := Verify(key, sig, "other-host", nonce); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("signature for another host accepted: %v", err)
	}
	if err := Verify(key, sig, "tidbit", Nonce()); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("signature for another nonce accepted: %v", err)
	}
}

func TestPairWrongCodeBurnsAfterFive(t *testing.T) {
	t.Setenv("MOCOD_HOME", t.TempDir())
	key, _ := newKey(t)
	code, _, _ := NewPairing()
	wrong := "000000"
	if code == wrong {
		wrong = "111111"
	}
	for i := range 5 {
		if err := Pair(wrong, key, "x"); !errors.Is(err, ErrBadCode) {
			t.Fatalf("attempt %d: got %v", i, err)
		}
	}
	if err := Pair(code, key, "x"); !errors.Is(err, ErrNoPairing) {
		t.Fatalf("right code after 5 failures should be dead, got %v", err)
	}
}

func TestPairExpired(t *testing.T) {
	t.Setenv("MOCOD_HOME", t.TempDir())
	key, _ := newKey(t)
	config.SavePairing(&config.Pairing{CodeHash: hash("123456"), Expires: time.Now().Add(-time.Second)})
	if err := Pair("123456", key, "x"); !errors.Is(err, ErrNoPairing) {
		t.Fatalf("expired code accepted: %v", err)
	}
}

func TestDuplicateNames(t *testing.T) {
	t.Setenv("MOCOD_HOME", t.TempDir())
	for range 2 {
		key, _ := newKey(t)
		code, _, _ := NewPairing()
		if err := Pair(code, key, "iphone"); err != nil {
			t.Fatal(err)
		}
	}
	ds, _ := config.Devices()
	if len(ds) != 2 || ds[1].Name != "iphone-2" {
		t.Fatalf("devices: %+v", ds)
	}
}
