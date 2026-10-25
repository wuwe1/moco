import type { Terminal } from '@xterm/xterm'
import { dlog, logTo } from './debug'
import type { ImageLayer, Placement } from './images'
import { deviceKey, signChallenge } from './keys'
import type { Host } from './store'
import { wireTheme } from './theme'

export type State = 'connecting' | 'open' | 'closed' | 'unauthorized'

const DELAYS = [300, 1000, 2000, 4000]
const HANDSHAKE_TIMEOUT = 10_000
const UNAUTHORIZED = 4401
const enc = new TextEncoder()
const INPUT = 0
const RAW_OUTPUT = 0
const RESIZE = 1
const FRAME = 2
const ACK = 3
const IMAGE = 4
const PLACEMENTS = 5
const FORGET = 6
const LOG = 7
const UPLOAD = 8

type ServerMsg =
	| { type: 'challenge'; nonce: string; name: string }
	| { type: 'ready'; name: string }
	| { type: 'exit'; code: number }
	| { type: 'uploaded'; id: number; path?: string; error?: string }

const parseFrame = (buf: Uint8Array) => {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	return { seq: view.getUint32(1), cols: view.getUint16(5), rows: view.getUint16(7), body: buf.subarray(9) }
}

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
	private wakeListeners = new AbortController()
	// 自己按流解 UTF-8 再交给 xterm.js：一个字的字节可能被切在两帧里，
	// xterm.js 6.0.0 遇到 3 字节的字切在第 2 字节后会把这个字丢掉（tools/vtcheck 里查到的）
	private decoder = new TextDecoder()
	private frameDecoder = new TextDecoder()
	state: State = 'closed'
	lastClose = ''
	retries = 0
	private placementsOnNextFrame?: Placement[]
	private unlog = () => {}
	onFrameDrawn = () => {}
	private resizedAt = 0
	private uploadSeq = 0
	private uploads = new Map<number, { resolve: (path: string) => void; reject: (e: Error) => void }>()

	constructor(
		private host: Host,
		private term: Terminal,
		private onState: (s: State) => void,
		private images: ImageLayer,
	) {
		const { signal } = this.wakeListeners
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) this.hiddenAt = Date.now()
			else this.wake(Date.now() - this.hiddenAt > 10_000)
		}, { signal })
		window.addEventListener('online', () => this.wake(true), { signal })
	}

	private set(s: State) {
		this.state = s
		this.onState(s)
	}

	connect() {
		clearTimeout(this.timer)
		this.stopped = false
		if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
			dlog(`connect：已有连接 readyState=${this.ws.readyState}，不新建`)
			return
		}
		this.set('connecting')
		const url = this.host.url.replace(/^http/, 'ws') + '/ws'
		dlog(`新建 WebSocket ${url}`)
		const ws = new WebSocket(url, ['moco.v2', 'moco.v1'])
		ws.binaryType = 'arraybuffer'
		const guard = window.setTimeout(() => {
			if (this.ws === ws && this.state !== 'open') {
				dlog(`握手 ${HANDSHAKE_TIMEOUT / 1000} 秒没完成（readyState=${ws.readyState}），关掉重来`)
				ws.close()
			}
		}, HANDSHAKE_TIMEOUT)
		ws.onopen = async () => {
			dlog(`WebSocket 打开，协议 ${ws.protocol || '无'}`)
			try {
				const { pub } = await deviceKey()
				ws.send(JSON.stringify({ type: 'hello', key: pub, cols: this.term.cols, rows: this.term.rows, theme: wireTheme, cell: this.images.cellSize() }))
			} catch (e) {
				dlog(`取设备密钥失败：${e}`)
			}
		}
		ws.onerror = () => dlog('WebSocket error')
		ws.onmessage = async e => {
			if (typeof e.data !== 'string') {
				const buf = new Uint8Array(e.data as ArrayBuffer)
				const view = new DataView(buf.buffer)
				switch (buf[0]) {
					case RAW_OUTPUT:
						this.term.write(this.decoder.decode(buf.subarray(1), { stream: true }))
						break
					case FRAME:
						this.frame(ws, buf)
						break
					case IMAGE:
						this.images.add(view.getUint32(1), buf.slice(9))
						break
					case PLACEMENTS:
						this.placementsOnNextFrame = JSON.parse(this.frameDecoder.decode(buf.subarray(1)))
						break
					case FORGET:
						for (let i = 1; i + 4 <= buf.length; i += 4) this.images.forget(view.getUint32(i))
						break
				}
				return
			}
			const msg: ServerMsg = JSON.parse(e.data)
			dlog(`收到 ${msg.type}${'code' in msg ? ' code=' + msg.code : ''}`)
			if (msg.type === 'challenge') {
				if (msg.name !== this.host.name) return ws.close(4000, 'host mismatch')
				ws.send(JSON.stringify({ type: 'auth', sig: await signChallenge(msg.name, msg.nonce) }))
			} else if (msg.type === 'uploaded') {
				const u = this.uploads.get(msg.id)
				this.uploads.delete(msg.id)
				if (msg.path) u?.resolve(msg.path)
				else u?.reject(new Error(msg.error ?? '没有路径'))
			} else if (msg.type === 'ready') {
				this.tries = 0
				this.retries = 0
				this.term.reset()
				this.decoder = new TextDecoder()
				this.images.reset()
				this.placementsOnNextFrame = undefined
				this.set('open')
				this.unlog = logTo(line => ws.readyState === WebSocket.OPEN && ws.send(frame(LOG, line)))
				this.resize(this.term.cols, this.term.rows)
			}
		}
		ws.onclose = e => {
			clearTimeout(guard)
			dlog(`WebSocket 关闭 code=${e.code} reason=${e.reason || '无'} clean=${e.wasClean}${this.ws !== ws ? '（旧连接，忽略）' : ''}`)
			if (this.ws !== ws) return
			this.unlog()
			this.uploads.forEach(u => u.reject(new Error('连接断了')))
			this.uploads.clear()
			this.lastClose = e.reason ? `${e.code} ${e.reason}` : String(e.code)
			this.retries++
			if (e.code === UNAUTHORIZED) return this.set('unauthorized')
			this.set('closed')
			if (!this.stopped) {
				const wait = DELAYS[Math.min(this.tries++, DELAYS.length - 1)]
				dlog(`${wait}ms 后重连`)
				this.timer = window.setTimeout(() => this.connect(), wait)
			}
		}
		this.ws = ws
	}

	private frame(ws: WebSocket, buf: Uint8Array) {
		const { seq, cols, rows, body } = parseFrame(buf)
		const ack = () => {
			if (this.placementsOnNextFrame) {
				this.images.set(this.placementsOnNextFrame)
				this.placementsOnNextFrame = undefined
			}
			const out = new Uint8Array(5)
			out[0] = ACK
			new DataView(out.buffer).setUint32(1, seq)
			if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(out)
		}
		const drawnForOldSize = cols !== this.term.cols || rows !== this.term.rows
		if (drawnForOldSize) {
			dlog(`丢掉 ${cols}×${rows} 的一帧（现在 ${this.term.cols}×${this.term.rows}）`)
			return ack()
		}
		this.term.write(this.frameDecoder.decode(body), () => {
			if (this.resizedAt) {
				dlog(`${cols}×${rows} 的第一帧：改大小后 ${Math.round(performance.now() - this.resizedAt)}ms 画上`)
				this.resizedAt = 0
			}
			ack()
			this.onFrameDrawn()
		})
	}

	private wake(stale: boolean) {
		dlog(`wake stale=${stale} state=${this.state} readyState=${this.ws?.readyState}`)
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
		this.wakeListeners.abort()
		this.stopped = true
		clearTimeout(this.timer)
		const ws = this.ws
		this.ws = undefined
		ws?.close()
		this.set('closed')
	}

	send(data: string) {
		if (this.state === 'open') this.ws?.send(frame(INPUT, data))
	}

	upload(data: Uint8Array): Promise<string> {
		if (this.state !== 'open' || !this.ws) return Promise.reject(new Error('还没连上'))
		const id = ++this.uploadSeq
		const out = new Uint8Array(5 + data.length)
		out[0] = UPLOAD
		new DataView(out.buffer).setUint32(1, id)
		out.set(data, 5)
		this.ws.send(out)
		return new Promise((resolve, reject) => this.uploads.set(id, { resolve, reject }))
	}

	resize(cols: number, rows: number) {
		this.resizedAt = performance.now()
		if (this.state === 'open') this.ws?.send(frame(RESIZE, JSON.stringify({ cols, rows, cell: this.images.cellSize() })))
	}
}
