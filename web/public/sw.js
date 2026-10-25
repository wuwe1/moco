// 暂时不用 Service Worker（怀疑它让 iOS 上的 WebSocket 连不上）：
// 已经装在手机上的旧版本更新到这一版后，把自己注销，再刷新一次页面
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => {
	e.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.map(k => caches.delete(k))))
			.then(() => self.registration.unregister())
			.then(() => self.clients.matchAll({ type: 'window' }))
			.then(clients => clients.forEach(c => c.navigate(c.url))),
	)
})
