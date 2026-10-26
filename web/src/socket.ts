import { dlog } from './debug'
import { deviceKey, signChallenge } from './keys'
import type { Host } from './store'

// 到 mocod 的一条 /ws（协议见 internal/server/server.go）：握手、请求和回答、按退避重连。
// 终端（conn.ts）和 herdr 状态（herdr.ts）各开一条，各自只管握手以外的消息

export const UNAUTHORIZED = 4401
const HANDSHAKE_TIMEOUT = 10_000
const READY_WAIT = 8000
// 比 mocod 里最慢的请求（发推送，15 秒）长
const REQUEST_TIMEOUT = 20_000
export const REQUEST = 9
const enc = new TextEncoder()

export const frame = (type: number, body: string | Uint8Array) => {
	const b = typeof body === 'string' ? enc.encode(body) : body
	const out = new Uint8Array(b.length + 1)
	out[0] = type
	out.set(b, 1)
	return out
}

export type ServerMsg =
	| { type: 'challenge'; nonce: string; name: string }
	| { type: 'ready'; name: string }
	| { type: 'reply'; id: number; data?: unknown; error?: string }
	| { type: 'exit'; code: number }
	| { type: 'uploaded'; id: number; path?: string; error?: string }
	| { type: 'clipboard'; text: string }
	| { type: 'herdr'; herdr: unknown }

type Handlers = {
	hello: () => Record<string, unknown> // hello 里 type、key 以外的
	onReady: (ws: WebSocket) => void
	onClose: (e: CloseEvent) => void // 自己 shut() 的不算
	onMessage?: (msg: ServerMsg) => void // 握手和回答以外的
	onBinary?: (buf: Uint8Array) => void
}

export class MocodSocket {
	ws?: WebSocket
	private ready = false
	private waiting = new Set<() => void>()
	private tries = 0
	private timer?: number
	private seq = 0
	private requests = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void }>()

	constructor(
		readonly host: Host,
		private delays: number[],
		private h: Handlers,
	) {}

	// 有连接（连着或正在连）
	get active() {
		return !!this.ws && this.ws.readyState <= WebSocket.OPEN
	}

	open() {
		clearTimeout(this.timer)
		if (this.active) return
		const url = this.host.url.replace(/^http/, 'ws') + '/ws'
		dlog(`新建 WebSocket ${url}`)
		const ws = new WebSocket(url, ['moco.v2'])
		ws.binaryType = 'arraybuffer'
		this.ws = ws
		const guard = window.setTimeout(() => {
			if (this.ws === ws && !this.ready) {
				dlog(`握手 ${HANDSHAKE_TIMEOUT / 1000} 秒没完成（readyState=${ws.readyState}），关掉重来`)
				ws.close()
			}
		}, HANDSHAKE_TIMEOUT)
		ws.onopen = async () => {
			try {
				const { pub } = await deviceKey()
				ws.send(JSON.stringify({ type: 'hello', key: pub, ...this.h.hello() }))
			} catch (e) {
				dlog(`取设备密钥失败：${e}`)
			}
		}
		ws.onerror = () => dlog('WebSocket error')
		ws.onmessage = async e => {
			if (typeof e.data !== 'string') return this.h.onBinary?.(new Uint8Array(e.data as ArrayBuffer))
			const msg: ServerMsg = JSON.parse(e.data)
			if (msg.type === 'challenge') {
				if (msg.name !== this.host.name) return ws.close(4000, 'host mismatch')
				ws.send(JSON.stringify({ type: 'auth', sig: await signChallenge(msg.name, msg.nonce) }))
			} else if (msg.type === 'ready') {
				this.tries = 0
				this.ready = true
				this.waiting.forEach(fn => fn())
				this.waiting.clear()
				this.h.onReady(ws)
			} else if (msg.type === 'reply') {
				const r = this.requests.get(msg.id)
				this.requests.delete(msg.id)
				if (msg.error) r?.reject(new Error(msg.error))
				else r?.resolve(msg.data)
			} else {
				this.h.onMessage?.(msg)
			}
		}
		ws.onclose = e => {
			clearTimeout(guard)
			dlog(`WebSocket 关闭 code=${e.code} reason=${e.reason || '无'} clean=${e.wasClean}${this.ws !== ws ? '（旧连接，忽略）' : ''}`)
			if (this.ws !== ws) return
			this.ws = undefined
			this.dropPending()
			this.h.onClose(e)
		}
	}

	// 按退避过一会儿再试；fn 默认就是重连
	retry(fn = () => this.open()) {
		clearTimeout(this.timer)
		const wait = this.delays[Math.min(this.tries++, this.delays.length - 1)]
		dlog(`${this.host.name}：${wait}ms 后重连`)
		this.timer = window.setTimeout(fn, wait)
	}

	resetBackoff() {
		this.tries = 0
	}

	// 自己关：不回调 onClose，也不重连
	shut() {
		clearTimeout(this.timer)
		const ws = this.ws
		this.ws = undefined
		this.dropPending()
		ws?.close()
	}

	private dropPending() {
		this.ready = false
		this.requests.forEach(r => r.reject(new Error('连接断了')))
		this.requests.clear()
	}

	send(data: Uint8Array<ArrayBuffer>) {
		if (this.ready) this.ws?.send(data)
	}

	// 刚打开（点通知进来、刚打开仓库）时连接可能还在握手：等它好，最多 READY_WAIT
	private whenReady() {
		if (this.ready) return Promise.resolve()
		return new Promise<void>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer)
				resolve()
			}
			const timer = setTimeout(() => {
				this.waiting.delete(done)
				reject(new Error('还没连上'))
			}, READY_WAIT)
			this.waiting.add(done)
		})
	}

	async request<T = unknown>(op: string, body: Record<string, unknown> = {}): Promise<T> {
		await this.whenReady()
		const id = ++this.seq
		this.ws!.send(frame(REQUEST, JSON.stringify({ id, op, ...body })))
		return new Promise((resolve, reject) => {
			this.requests.set(id, { resolve: resolve as (d: unknown) => void, reject })
			setTimeout(() => {
				if (this.requests.delete(id)) reject(new Error(`mocod ${REQUEST_TIMEOUT / 1000} 秒没回答`))
			}, REQUEST_TIMEOUT)
		})
	}
}
