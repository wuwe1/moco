import { useEffect, useRef, useState } from 'preact/hooks'
import type { Conn, State } from './conn'
import { debugLines, onDebug } from './debug'
import { KEYS, keyboard } from './keyboard'
import { Lightbox, type Picture } from './lightbox'
import { connOf, getOrCreateSession, useRerenderOnSessionChange, type Session } from './session'
import type { Host } from './store'

const KEYBOARD_MIN_PX = 80
const CLOSE_DRAG_PX = 120
const FLING_MIN_PX = 30
const FLING_PX_PER_MS = 0.6
const TAP_SLOP_PX = 6

const STATUS: Record<State, string> = {
	open: '已连接',
	connecting: '连接中',
	closed: '已断开，重连中',
	unauthorized: '这台手机没登记',
}

function status(state: State, c?: Conn) {
	if (state === 'closed' && c?.lastClose) return `已断开 ${c.lastClose}，第 ${c.retries} 次重连`
	if (state === 'connecting' && c?.retries) return `连接中（上次 ${c.lastClose}，第 ${c.retries} 次）`
	return STATUS[state]
}

export function Sheet(props: { host?: Host; onClose: () => void; onRepair: (h: Host) => void }) {
	const { host } = props
	const root = useRef<HTMLDivElement>(null)
	const sessionMount = useRef<HTMLDivElement>(null)
	const current = useRef<Session | undefined>(undefined)
	const kb = useRef<ReturnType<typeof keyboard> | undefined>(undefined)
	const [drag, setDrag] = useState(0)
	const [debug, setDebug] = useState(false)
	const [picture, setPicture] = useState<Picture>()
	const [pasting, setPasting] = useState(false)
	const [, bump] = useState(0)
	useEffect(() => (debug ? onDebug(() => bump(n => n + 1)) : undefined), [debug])
	useRerenderOnSessionChange()

	useEffect(() => {
		kb.current = keyboard(root.current!, () => current.current?.term, s => current.current?.conn.send(s), () => setPasting(true))
	}, [])

	useEffect(() => {
		const prev = current.current
		if (prev && prev.host.id !== host?.id) prev.detach()
		if (!host) {
			kb.current?.blur()
			current.current = undefined
			return
		}
		const s = getOrCreateSession(host)
		s.onPlainTap = () => kb.current?.focus()
		s.onImage = img => {
			kb.current?.blur()
			setPicture(img)
		}
		current.current = s
		requestAnimationFrame(() => s.attach(sessionMount.current!))
	}, [host?.id])

	// 键盘弹出时界面只剩 visualViewport 那么高：抽屉缩到键盘上方，终端重算行列
	useEffect(() => {
		const vv = window.visualViewport
		const layout = () => {
			const el = root.current!
			const h = vv ? vv.height : window.innerHeight
			el.style.height = `${h}px`
			el.style.setProperty('--vv-top', `${vv ? vv.offsetTop : 0}px`)
			const keyboardOpen = h < window.innerHeight - KEYBOARD_MIN_PX
			el.style.setProperty('--safe-bottom', keyboardOpen ? '0px' : 'env(safe-area-inset-bottom)')
			current.current?.fitNow()
		}
		vv?.addEventListener('resize', layout)
		vv?.addEventListener('scroll', layout)
		window.addEventListener('resize', layout)
		layout()
		return () => {
			vv?.removeEventListener('resize', layout)
			vv?.removeEventListener('scroll', layout)
			window.removeEventListener('resize', layout)
		}
	}, [])

	const grab = useRef({ y: 0, t: 0, active: false, onStatus: false })
	const down = (e: PointerEvent) => {
		grab.current = { y: e.clientY, t: e.timeStamp, active: true, onStatus: !!(e.target as HTMLElement).closest('.status') }
		;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
	}
	const move = (e: PointerEvent) => {
		if (grab.current.active) setDrag(Math.max(0, e.clientY - grab.current.y))
	}
	const up = (e: PointerEvent) => {
		if (!grab.current.active) return
		grab.current.active = false
		const dy = e.clientY - grab.current.y
		const v = dy / Math.max(1, e.timeStamp - grab.current.t)
		setDrag(0)
		if (Math.abs(dy) < TAP_SLOP_PX && grab.current.onStatus) return setDebug(d => !d)
		if (dy > CLOSE_DRAG_PX || (dy > FLING_MIN_PX && v > FLING_PX_PER_MS)) {
			current.current?.snapshot()
			props.onClose()
		}
	}

	const conn = host && connOf(host.id)
	const state = conn?.state ?? 'connecting'
	return (
		<div
			id="sheet"
			ref={root}
			class={`${host ? 'open' : ''} ${drag ? 'dragging' : ''}`}
			style={{ '--drag': `${drag}px` }}
		>
			<header id="grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
				<span class="grabber" />
				<span class="dot" data-state={state} />
				<span class="title">{host?.name}</span>
				<span class="status">{status(state, conn)}</span>
			</header>
			<div id="panes" ref={sessionMount} />
			{debug && (
				<pre class="debug" onClick={() => setDebug(false)}>
					{debugLines().join('\n')}
				</pre>
			)}
			{state === 'unauthorized' && host && (
				<div class="notice">
					<p>{host.name} 不认这台手机：还没配对，或者在电脑上被 <code>mocod revoke</code> 删掉了。</p>
					<button class="primary" onClick={() => props.onRepair(host)}>重新配对</button>
				</div>
			)}
			{pasting && (
				<PasteBox
					onSend={text => {
						setPasting(false)
						kb.current?.paste(text)
					}}
					onCancel={() => setPasting(false)}
				/>
			)}
			<div id="compose" hidden />
			<div id="bar">
				<div id="keys">
					{KEYS.map(k => (
						<button key={k.id} data-key={k.id} aria-pressed={k.kind === 'ctrl' ? 'false' : undefined}>
							{k.label}
						</button>
					))}
				</div>
				<button id="kbd" aria-label="键盘">⌨</button>
				<textarea id="input" rows={1} autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck={false} />
			</div>
			{picture && <Lightbox img={picture} onClose={() => setPicture(undefined)} />}
		</div>
	)
}

function PasteBox(props: { onSend: (text: string) => void; onCancel: () => void }) {
	const [text, setText] = useState('')
	return (
		<form
			class="pastebox"
			onSubmit={e => {
				e.preventDefault()
				if (text) props.onSend(text)
			}}
		>
			<textarea
				value={text}
				onInput={e => setText((e.target as HTMLTextAreaElement).value)}
				placeholder="读不到剪贴板。长按这里选「粘贴」"
				rows={4}
				autocapitalize="off"
				autocomplete="off"
				autocorrect="off"
				spellcheck={false}
			/>
			<div class="row">
				<span class="count">{text ? `${text.split('\n').length} 行` : ''}</span>
				<button type="button" onClick={props.onCancel}>取消</button>
				<button type="submit" class="send" disabled={!text}>发送</button>
			</div>
		</form>
	)
}
