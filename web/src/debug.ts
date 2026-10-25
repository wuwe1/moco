// 连接日志：最近 200 条，点抽屉标题栏上的状态文字就能看，手机上排查连不上用。
// 连上了也发给 mocod 记进它的日志，在电脑上就能看到手机这边出了什么事
const lines: string[] = []
const listeners = new Set<() => void>()
// 还没发给 mocod 的
let unsent: string[] = []
let sink: ((line: string) => void) | undefined

export function dlog(msg: string) {
	const d = new Date()
	const t = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0')
	lines.push(`${t} ${msg}`)
	if (lines.length > 200) lines.shift()
	if (sink) sink(msg)
	else unsent = [...unsent.slice(-99), `${t} ${msg}`]
	listeners.forEach(fn => fn())
}

// 连上 mocod 时接上，先补发断开期间的；返回的函数断开时调用
export function logTo(fn: (line: string) => void) {
	sink = fn
	unsent.forEach(fn)
	unsent = []
	return () => {
		if (sink === fn) sink = undefined
	}
}

export const debugLines = () => lines
export const onDebug = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn))

document.addEventListener('visibilitychange', () => dlog(document.hidden ? '页面切到后台' : '页面回到前台'))
window.addEventListener('online', () => dlog('网络：online'))
window.addEventListener('offline', () => dlog('网络：offline'))
window.addEventListener('pageshow', e => dlog(`pageshow persisted=${e.persisted}`))
window.addEventListener('error', e => dlog(`页面错误：${e.message}`))
window.addEventListener('unhandledrejection', e => dlog(`未处理的 Promise 错误：${e.reason}`))
dlog(`页面打开 ${navigator.userAgent.replace(/^.*?\) /, '')}`)
