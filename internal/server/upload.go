package server

import (
	"context"
	"encoding/binary"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const maxUpload = 16 << 20

var uploadExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}

func saveUpload(data []byte) (string, error) {
	ext, ok := uploadExt[http.DetectContentType(data)]
	if !ok {
		return "", errors.New("not an image")
	}
	dir := filepath.Join(os.TempDir(), "moco")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, time.Now().Format("20060102-150405-*")+ext)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), f.Close()
}

func (s *Server) upload(ctx context.Context, c *websocket.Conn, data []byte) {
	if len(data) < 5 {
		return
	}
	reply := message{Type: "uploaded", ID: binary.BigEndian.Uint32(data[1:])}
	path, err := saveUpload(data[5:])
	if err != nil {
		reply.Error = err.Error()
		s.Log.Warn("upload failed", "bytes", len(data)-5, "err", err)
	} else {
		reply.Path = path
		s.Log.Info("upload saved", "path", path, "bytes", len(data)-5)
	}
	wsjson.Write(ctx, c, reply)
}
