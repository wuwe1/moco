import type { Terminal } from '@xterm/xterm'
import { dlog, logTo } from './debug'
import type { ImageLayer, Placement } from './images'
import { frame, MocodSocket, UNAUTHORIZED } from './socket'
import { currentTheme, type Host } from './store'
import { wireTheme } from './themes'

export type State = 'connecting' | 'open' | 'closed' | 'unauthorized'

const DELAYS = [300, 1000, 2000, 4000]
const INPUT = 0
const RESIZE = 1
const FRAME = 2
const ACK = 3
const IMAGE = 4
const PLACEMENTS = 5
const FORGET = 6
const LOG = 7
const UPLOAD = 8

const parseFrame = (buf: Uint8Array) => {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	return { seq: view.getUint32(1), cols: view.getUint16(5), rows: view.getUint16(7), body: buf.subarray(9) }
}

export class Conn {
	private sock: MocodSocket
	private hiddenAt = 0
	private stopped = false
	private wakeListeners = new AbortController()
	private decoder = new TextDecoder()
	state: State = 'closed'
	lastClose = ''
	retries = 0
	private placementsOnNextFrame?: Placement[]
	private unlog = () => {}
	private uploadSeq = 0
	private uploads = new Map<number, { resolve: (path: string) => void; reject: (e: Error) => void }>()
	onClipboard = (_text: string) => {}

	constructor(
		host: Host,
		private term: Terminal,
		private onState: (s: State) => void,
		private images: ImageLayer,
	) {
		this.sock = new MocodSocket(host, DELAYS, {
			hello: () => ({ cols: this.term.cols, rows: this.term.rows, theme: wireTheme(currentTheme()), cell: this.images.cellSize() }),
			onReady: ws => {
				dlog('收到 ready')
				this.retries = 0
				this.term.reset()
				this.images.reset()
				this.placementsOnNextFrame = undefined
				this.set('open')
				this.unlog = logTo(line => ws.readyState === WebSocket.OPEN && ws.send(frame(LOG, line)))
				this.resize(this.term.cols, this.term.rows)
			},
			onMessage: msg => {
				dlog(`收到 ${msg.type}${'code' in msg ? ' code=' + msg.code : ''}`)
				if (msg.type === 'uploaded') {
					const u = this.uploads.get(msg.id)
					this.uploads.delete(msg.id)
					if (msg.path) u?.resolve(msg.path)
					else u?.reject(new Error(msg.error ?? '没有路径'))
				} else if (msg.type === 'clipboard') {
					this.onClipboard(msg.text)
				}
			},
			onBinary: buf => this.binary(buf),
			onClose: e => {
				this.closed()
				this.lastClose = e.reason ? `${e.code} ${e.reason}` : String(e.code)
				this.retries++
				if (e.code === UNAUTHORIZED) return this.set('unauthorized')
				this.set('closed')
				if (!this.stopped) this.sock.retry(() => this.connect())
			},
		})
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
		this.stopped = false
		if (this.sock.active) {
			dlog(`connect：已有连接 readyState=${this.sock.ws?.readyState}，不新建`)
			return
		}
		this.set('connecting')
		this.sock.open()
	}

	private closed() {
		this.unlog()
		this.uploads.forEach(p => p.reject(new Error('连接断了')))
		this.uploads.clear()
	}

	private binary(buf: Uint8Array) {
		const view = new DataView(buf.buffer)
		switch (buf[0]) {
			case FRAME:
				this.frame(buf)
				break
			case IMAGE:
				this.images.add(view.getUint32(1), buf.slice(9))
				break
			case PLACEMENTS:
				this.placementsOnNextFrame = JSON.parse(this.decoder.decode(buf.subarray(1)))
				break
			case FORGET:
				for (let i = 1; i + 4 <= buf.length; i += 4) this.images.forget(view.getUint32(i))
				break
		}
	}

	private frame(buf: Uint8Array) {
		const ws = this.sock.ws
		const { seq, cols, rows, body } = parseFrame(buf)
		const ack = () => {
			if (this.placementsOnNextFrame) {
				this.images.set(this.placementsOnNextFrame)
				this.placementsOnNextFrame = undefined
			}
			const out = new Uint8Array(5)
			out[0] = ACK
			new DataView(out.buffer).setUint32(1, seq)
			if (this.sock.ws === ws) this.sock.send(out)
		}
		const drawnForOldSize = cols !== this.term.cols || rows !== this.term.rows
		if (drawnForOldSize) {
			dlog(`丢掉 ${cols}×${rows} 的一帧（现在 ${this.term.cols}×${this.term.rows}）`)
			return ack()
		}
		this.term.write(this.decoder.decode(body), ack)
	}

	private wake(stale: boolean) {
		dlog(`wake stale=${stale} state=${this.state} readyState=${this.sock.ws?.readyState}`)
		if (this.stopped || this.state === 'unauthorized') return
		this.sock.resetBackoff()
		if (stale && this.sock.ws?.readyState === WebSocket.OPEN) {
			this.sock.shut()
			this.closed()
		}
		this.connect()
	}

	close() {
		this.wakeListeners.abort()
		this.stopped = true
		this.sock.shut()
		this.closed()
		this.set('closed')
	}

	send(data: string) {
		if (this.state === 'open') this.sock.send(frame(INPUT, data))
	}

	upload(data: Uint8Array): Promise<string> {
		if (this.state !== 'open') return Promise.reject(new Error('还没连上'))
		const id = ++this.uploadSeq
		const out = new Uint8Array(5 + data.length)
		out[0] = UPLOAD
		new DataView(out.buffer).setUint32(1, id)
		out.set(data, 5)
		this.sock.send(out)
		return new Promise((resolve, reject) => this.uploads.set(id, { resolve, reject }))
	}

	request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
		return this.sock.request<T>(op, params)
	}

	resize(cols: number, rows: number) {
		if (this.state === 'open') this.sock.send(frame(RESIZE, JSON.stringify({ cols, rows, cell: this.images.cellSize(), theme: wireTheme(currentTheme()) })))
	}
}
