import { useEffect, useState } from 'react'
import { dlog } from './debug'
import { MocodSocket, UNAUTHORIZED } from './socket'
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

const DELAYS = [1000, 2000, 5000, 10_000]

export class Watch {
	// undefined：还不知道；null：herdr 没开
	state: HerdrState | null | undefined
	tooOld = false
	features: string[] = []
	private stopped = false
	private sock: MocodSocket
	private visibility = () => (document.hidden ? this.sock.shut() : this.connect())

	constructor(readonly host: Host) {
		this.sock = new MocodSocket(host, DELAYS, {
			hello: () => ({ watch: true }),
			onReady: () => readyHooks.forEach(fn => fn(this)),
			onMessage: msg => {
				if (msg.type !== 'herdr') return
				this.state = msg.herdr as HerdrState | null
				changed()
			},
			onClose: e => {
				if (e.code === UNAUTHORIZED) this.stopped = true
				this.retry()
			},
		})
		document.addEventListener('visibilitychange', this.visibility)
		this.connect()
	}

	private async connect() {
		if (this.stopped || document.hidden || this.sock.active) return
		try {
			const health = await fetch(`${this.host.url}/health`, { signal: AbortSignal.timeout(4000) }).then(r => r.json())
			this.features = health.features ?? []
			this.tooOld = !this.features.includes('watch')
			if (this.tooOld) {
				dlog(`${this.host.name} 的 mocod 太旧，看不了 herdr`)
				return changed()
			}
		} catch {
			return this.retry()
		}
		if (this.stopped || document.hidden) return
		this.sock.open()
	}

	private retry() {
		if (!this.stopped && !document.hidden) this.sock.retry(() => this.connect())
	}

	call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		return this.request<T>('herdr', { method, params })
	}

	request<T = unknown>(op: string, body: Record<string, unknown> = {}): Promise<T> {
		return this.sock.request<T>(op, body)
	}

	close() {
		this.stopped = true
		document.removeEventListener('visibilitychange', this.visibility)
		this.sock.shut()
		this.state = undefined
	}
}

const watches = new Map<string, Watch>()
const readyHooks = new Set<(w: Watch) => void>()

// 每次连上（包括重连）都调：推送用它把订阅交给新加的电脑
export const onWatchReady = (fn: (w: Watch) => void) => void readyHooks.add(fn)
export const allWatches = () => [...watches.values()]
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

export function useHerdr(hostId: string | undefined): HerdrState | null | undefined {
	const [, bump] = useState(0)
	useEffect(() => {
		const fn = () => bump(n => n + 1)
		listeners.add(fn)
		return () => void listeners.delete(fn)
	}, [])
	return herdrOf(hostId)?.state
}

export const agentsIn = (st: HerdrState, tabId: string) => st.agents.filter(a => a.tab === tabId)

// 当前 workspace 的 tab，按编号排
export const tabsOfFocused = (st: HerdrState) => st.tabs.filter(t => t.workspace === st.workspace).sort((a, b) => a.number - b.number)
