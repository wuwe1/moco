// 和 mocod 的 WebSocket（子协议 moco.v1，见 internal/server/server.go 开头）：
// hello（公钥）→ challenge（随机数、机器名）→ auth（签名）→ ready，之后二进制帧第一个字节是类型。
// 断了自己重连；mocod 用 4401 关连接说明这台手机没登记或签名不对，这时不再重连，等重新配对
import type { Terminal } from '@xterm/xterm'
import { deviceKey, signChallenge } from './keys'
import type { Host } from './store'

export type State = 'connecting' | 'open' | 'closed' | 'unauthorized'

const DELAYS = [300, 1000, 2000, 4000]
const UNAUTHORIZED = 4401
const enc = new TextEncoder()

const frame = (type: number, body: string) => {
	const b = enc.encode(body)
	const out = new Uint8Array(b.length + 1)
	out[0] = type
	out.set(b, 1)
	return out
}

export class Conn {
	private ws?: WebSocket
	private tries = 0
	private timer?: number
	private hiddenAt = 0
	private stopped = false
	state: State = 'closed'
	// 上一次断开的关闭码和原因，显示在抽屉的标题栏上，排查用
	lastClose = ''
	retries = 0

	constructor(
		private host: Host,
		private term: Terminal,
		private onState: (s: State) => void,
	) {
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) this.hiddenAt = Date.now()
			else this.wake(Date.now() - this.hiddenAt > 10_000)
		})
		window.addEventListener('online', () => this.wake(true))
	}

	private set(s: State) {
		this.state = s
		this.onState(s)
	}

	connect() {
		clearTimeout(this.timer)
		this.stopped = false
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
		this.set('connecting')
		const ws = new WebSocket(this.host.url.replace(/^http/, 'ws') + '/ws', ['moco.v1'])
		ws.binaryType = 'arraybuffer'
		ws.onopen = async () => {
			const { pub } = await deviceKey()
			ws.send(JSON.stringify({ type: 'hello', key: pub, cols: this.term.cols, rows: this.term.rows }))
		}
		ws.onmessage = async e => {
			if (typeof e.data !== 'string') {
				const buf = new Uint8Array(e.data as ArrayBuffer)
				if (buf[0] === 0) this.term.write(buf.subarray(1))
				return
			}
			const msg = JSON.parse(e.data)
			if (msg.type === 'challenge') {
				// 只给配对时那台机器签：签名里带机器名，名字对不上说明连错了地方
				if (msg.name !== this.host.name) return ws.close(4000, 'host mismatch')
				ws.send(JSON.stringify({ type: 'auth', sig: await signChallenge(msg.name, msg.nonce) }))
			} else if (msg.type === 'ready') {
				this.tries = 0
				this.retries = 0
				this.term.reset()
				this.set('open')
				// 握手期间屏幕可能已经变过大小
				this.resize(this.term.cols, this.term.rows)
			}
		}
		ws.onclose = e => {
			if (this.ws !== ws) return
			this.lastClose = e.reason ? `${e.code} ${e.reason}` : String(e.code)
			this.retries++
			if (e.code === UNAUTHORIZED) return this.set('unauthorized')
			this.set('closed')
			if (!this.stopped) this.timer = window.setTimeout(() => this.connect(), DELAYS[Math.min(this.tries++, DELAYS.length - 1)])
		}
		this.ws = ws
	}

	// 回到前台、网络恢复：立刻重连，不等退避。后台待久了的连接可能已经半死，直接换一条
	private wake(stale: boolean) {
		if (this.stopped || this.state === 'unauthorized') return
		this.tries = 0
		if (stale && this.ws?.readyState === WebSocket.OPEN) {
			const ws = this.ws
			this.ws = undefined
			ws.close()
		}
		this.connect()
	}

	close() {
		this.stopped = true
		clearTimeout(this.timer)
		const ws = this.ws
		this.ws = undefined
		ws?.close()
		this.set('closed')
	}

	send(data: string) {
		if (this.state === 'open') this.ws?.send(frame(0, data))
	}

	resize(cols: number, rows: number) {
		if (this.state === 'open') this.ws?.send(frame(1, JSON.stringify({ cols, rows })))
	}
}
