import { useEffect, useRef, useState } from 'preact/hooks'
import type { Conn, State } from './conn'
import { debugLines, dlog, onDebug } from './debug'
import { Keyboard, KeyboardOff } from 'lucide-preact'
import { KEYS, keyboard } from './keyboard'
import { Lightbox, type Picture } from './lightbox'
import { shrinkImage } from './shrink'
import { connOf, getOrCreateSession, useRerenderOnSessionChange, type Session } from './session'
import { KEYBOARD_MODES, keyboardMode, type Host } from './store'

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
	const [typing, setTyping] = useState(false)
	const [toast, setToast] = useState<string>()
	const picker = useRef<HTMLInputElement>(null)
	const sendImage = async (file: File) => {
		const conn = current.current?.conn
		if (!conn) return
		setToast('图片上传中…')
		try {
			const path = await conn.upload(await shrinkImage(file))
			dlog(`图片传到 ${path}`)
			setToast(undefined)
			kb.current?.paste(path + ' ')
		} catch (e) {
			dlog(`图片没传上去：${e}`)
			setToast(`图片没传上去：${e instanceof Error ? e.message : e}`)
			setTimeout(() => setToast(undefined), TOAST_MS)
		}
	}
	const [, bump] = useState(0)
	useEffect(() => (debug ? onDebug(() => bump(n => n + 1)) : undefined), [debug])
	useRerenderOnSessionChange()

	useEffect(() => {
		kb.current = keyboard(root.current!, {
			term: () => current.current?.term,
			send: s => current.current?.conn.send(s),
			onPasteFailed: () => setPasting(true),
			onPickImage: () => picker.current?.click(),
		})
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
		let lastH = 0
		const layout = () => {
			const el = root.current!
			const h = vv ? vv.height : window.innerHeight
			if (h !== lastH) dlog(`可视高度 ${lastH} → ${h}，offsetTop ${vv?.offsetTop ?? 0}，innerHeight ${window.innerHeight}，${KEYBOARD_MODES[keyboardMode()]}`)
			lastH = h
			el.style.height = `${h}px`
			el.style.setProperty('--vv-top', `${vv ? vv.offsetTop : 0}px`)
			const keyboardOpen = h < window.innerHeight - KEYBOARD_MIN_PX
			el.style.setProperty('--safe-bottom', keyboardOpen ? '0px' : 'env(safe-area-inset-bottom)')
			current.current?.layout(keyboardOpen)
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
		if (Math.abs(dy) < TAP_SLOP_PX && grab.current.onStatus) {
			if (!debug && current.current) dlog(`光标行：${current.current.describeCursorRow()}`)
			return setDebug(d => !d)
		}
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
			{toast && <div class="toast">{toast}</div>}
			<input
				ref={picker}
				type="file"
				accept="image/*"
				hidden
				onChange={e => {
					const file = e.currentTarget.files?.[0]
					e.currentTarget.value = ''
					if (file) sendImage(file)
				}}
			/>
			<div id="compose" hidden />
			<div id="bar">
				<div id="keys">{KEYS.filter(k => !k.pinned).map(keyButton)}</div>
				{KEYS.filter(k => k.pinned).map(keyButton)}
				<button id="kbd" aria-label={typing ? '收起键盘' : '弹出键盘'}>
					{typing ? <KeyboardOff size={ICON_PX} /> : <Keyboard size={ICON_PX} />}
				</button>
				<textarea
					id="input"
					rows={1}
					autocapitalize="off"
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					onFocus={() => {
						dlog('输入框拿到焦点')
						setTyping(true)
					}}
					onBlur={e => {
						const to = e.relatedTarget as HTMLElement | null
						dlog(`输入框失去焦点，焦点去了 ${to ? to.tagName.toLowerCase() + (to.className ? '.' + to.className : '') : '无（键盘收起或点了别处）'}`)
						setTyping(false)
					}}
				/>
			</div>
			{picture && <Lightbox img={picture} onClose={() => setPicture(undefined)} />}
		</div>
	)
}

const ICON_PX = 18
const TOAST_MS = 3000

function keyButton(k: (typeof KEYS)[number]) {
	const Icon = k.icon
	return (
		<button key={k.id} data-key={k.id} aria-label={k.label} aria-pressed={k.kind === 'ctrl' ? 'false' : undefined}>
			{Icon ? <Icon size={ICON_PX} /> : k.label}
		</button>
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
