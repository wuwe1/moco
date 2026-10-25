// 终端上的手势：单指拖动 = 滚轮（交给 herdr / pi 自己滚，松手带惯性），双指捏合 = 改字号，轻点 = 弹键盘
import type { Terminal } from '@xterm/xterm'

const FONT_MIN = 9
const FONT_MAX = 24

export function gestures(el: HTMLElement, term: Terminal, opts: { onTap: () => void; onFont: (size: number) => void }) {
	let mode: 'none' | 'scroll' | 'pinch' = 'none'
	let lastY = 0
	let lastT = 0
	let acc = 0
	let velocity = 0 // px/ms，手指往上推为正
	let moved = 0
	let startT = 0
	let x = 0
	let y = 0
	let pinchDist = 0
	let pinchFont = 0
	let raf = 0

	const cellHeight = () => {
		const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
		return screen && term.rows ? screen.clientHeight / term.rows : 16
	}

	// 一行发一个滚轮事件，位置是手指下面：herdr 按位置决定滚哪个窗格
	const wheel = (lines: number) => {
		const target = term.element?.querySelector('.xterm-screen')
		if (!target) return
		for (let i = 0; i < Math.abs(lines); i++) {
			target.dispatchEvent(new WheelEvent('wheel', {
				deltaY: Math.sign(lines),
				deltaMode: WheelEvent.DOM_DELTA_LINE,
				clientX: x,
				clientY: y,
				bubbles: true,
				cancelable: true,
			}))
		}
	}

	const scrollBy = (dy: number) => {
		acc += dy
		const h = cellHeight()
		const lines = Math.trunc(acc / h)
		if (lines) {
			acc -= lines * h
			wheel(lines)
		}
	}

	const glide = () => {
		let prev = performance.now()
		const step = (now: number) => {
			const dt = now - prev
			prev = now
			velocity *= Math.pow(0.94, dt / 16)
			if (Math.abs(velocity) < 0.05) return
			scrollBy(velocity * dt)
			raf = requestAnimationFrame(step)
		}
		raf = requestAnimationFrame(step)
	}

	const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

	// 捕获阶段先拿到，并且不再往里传：xterm 自己的触摸滚动、聚焦都不要
	const opt = { passive: false, capture: true }

	el.addEventListener('touchstart', e => {
		e.preventDefault()
		e.stopPropagation()
		cancelAnimationFrame(raf)
		if (e.touches.length >= 2) {
			mode = 'pinch'
			pinchDist = dist(e.touches)
			pinchFont = term.options.fontSize ?? 13
			return
		}
		const t = e.touches[0]
		mode = 'scroll'
		x = t.clientX
		y = lastY = t.clientY
		startT = lastT = e.timeStamp
		acc = velocity = moved = 0
	}, opt)

	el.addEventListener('touchmove', e => {
		e.preventDefault()
		e.stopPropagation()
		if (mode === 'pinch' && e.touches.length >= 2) {
			const size = Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, pinchFont * dist(e.touches) / pinchDist)))
			if (size !== term.options.fontSize) opts.onFont(size)
			return
		}
		if (mode !== 'scroll') return
		const t = e.touches[0]
		const dy = lastY - t.clientY
		const dt = Math.max(1, e.timeStamp - lastT)
		velocity = 0.8 * (dy / dt) + 0.2 * velocity
		moved += Math.abs(dy)
		lastY = t.clientY
		lastT = e.timeStamp
		scrollBy(dy)
	}, opt)

	el.addEventListener('touchend', e => {
		e.preventDefault()
		e.stopPropagation()
		if (e.touches.length) return
		if (mode === 'scroll') {
			if (moved < 8 && e.timeStamp - startT < 300) opts.onTap()
			else if (e.timeStamp - lastT < 80 && Math.abs(velocity) > 0.3) glide()
		}
		mode = 'none'
	}, opt)

	el.addEventListener('touchcancel', () => { mode = 'none' }, opt)
}
