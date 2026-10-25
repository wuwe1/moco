package server

import (
	"net/http"
	"strings"
)

// 不写 Cache-Control 时 Safari 会按修改时间猜着缓存页面一阵；assets/ 的文件名带内容哈希
func (s *Server) web() http.Handler {
	if s.Cfg.Web == "" {
		return nil
	}
	files := http.FileServer(http.Dir(s.Cfg.Web))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
