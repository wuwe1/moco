import { useEffect, useState } from 'preact/hooks'
import { deviceKey, fingerprint } from './keys'
import { FONTS, type FontKey } from './fonts'
import { connOf, dropSession, setFontFamilyForAllSessions, useRerenderOnSessionChange } from './session'
import { Sheet } from './sheet'
import { deviceName, dropScreen, fontKey, loadHosts, loadScreen, normalizeUrl, saveHosts, setDeviceName, type Host } from './store'

type Health = 'checking' | 'online' | 'offline'


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
	const addReplacingSameUrl = (h: Host) => {
		const replaced = hosts.filter(x => x.url === h.url)
		replaced.forEach(x => (dropSession(x.id), dropScreen(x.id)))
		update([...hosts.filter(x => x.url !== h.url), h])
		setAdding(undefined)
		setActive(h)
	}

	return (
		<>
			<Home hosts={hosts} onOpen={open} onAdd={() => setAdding({})} onRemove={remove} hidden={!!adding} />
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

function Home(props: { hosts: Host[]; hidden: boolean; onOpen: (h: Host) => void; onAdd: () => void; onRemove: (h: Host) => void }) {
	const health = useHealth(props.hosts)
	const [fp, setFp] = useState('')
	useRerenderOnSessionChange()
	useEffect(() => {
		fingerprint().then(setFp, () => setFp(''))
	}, [])
	const sorted = [...props.hosts].sort((a, b) => (b.lastUsed ?? b.added) - (a.lastUsed ?? a.added))

	return (
		<main id="home" hidden={props.hidden}>
			<header class="topbar">
				<h1>moco{import.meta.env.DEV && <span class="dev">dev</span>}</h1>
				<button class="icon" aria-label="添加电脑" onClick={props.onAdd}>＋</button>
			</header>
			<ul class="hosts">
				{sorted.map(h => {
					const live = connOf(h.id)?.state
					const dot = live === 'open' ? 'open' : health[h.id] === 'online' ? 'online' : health[h.id] === 'offline' ? 'closed' : 'connecting'
					const screen = loadScreen(h.id)
					return (
						<li key={h.id} class="host" onClick={() => props.onOpen(h)}>
							<div class="thumb">
								{screen ? (
									<img src={screen.image} alt="" />
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
			<footer class="device">
				<FontPicker />
				{fp && <div>这台手机的密钥 {fp}</div>}
			</footer>
		</main>
	)
}

function FontPicker() {
	const [font, setFont] = useState(fontKey)
	return (
		<label class="picker">
			终端字体
			<select
				value={font}
				onChange={e => {
					const k = e.currentTarget.value as FontKey
					setFont(k)
					setFontFamilyForAllSessions(k)
				}}
			>
				{Object.entries(FONTS).map(([k, f]) => (
					<option key={k} value={k}>
						{f.label}
					</option>
				))}
			</select>
		</label>
	)
}

function Add(props: { initialUrl?: string; canCancel: boolean; onCancel: () => void; onAdded: (h: Host) => void }) {
	const [url, setUrl] = useState(props.initialUrl ?? (location.protocol === 'https:' ? location.host : ''))
	const [code, setCode] = useState('')
	const [device, setDevice] = useState(deviceName)
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
