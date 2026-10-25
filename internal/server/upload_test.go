package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/coder/websocket"
)

func sendUpload(ctx context.Context, c *websocket.Conn, id uint32, data []byte) {
	msg := make([]byte, 5, 5+len(data))
	msg[0] = msgUpload
	binary.BigEndian.PutUint32(msg[1:], id)
	c.Write(ctx, websocket.MessageBinary, append(msg, data...))
}

func readUploaded(t *testing.T, ctx context.Context, c *websocket.Conn) *message {
	t.Helper()
	for {
		f, m, err := readFrame(ctx, c)
		if err != nil {
			t.Fatal(err)
		}
		if m != nil && m.Type == "uploaded" {
			return m
		}
		if m == nil {
			ack(ctx, c, f.seq)
		}
	}
}

func TestUploadImage(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	ts, key, priv, _ := setupCmd(t, "cat")
	c, ctx := dialFrames(t, ts, key, priv)

	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 2<<20)...)
	sendUpload(ctx, c, 7, png)
	m := readUploaded(t, ctx, c)
	if m.ID != 7 || m.Error != "" {
		t.Fatalf("uploaded: %+v", m)
	}
	if filepath.Dir(m.Path) != filepath.Join(tmp, "moco") || filepath.Ext(m.Path) != ".png" {
		t.Fatalf("path %q", m.Path)
	}
	got, err := os.ReadFile(m.Path)
	if err != nil || !bytes.Equal(got, png) {
		t.Fatalf("file: %d bytes, %v", len(got), err)
	}

	sendUpload(ctx, c, 8, []byte("#!/bin/sh\nrm -rf ~\n"))
	m = readUploaded(t, ctx, c)
	if m.ID != 8 || m.Error == "" || m.Path != "" {
		t.Fatalf("non-image accepted: %+v", m)
	}
	if files, _ := os.ReadDir(filepath.Join(tmp, "moco")); len(files) != 1 {
		t.Fatalf("%d files in upload dir", len(files))
	}
}
