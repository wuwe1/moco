import { useEffect, useState } from 'react'
import { dlog } from './debug'
import { deviceKey, signChallenge } from './keys'
import type { Host } from './store'

// 每台电脑一条只看 herdr 的连接（hello 带 watch:true，mocod 不开终端），首页和终端抽屉都从这里拿 herdr 的状态
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export type HerdrState = {
	workspaces: { id: string; label: string; number: number; status: AgentStatus; focused: boolean }[]
	tabs: { id: string; workspace: string; label: string; number: number; status: AgentStatus; focused: boolean; panes: number; zoomed: boolean }[]
	agents: { pane: string; tab: string; workspace: string; name: string; status: AgentStatus; title: string; cwd: string; focused: boolean }[]
	workspace: string
	tab: string
	pane: string
}

const REQUEST = 9
const UNAUTHORIZED = 4401
const REQUEST_TIMEOUT = 10_000
const DELAYS = [1000, 2000, 5000, 10_000]
const enc = new TextEncoder()

class Watch {
	state: HerdrState | null = null
	private ws?: WebSocket
	private tries = 0
	private timer?: number
	private stopped = false
	private seq = 0
	private requests = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void }>()
	private visibility = () => (document.hidden ? this.disconnect() : this.connect())

	constructor(readonly host: Host) {
		document.addEventListener('visibilitychange', this.visibility)
		this.connect()
	}

	private async connect() {
		clearTimeout(this.timer)
		if (this.stopped || document.hidden || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return
		try {
			const health = await fetch(`${this.host.url}/health`, { signal: AbortSignal.timeout(4000) }).then(r => r.json())
			if (!health.features?.includes('watch')) return dlog(`${this.host.name} 的 mocod 太旧，看不了 herdr`)
		} catch {
			return this.retry()
		}
		if (this.stopped || document.hidden || this.ws) return
		const ws = new WebSocket(this.host.url.replace(/^http/, 'ws') + '/ws', ['moco.v2'])
		this.ws = ws
		ws.onopen = async () => {
			const { pub } = await deviceKey()
			ws.send(JSON.stringify({ type: 'hello', key: pub, watch: true }))
		}
		ws.onmessage = async e => {
			if (typeof e.data !== 'string') return
			const msg = JSON.parse(e.data)
			if (msg.type === 'challenge') {
				if (msg.name !== this.host.name) return ws.close(4000, 'host mismatch')
				ws.send(JSON.stringify({ type: 'auth', sig: await signChallenge(msg.name, msg.nonce) }))
			} else if (msg.type === 'ready') {
				this.tries = 0
			} else if (msg.type === 'herdr') {
				this.state = msg.herdr
				changed()
			} else if (msg.type === 'reply') {
				const r = this.requests.get(msg.id)
				this.requests.delete(msg.id)
				if (msg.error) r?.reject(new Error(msg.error))
				else r?.resolve(msg.data)
			}
		}
		ws.onclose = e => {
			if (this.ws !== ws) return
			this.ws = undefined
			this.requests.forEach(r => r.reject(new Error('连接断了')))
			this.requests.clear()
			if (e.code === UNAUTHORIZED) this.stopped = true
			this.retry()
		}
	}

	private retry() {
		if (this.stopped || document.hidden) return
		this.timer = window.setTimeout(() => this.connect(), DELAYS[Math.min(this.tries++, DELAYS.length - 1)])
	}

	private disconnect() {
		clearTimeout(this.timer)
		const ws = this.ws
		this.ws = undefined
		ws?.close()
	}

	call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const ws = this.ws
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('还没连上'))
		const id = ++this.seq
		const body = enc.encode(JSON.stringify({ id, op: 'herdr', method, params }))
		const out = new Uint8Array(body.length + 1)
		out[0] = REQUEST
		out.set(body, 1)
		ws.send(out)
		return new Promise((resolve, reject) => {
			this.requests.set(id, { resolve: resolve as (d: unknown) => void, reject })
			setTimeout(() => this.requests.delete(id) && reject(new Error('mocod 没回答')), REQUEST_TIMEOUT)
		})
	}

	close() {
		this.stopped = true
		document.removeEventListener('visibilitychange', this.visibility)
		this.disconnect()
		this.state = null
	}
}

const watches = new Map<string, Watch>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(fn => fn())

// 首页上有哪些电脑就开哪些；删掉的关掉。换了地址或名字（重新配对）算新的
export function watchHosts(hosts: Host[]) {
	const keep = new Set(hosts.map(h => h.id))
	for (const [id, w] of watches) {
		if (!keep.has(id)) {
			w.close()
			watches.delete(id)
		}
	}
	for (const h of hosts) if (!watches.has(h.id)) watches.set(h.id, new Watch(h))
	changed()
}

export const herdrOf = (hostId: string | undefined) => (hostId ? watches.get(hostId) : undefined)

export function useHerdr(hostId: string | undefined): HerdrState | null {
	const [, bump] = useState(0)
	useEffect(() => {
		const fn = () => bump(n => n + 1)
		listeners.add(fn)
		return () => void listeners.delete(fn)
	}, [])
	return herdrOf(hostId)?.state ?? null
}

export const agentsIn = (st: HerdrState, tabId: string) => st.agents.filter(a => a.tab === tabId)

// 当前 workspace 的 tab，按编号排
export const tabsOfFocused = (st: HerdrState) => st.tabs.filter(t => t.workspace === st.workspace).sort((a, b) => a.number - b.number)
