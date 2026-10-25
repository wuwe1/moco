import { useEffect, useState, type FormEvent } from 'react'
import { deviceKey } from './keys'
import { Ellipsis, Plus, Settings } from 'lucide-react'
import { connOf, dropSession, useRerenderOnSessionChange } from './session'
import { SettingsPage } from './settings'
import { Sheet } from './sheet'
import { deviceName, dropScreen, loadHosts, loadScreen, normalizeUrl, saveHosts, setDeviceName, type Host } from './store'

type Health = 'checking' | 'online' | 'offline'


export function App() {
	const [hosts, setHosts] = useState(loadHosts)
	const [active, setActive] = useState<Host>()
	const [adding, setAdding] = useState<{ url?: string } | undefined>(hosts.length ? undefined : {})
	const [settings, setSettings] = useState(false)

	const update = (next: Host[]) => {
		saveHosts(next)
		setHosts(next)
	}
	const open = (h: Host) => {
		update(hosts.map(x => (x.id === h.id ? { ...x, lastUsed: Date.now() } : x)))
		setActive(h)
	}
	const remove = (h: Host) => {
		if (!confirm(`删除 ${h.name}？之后要连它得重新配对。`)) return
		dropSession(h.id)
		dropScreen(h.id)
		update(hosts.filter(x => x.id !== h.id))
	}
	const addReplacingSameUrl = (h: Host) => {
		const replaced = hosts.filter(x => x.url === h.url)
		replaced.forEach(x => (dropSession(x.id), dropScreen(x.id)))
		update([...hosts.filter(x => x.url !== h.url), h])
		setAdding(undefined)
		setActive(h)
	}

	return (
		<>
			<Home hosts={hosts} onOpen={open} onAdd={() => setAdding({})} onRemove={remove} onSettings={() => setSettings(true)} hidden={!!adding || settings} />
			{settings && <SettingsPage onBack={() => setSettings(false)} />}
			{adding && <Add initialUrl={adding.url} canCancel={hosts.length > 0} onCancel={() => setAdding(undefined)} onAdded={addReplacingSameUrl} />}
			<Sheet
				host={active}
				onClose={() => setActive(undefined)}
				onRepair={h => {
					setActive(undefined)
					setAdding({ url: h.url })
				}}
			/>
		</>
	)
}

function useHealth(hosts: Host[]) {
	const [health, setHealth] = useState<Record<string, Health>>({})
	useEffect(() => {
		const check = () => {
			if (document.hidden) return
			for (const h of hosts) {
				fetch(`${h.url}/health`, { signal: AbortSignal.timeout(4000) })
					.then(r => (r.ok ? 'online' : 'offline'))
					.catch(() => 'offline' as const)
					.then(s => setHealth(m => ({ ...m, [h.id]: s })))
			}
		}
		check()
		const t = setInterval(check, 30_000)
		document.addEventListener('visibilitychange', check)
		return () => {
			clearInterval(t)
			document.removeEventListener('visibilitychange', check)
		}
	}, [hosts])
	return health
}

function Home(props: {
	hosts: Host[]
	hidden: boolean
	onOpen: (h: Host) => void
	onAdd: () => void
	onRemove: (h: Host) => void
	onSettings: () => void
}) {
	const health = useHealth(props.hosts)
	useRerenderOnSessionChange()
	const sorted = [...props.hosts].sort((a, b) => (b.lastUsed ?? b.added) - (a.lastUsed ?? a.added))

	return (
		<main id="home" hidden={props.hidden}>
			<header className="topbar">
				<h1>moco{import.meta.env.DEV && <span className="dev">dev</span>}</h1>
				<div className="actions">
					<button className="round" aria-label="设置" onClick={props.onSettings}>
						<Settings size={20} />
					</button>
					<button className="round" aria-label="添加电脑" onClick={props.onAdd}>
						<Plus size={20} />
					</button>
				</div>
			</header>
			<h2 className="section">电脑</h2>
			<ul className="hosts">
				{sorted.map(h => {
					const live = connOf(h.id)?.state
					const dot = live === 'open' ? 'open' : health[h.id] === 'online' ? 'online' : health[h.id] === 'offline' ? 'closed' : 'connecting'
					const screen = loadScreen(h.id)
					return (
						<li key={h.id} className="host" onClick={() => props.onOpen(h)}>
							<div className="thumb">{screen ? <img src={screen.image} alt="" /> : <span className="empty">还没打开过</span>}</div>
							<div className="meta">
								<span className="dot" data-state={dot} />
								<span className="name">{h.name}</span>
								<button
									className="more"
									aria-label="删除"
									onClick={e => {
										e.stopPropagation()
										props.onRemove(h)
									}}
								>
									<Ellipsis size={18} />
								</button>
							</div>
							<div className="addr">{new URL(h.url).hostname}</div>
						</li>
					)
				})}
			</ul>
		</main>
	)
}

function Add(props: { initialUrl?: string; canCancel: boolean; onCancel: () => void; onAdded: (h: Host) => void }) {
	const [url, setUrl] = useState(props.initialUrl ?? (location.protocol === 'https:' ? location.host : ''))
	const [code, setCode] = useState('')
	const [device, setDevice] = useState(deviceName)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')

	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setError('')
		if (!crypto.subtle) return setError('这个页面不是 HTTPS，浏览器不给生成密钥。请从 https 地址打开 moco。')
		let base: string
		try {
			base = normalizeUrl(url)
		} catch {
			return setError('地址看不懂，填电脑在 Tailscale 里的名字，例如 my-mac.tailnet-name.ts.net')
		}
		setBusy(true)
		try {
			const { pub } = await deviceKey()
			const res = await fetch(`${base}/pair`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: code.replace(/\D/g, ''), key: pub, device }),
				signal: AbortSignal.timeout(8000),
			})
			const body = await res.json().catch(() => ({}))
			if (!res.ok) {
				setError(res.status === 403 ? '配对码不对或已过期：在电脑上重新运行 mocod pair。' : `配对失败：${body.error ?? res.status}`)
				return
			}
			setDeviceName(device)
			props.onAdded({ id: crypto.randomUUID(), name: body.name, url: base, added: Date.now() })
		} catch {
			setError(`连不上 ${url}：确认电脑上 mocod 在运行，手机开着 Tailscale。`)
		} finally {
			setBusy(false)
		}
	}

	return (
		<main id="add">
			<header className="topbar">
				{props.canCancel ? <button className="text" onClick={props.onCancel}>取消</button> : <span />}
				<h1>添加电脑</h1>
				<span />
			</header>
			<form onSubmit={submit}>
				<p className="hint">先在那台电脑上运行 <code>mocod pair</code>，它会显示一个 6 位配对码，5 分钟内有效。</p>
				<label>
					地址
					<input value={url} onChange={e => setUrl(e.currentTarget.value)} placeholder="my-mac.tailnet-name.ts.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" required />
				</label>
				<label>
					配对码
					<input value={code} onChange={e => setCode(e.currentTarget.value)} placeholder="000 000" inputMode="numeric" autoComplete="one-time-code" required />
				</label>
				<label>
					这台手机叫
					<input value={device} onChange={e => setDevice(e.currentTarget.value)} required />
				</label>
				{error && <p className="error">{error}</p>}
				<button className="primary" type="submit" disabled={busy}>{busy ? '配对中…' : '配对'}</button>
			</form>
		</main>
	)
}
