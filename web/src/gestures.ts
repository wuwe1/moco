import type { Terminal } from '@xterm/xterm'
import { dlog } from './debug'
import { grid } from './grid'
import { FONT_MAX, FONT_MIN } from './store'

const WHEEL_PER_FRAME = 3
const HOLD_MS = 450
const HOLD_SLOP_PX = 8

type Opts = {
	onTap: (x: number, y: number) => void
	onFont: (size: number) => void
	// 长按：按住不动 HOLD_MS 触发，之后手指挪动交给 onHoldMove，不再滚动
	onHold: (x: number, y: number) => void
	onHoldMove: (x: number, y: number) => void
	onScroll: () => void
}

export function gestures(el: HTMLElement, term: Terminal, opts: Opts) {
	let mode: 'none' | 'scroll' | 'pinch' | 'hold' = 'none'
	let holdTimer = 0
	let lastY = 0
	let lastT = 0
	let acc = 0
	let upwardPxPerMs = 0
	let moved = 0
	let x = 0
	let y = 0
	let pinchDist = 0
	let pinchFont = 0
	let raf = 0
	let logged = false

	let queued = 0
	let flushing = 0
	const flush = () => {
		flushing = 0
		const target = grid(term)?.screen
		if (!target) return (queued = 0)
		const n = Math.min(Math.abs(queued), WHEEL_PER_FRAME)
		const dir = Math.sign(queued)
		for (let i = 0; i < n; i++) {
			target.dispatchEvent(new WheelEvent('wheel', {
				deltaY: dir,
				deltaMode: WheelEvent.DOM_DELTA_LINE,
				clientX: x,
				clientY: y,
				bubbles: true,
				cancelable: true,
			}))
		}
		queued -= dir * n
		if (queued) flushing = requestAnimationFrame(flush)
	}
	const wheel = (lines: number) => {
		if (Math.sign(lines) !== Math.sign(queued)) queued = 0
		queued += lines
		flushing ||= requestAnimationFrame(flush)
	}

	const scrollBy = (dy: number) => {
		acc += dy
		const h = grid(term)?.ch ?? 16
		const lines = Math.trunc(acc / h)
		if (lines) {
			acc -= lines * h
			if (!logged) {
				logged = true
				const top = el.getBoundingClientRect().top
				dlog(`终端滑动：从 y=${Math.round(y)} 开始（终端顶 ${Math.round(top)}），鼠标上报 ${term.modes.mouseTrackingMode}，${term.buffer.active.type === 'alternate' ? '全屏' : '普通'}屏幕`)
			}
			opts.onScroll()
			wheel(lines)
		}
	}

	const glide = () => {
		let prev = performance.now()
		const step = (now: number) => {
			const dt = now - prev
			prev = now
			upwardPxPerMs *= Math.pow(0.94, dt / 16)
			if (Math.abs(upwardPxPerMs) < 0.05) return
			scrollBy(upwardPxPerMs * dt)
			raf = requestAnimationFrame(step)
		}
		raf = requestAnimationFrame(step)
	}

	const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

	const swallowTouch = (type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', fn: (e: TouchEvent) => void) =>
		el.addEventListener(type, e => {
			e.preventDefault()
			e.stopPropagation()
			fn(e)
		}, { passive: false, capture: true })

	swallowTouch('touchstart', e => {
		cancelAnimationFrame(raf)
		clearTimeout(holdTimer)
		queued = 0
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
		lastT = e.timeStamp
		acc = upwardPxPerMs = moved = 0
		logged = false
		holdTimer = window.setTimeout(() => {
			mode = 'hold'
			opts.onHold(x, y)
		}, HOLD_MS)
	})

	swallowTouch('touchmove', e => {
		if (mode === 'pinch' && e.touches.length >= 2) {
			const size = Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, pinchFont * dist(e.touches) / pinchDist)))
			if (size !== term.options.fontSize) opts.onFont(size)
			return
		}
		const t = e.touches[0]
		if (mode === 'hold') return opts.onHoldMove(t.clientX, t.clientY)
		if (mode !== 'scroll') return
		if (Math.hypot(t.clientX - x, t.clientY - y) > HOLD_SLOP_PX) clearTimeout(holdTimer)
		const dy = lastY - t.clientY
		const dt = Math.max(1, e.timeStamp - lastT)
		upwardPxPerMs = 0.8 * (dy / dt) + 0.2 * upwardPxPerMs
		moved += Math.abs(dy)
		lastY = t.clientY
		lastT = e.timeStamp
		scrollBy(dy)
	})

	swallowTouch('touchend', e => {
		if (e.touches.length) return
		clearTimeout(holdTimer)
		if (mode === 'scroll') {
			// 没挪动、长按还没触发就算轻点，不管按了多久：认真点列表时常按 300ms 以上
			if (moved < HOLD_SLOP_PX) opts.onTap(x, y)
			else if (e.timeStamp - lastT < 80 && Math.abs(upwardPxPerMs) > 0.3) glide()
		}
		mode = 'none'
	})

	swallowTouch('touchcancel', () => {
		clearTimeout(holdTimer)
		mode = 'none'
	})
}
