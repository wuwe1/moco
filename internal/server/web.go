package server

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// web 提供网页：配了 Dev 就转给 Vite 开发服务（含 HMR 的 WebSocket），改了代码手机上直接更新；
// Vite 没开时退回到 Web 目录里打好的包
func (s *Server) web() http.Handler {
	var files http.Handler
	if s.Cfg.Web != "" {
		files = noCache(http.FileServer(http.Dir(s.Cfg.Web)))
	}
	if s.Cfg.Dev == "" {
		return files
	}
	target, err := url.Parse(s.Cfg.Dev)
	if err != nil {
		s.Log.Warn("bad dev url", "dev", s.Cfg.Dev, "err", err)
		return files
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		if files == nil {
			http.Error(w, "dev server unreachable: "+err.Error(), http.StatusBadGateway)
			return
		}
		files.ServeHTTP(w, r)
	}
	return proxy
}

// 页面本身每次都问一下有没有新的（不然 Safari 会按修改时间猜着缓存一阵）；
// assets/ 下的文件名带内容哈希，可以一直缓存
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		h.ServeHTTP(w, r)
	})
}
