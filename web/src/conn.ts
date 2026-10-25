// 和 ttyd 的 WebSocket：协议照 ttyd 1.7 的前端（html/src/components/terminal/xterm/index.ts）
// 发：'0' + 输入、'1' + {columns, rows}；收：'0' + 输出、'1' 标题、'2' 偏好（后两个不用）
// 断了就自己重连；每次连上都是一个新的 herdr 客户端，它会把整屏重画
import type { Terminal } from '@xterm/xterm'

export type State = 'connecting' | 'open' | 'closed'

const DELAYS = [300, 1000, 2000, 4000]
const enc = new TextEncoder()

export class Conn {
	private ws?: WebSocket
	private tries = 0
	private timer?: number
	private hiddenAt = 0

	constructor(
		private url: string,
		private term: Terminal,
		private onState: (s: State) => void,
	) {
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) this.hiddenAt = Date.now()
			else this.wake(Date.now() - this.hiddenAt > 10_000)
		})
		window.addEventListener('online', () => this.wake(true))
		window.addEventListener('pageshow', e => e.persisted && this.wake(true))
	}

	connect() {
		clearTimeout(this.timer)
		const old = this.ws
		if (old && old.readyState <= WebSocket.OPEN) return
		this.onState('connecting')
		const ws = new WebSocket(this.url, ['tty'])
		ws.binaryType = 'arraybuffer'
		ws.onopen = () => {
			this.tries = 0
			this.term.reset()
			ws.send(enc.encode(JSON.stringify({ AuthToken: '', columns: this.term.cols, rows: this.term.rows })))
			this.onState('open')
		}
		ws.onmessage = e => {
			const buf = new Uint8Array(e.data as ArrayBuffer)
			if (buf[0] === 0x30) this.term.write(buf.subarray(1))
		}
		ws.onclose = () => {
			if (this.ws !== ws) return
			this.onState('closed')
			this.timer = window.setTimeout(() => this.connect(), DELAYS[Math.min(this.tries++, DELAYS.length - 1)])
		}
		this.ws = ws
	}

	// 回到前台、网络恢复：立刻重连，不等退避。后台待久了的连接可能已经半死，直接换一条
	private wake(stale: boolean) {
		this.tries = 0
		if (stale && this.ws?.readyState === WebSocket.OPEN) {
			const ws = this.ws
			this.ws = undefined
			ws.close()
		}
		this.connect()
	}

	send(data: string) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(enc.encode('0' + data))
	}

	resize(cols: number, rows: number) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(enc.encode('1' + JSON.stringify({ columns: cols, rows })))
	}
}
