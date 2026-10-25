// 终端抽屉：从底部拉起盖住首页，顶上的把手往下拖就收回首页（连接不断）。
// 按键栏、输入框只有一套，跟着当前打开的连接走
import { useEffect, useRef, useState } from 'preact/hooks'
import type { State } from './conn'
import { debugLines, onDebug } from './debug'
import { keyboard } from './keyboard'
import { onSessionsChange, session, stateOf, type Session } from './session'
import type { Host } from './store'

const STATUS: Record<State, string> = {
	open: '已连接',
	connecting: '连接中',
	closed: '已断开，重连中',
	unauthorized: '这台手机没登记',
}

// 断开时带上关闭码和已经重连了几次：1006 是网络层断的，4401 是没登记，4500 是电脑上的命令起不来
function status(state: State, host?: Host) {
	const c = host && session(host).conn
	if (state === 'closed' && c?.lastClose) return `已断开 ${c.lastClose}，第 ${c.retries} 次重连`
	if (state === 'connecting' && c?.retries) return `连接中（上次 ${c.lastClose}，第 ${c.retries} 次）`
	return STATUS[state]
}

export function Sheet(props: { host?: Host; onClose: () => void; onRepair: (h: Host) => void }) {
	const { host } = props
	const root = useRef<HTMLDivElement>(null)
	const panes = useRef<HTMLDivElement>(null)
	const current = useRef<Session | undefined>(undefined)
	const kb = useRef<ReturnType<typeof keyboard> | undefined>(undefined)
	const [drag, setDrag] = useState(0)
	const [debug, setDebug] = useState(false)
	const [, bump] = useState(0)
	useEffect(() => (debug ? onDebug(() => bump(n => n + 1)) : undefined), [debug])

	// 按键栏、输入框只绑一次
	useEffect(() => {
		kb.current = keyboard(root.current!, () => current.current?.term, s => current.current?.conn.send(s))
		return onSessionsChange(() => bump(n => n + 1))
	}, [])

	// 换连接：旧的存一屏缩略图、藏起来，新的挂上
	useEffect(() => {
		const prev = current.current
		if (prev && prev.host.id !== host?.id) prev.detach()
		if (!host) {
			kb.current?.blur()
			current.current = undefined
			return
		}
		const s = session(host)
		s.onTap = () => kb.current?.focus()
		current.current = s
		requestAnimationFrame(() => s.attach(panes.current!))
	}, [host?.id])

	// 键盘弹出时界面只剩 visualViewport 那么高：抽屉缩到键盘上方，终端重算行列
	useEffect(() => {
		const vv = window.visualViewport
		const layout = () => {
			const el = root.current!
			const h = vv ? vv.height : window.innerHeight
			el.style.height = `${h}px`
			el.style.setProperty('--vv-top', `${vv ? vv.offsetTop : 0}px`)
			el.style.setProperty('--safe-bottom', h < window.innerHeight - 80 ? '0px' : 'env(safe-area-inset-bottom)')
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

	// 把手往下拖：超过 120px 或甩得够快就收起
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
		// 点一下状态文字：开关连接日志
		if (Math.abs(dy) < 6 && grab.current.onStatus) return setDebug(d => !d)
		if (dy > 120 || (dy > 30 && v > 0.6)) {
			current.current?.snapshot()
			props.onClose()
		}
	}

	const state = (host && stateOf(host.id)) || 'connecting'
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
				<span class="status">{status(state, host)}</span>
			</header>
			{/* 终端节点由 Session 自己挂进来，这里不放 Preact 管的子节点 */}
			<div id="panes" ref={panes} />
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
			<div id="compose" hidden />
			<div id="bar">
				<div id="keys">
					<button data-key="esc">Esc</button>
					<button data-key="tab">Tab</button>
					<button data-key="ctrl" aria-pressed="false">Ctrl</button>
					<button data-key="^c">^C</button>
					<button data-key="^b">^B</button>
					<button data-key="left" data-repeat>←</button>
					<button data-key="up" data-repeat>↑</button>
					<button data-key="down" data-repeat>↓</button>
					<button data-key="right" data-repeat>→</button>
					<button data-key="enter">⏎</button>
				</div>
				<button id="kbd" aria-label="键盘">⌨</button>
				<textarea id="input" rows={1} autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck={false} />
			</div>
		</div>
	)
}
