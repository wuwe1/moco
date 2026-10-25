// 和 mocod 的 WebSocket（子协议 moco.v1，见 internal/server/server.go 开头）：
// hello（公钥）→ challenge（随机数、机器名）→ auth（签名）→ ready，之后二进制帧第一个字节是类型。
// 断了自己重连；mocod 用 4401 关连接说明这台手机没登记或签名不对，这时不再重连，等重新配对
import type { Terminal } from '@xterm/xterm'
import { dlog, logTo } from './debug'
import type { ImageLayer, Placement } from './images'
import { deviceKey, signChallenge } from './keys'
import type { Host } from './store'
import { wireTheme } from './theme'

export type State = 'connecting' | 'open' | 'closed' | 'unauthorized'

const DELAYS = [300, 1000, 2000, 4000]
// 握手 10 秒还没完成就当这条卡死了，关掉重来
const HANDSHAKE_TIMEOUT = 10_000
const UNAUTHORIZED = 4401
const enc = new TextEncoder()
// 二进制帧第一个字节的类型。0 手机发是键盘输入，mocod 发（v1）是终端原始输出
const DATA = 0
const RESIZE = 1
const FRAME = 2
const ACK = 3
const IMAGE = 4
const PLACEMENTS = 5
const FORGET = 6
const LOG = 7

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
	// close() 时摘掉回前台、网络恢复的监听
	private life = new AbortController()
	// 自己按流解 UTF-8 再交给 xterm.js：一个字的字节可能被切在两帧里，
	// xterm.js 6.0.0 遇到 3 字节的字切在第 2 字节后会把这个字丢掉（tools/vtcheck 里查到的）
	private decoder = new TextDecoder()
	private frameDecoder = new TextDecoder()
	state: State = 'closed'
	// 上一次断开的关闭码和原因，显示在抽屉的标题栏上，排查用
	lastClose = ''
	retries = 0
	// 下一帧画完时生效的放置（图片和那一帧的文字同时出现）
	private pendingPlacements?: Placement[]
	private unlog = () => {}

	constructor(
		private host: Host,
		private term: Terminal,
		private onState: (s: State) => void,
		private images: ImageLayer,
	) {
		const { signal } = this.life
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
		// v2：mocod 在电脑上维护画面，只发变化，手机慢了也不会堵住程序；老的 mocod 只会 v1
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
					case DATA:
						this.term.write(this.decoder.decode(buf.subarray(1), { stream: true }))
						break
					case FRAME:
						this.frame(ws, buf)
						break
					case IMAGE:
						this.images.add(view.getUint32(1), buf.slice(9))
						break
					case PLACEMENTS:
						this.pendingPlacements = JSON.parse(this.frameDecoder.decode(buf.subarray(1)))
						break
					case FORGET:
						for (let i = 1; i + 4 <= buf.length; i += 4) this.images.forget(view.getUint32(i))
						break
				}
				return
			}
			const msg = JSON.parse(e.data)
			dlog(`收到 ${msg.type}${msg.code !== undefined ? ' code=' + msg.code : ''}`)
			if (msg.type === 'challenge') {
				// 只给配对时那台机器签：签名里带机器名，名字对不上说明连错了地方
				if (msg.name !== this.host.name) return ws.close(4000, 'host mismatch')
				ws.send(JSON.stringify({ type: 'auth', sig: await signChallenge(msg.name, msg.nonce) }))
			} else if (msg.type === 'ready') {
				this.tries = 0
				this.retries = 0
				this.term.reset()
				this.decoder = new TextDecoder()
				this.images.reset()
				this.pendingPlacements = undefined
				this.set('open')
				this.unlog = logTo(line => ws.readyState === WebSocket.OPEN && ws.send(frame(LOG, line)))
				// 握手期间屏幕可能已经变过大小
				this.resize(this.term.cols, this.term.rows)
			}
		}
		ws.onclose = e => {
			clearTimeout(guard)
			dlog(`WebSocket 关闭 code=${e.code} reason=${e.reason || '无'} clean=${e.wasClean}${this.ws !== ws ? '（旧连接，忽略）' : ''}`)
			if (this.ws !== ws) return
			this.unlog()
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

	// v2 的一帧：[2][序号 u32][列 u16][行 u16][控制序列]。画完回确认，mocod 才发下一帧。
	// 尺寸和手机现在的对不上，是改尺寸之前出的帧：不画，也照样确认（改完尺寸 mocod 会整屏重发）
	private frame(ws: WebSocket, buf: Uint8Array) {
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
		const seq = view.getUint32(1)
		const cols = view.getUint16(5)
		const rows = view.getUint16(7)
		const ack = () => {
			if (this.pendingPlacements) {
				this.images.set(this.pendingPlacements)
				this.pendingPlacements = undefined
			}
			const out = new Uint8Array(5)
			out[0] = ACK
			new DataView(out.buffer).setUint32(1, seq)
			if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(out)
		}
		if (cols !== this.term.cols || rows !== this.term.rows) return ack()
		this.term.write(this.frameDecoder.decode(buf.subarray(9)), ack)
	}

	// 回到前台、网络恢复：立刻重连，不等退避。后台待久了的连接可能已经半死，直接换一条
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
		this.life.abort()
		this.stopped = true
		clearTimeout(this.timer)
		const ws = this.ws
		this.ws = undefined
		ws?.close()
		this.set('closed')
	}

	send(data: string) {
		if (this.state === 'open') this.ws?.send(frame(DATA, data))
	}

	resize(cols: number, rows: number) {
		// 带上一格的大小：改字号时它也变了，mocod 用它回答程序的 CSI 16 t
		if (this.state === 'open') this.ws?.send(frame(RESIZE, JSON.stringify({ cols, rows, cell: this.images.cellSize() })))
	}
}
