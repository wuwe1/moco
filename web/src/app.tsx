import { useEffect, useState } from 'preact/hooks'
import { deviceKey, fingerprint } from './keys'
import { dropSession, onSessionsChange, stateOf } from './session'
import { Sheet } from './sheet'
import { dropScreen, loadHosts, loadScreen, normalizeUrl, saveHosts, type Host } from './store'

type Health = 'checking' | 'online' | 'offline'

// 缩略图里的那一屏：去掉页面默认的白底和边距
const THUMB_STYLE = '<style>html,body{margin:0;background:#282828;overflow:hidden}pre{margin:0;padding:4px}</style>'

export function App() {
	const [hosts, setHosts] = useState(loadHosts)
	const [active, setActive] = useState<Host>()
	const [adding, setAdding] = useState<{ url?: string } | undefined>(hosts.length ? undefined : {})

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
	// 同一个地址重新配对：换掉旧的那条，它的连接也关掉
	const added = (h: Host) => {
		const replaced = hosts.filter(x => x.url === h.url)
		replaced.forEach(x => (dropSession(x.id), dropScreen(x.id)))
		update([...hosts.filter(x => x.url !== h.url), h])
		setAdding(undefined)
		setActive(h)
	}

	return (
		<>
			<Home hosts={hosts} onOpen={open} onAdd={() => setAdding({})} onRemove={remove} hidden={!!adding} />
			{adding && <Add initialUrl={adding.url} canCancel={hosts.length > 0} onCancel={() => setAdding(undefined)} onAdded={added} />}
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

function Home(props: { hosts: Host[]; hidden: boolean; onOpen: (h: Host) => void; onAdd: () => void; onRemove: (h: Host) => void }) {
	const health = useHealth(props.hosts)
	const [fp, setFp] = useState('')
	const [, bump] = useState(0)
	useEffect(() => onSessionsChange(() => bump(n => n + 1)), [])
	useEffect(() => {
		fingerprint().then(setFp, () => setFp(''))
	}, [])
	const sorted = [...props.hosts].sort((a, b) => (b.lastUsed ?? b.added) - (a.lastUsed ?? a.added))

	return (
		<main id="home" hidden={props.hidden}>
			<header class="topbar">
				<h1>moco</h1>
				<button class="icon" aria-label="添加电脑" onClick={props.onAdd}>＋</button>
			</header>
			<ul class="hosts">
				{sorted.map(h => {
					const live = stateOf(h.id)
					const dot = live === 'open' ? 'open' : health[h.id] === 'online' ? 'online' : health[h.id] === 'offline' ? 'closed' : 'connecting'
					const screen = loadScreen(h.id)
					return (
						<li key={h.id} class="host" onClick={() => props.onOpen(h)}>
							<div class="thumb">
								{screen ? (
									<iframe sandbox="" srcdoc={THUMB_STYLE + screen.html} tabIndex={-1} aria-hidden="true" />
								) : (
									<span class="empty">还没打开过</span>
								)}
							</div>
							<div class="meta">
								<span class="dot" data-state={dot} />
								<span class="name">{h.name}</span>
								<span class="addr">{new URL(h.url).hostname}</span>
								<button
									class="more"
									aria-label="删除"
									onClick={e => {
										e.stopPropagation()
										props.onRemove(h)
									}}
								>
									⋯
								</button>
							</div>
						</li>
					)
				})}
			</ul>
			{fp && <footer class="device">这台手机的密钥 {fp}</footer>}
		</main>
	)
}

function Add(props: { initialUrl?: string; canCancel: boolean; onCancel: () => void; onAdded: (h: Host) => void }) {
	const [url, setUrl] = useState(props.initialUrl ?? (location.protocol === 'https:' ? location.host : ''))
	const [code, setCode] = useState('')
	const [device, setDevice] = useState(localStorage.getItem('moco.deviceName') ?? 'iPhone')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')

	const submit = async (e: Event) => {
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
			localStorage.setItem('moco.deviceName', device)
			props.onAdded({ id: crypto.randomUUID(), name: body.name, url: base, added: Date.now() })
		} catch {
			setError(`连不上 ${url}：确认电脑上 mocod 在运行，手机开着 Tailscale。`)
		} finally {
			setBusy(false)
		}
	}

	return (
		<main id="add">
			<header class="topbar">
				{props.canCancel ? <button class="text" onClick={props.onCancel}>取消</button> : <span />}
				<h1>添加电脑</h1>
				<span />
			</header>
			<form onSubmit={submit}>
				<p class="hint">先在那台电脑上运行 <code>mocod pair</code>，它会显示一个 6 位配对码，5 分钟内有效。</p>
				<label>
					地址
					<input value={url} onInput={e => setUrl(e.currentTarget.value)} placeholder="my-mac.tailnet-name.ts.net" autocapitalize="off" autocorrect="off" spellcheck={false} inputMode="url" required />
				</label>
				<label>
					配对码
					<input value={code} onInput={e => setCode(e.currentTarget.value)} placeholder="000 000" inputMode="numeric" autocomplete="one-time-code" required />
				</label>
				<label>
					这台手机叫
					<input value={device} onInput={e => setDevice(e.currentTarget.value)} required />
				</label>
				{error && <p class="error">{error}</p>}
				<button class="primary" type="submit" disabled={busy}>{busy ? '配对中…' : '配对'}</button>
			</form>
		</main>
	)
}
