// 只管推送：收到 mocod 发来的通知就显示，点开时打开 moco、切到那个 agent。
// 不拦网络请求（没有 fetch 处理）：以前带缓存的版本怀疑让 iOS 上的 WebSocket 连不上
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
	let d = {}
	try {
		d = e.data?.json() ?? {}
	} catch {}
	e.waitUntil(self.registration.showNotification(d.title || 'moco', { body: d.body, tag: d.tag || undefined, data: d, icon: '/icon-180.png' }))
})

self.addEventListener('notificationclick', e => {
	e.notification.close()
	const { host, pane } = e.notification.data || {}
	e.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
		if (windows.length) {
			const w = windows[0]
			await w.focus()
			w.postMessage({ type: 'open', host, pane })
			return
		}
		const url = new URL('/', self.location.origin)
		if (host) url.searchParams.set('host', host)
		if (pane) url.searchParams.set('pane', pane)
		await self.clients.openWindow(url.href)
	})())
})
