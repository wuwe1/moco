// 先取网上的，取不到（离线、电脑没开）用上次存的：首页总能打开
const CACHE = 'moco-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icon-180.png', '/icon.svg']

self.addEventListener('install', e => {
	e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
	e.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
			.then(() => self.clients.claim()),
	)
})
self.addEventListener('fetch', e => {
	const url = new URL(e.request.url)
	if (e.request.method !== 'GET' || url.origin !== location.origin) return
	if (!SHELL.includes(url.pathname) && e.request.mode !== 'navigate') return
	const key = e.request.mode === 'navigate' ? '/' : url.pathname
	e.respondWith(
		fetch(e.request)
			.then(res => {
				if (res.ok) {
					const copy = res.clone()
					caches.open(CACHE).then(c => c.put(key, copy))
				}
				return res
			})
			.catch(() => caches.match(key)),
	)
})
