package screen

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"testing"
)

// 拿 tools/vtcheck capture 录的真实输出量吞吐：MOCO_CAPTURE=/tmp/vtcap/h-long.jsonl go test -bench Real
func BenchmarkRealCapture(b *testing.B) {
	path := os.Getenv("MOCO_CAPTURE")
	if path == "" {
		b.Skip("set MOCO_CAPTURE to a vtcheck capture")
	}
	f, err := os.Open(path)
	if err != nil {
		b.Fatal(err)
	}
	defer f.Close()
	var chunks [][]byte
	total := 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		var r struct{ D []byte }
		json.Unmarshal(sc.Bytes(), &r)
		if r.D != nil {
			chunks = append(chunks, r.D)
			total += len(r.D)
		}
	}
	b.SetBytes(int64(total))
	for b.Loop() {
		s := New(52, 40, Theme{}, io.Discard)
		for _, c := range chunks {
			s.Write(c)
		}
		s.Close()
	}
}
