import type { Terminal } from '@xterm/xterm'
import { grid } from './grid'

const FONT_MIN = 9
const FONT_MAX = 24
const WHEEL_PER_FRAME = 3

export function gestures(el: HTMLElement, term: Terminal, opts: { onTap: (x: number, y: number) => void; onFont: (size: number) => void }) {
	let mode: 'none' | 'scroll' | 'pinch' = 'none'
	let lastY = 0
	let lastT = 0
	let acc = 0
	let upwardPxPerMs = 0
	let moved = 0
	let startT = 0
	let x = 0
	let y = 0
	let pinchDist = 0
	let pinchFont = 0
	let raf = 0

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
		startT = lastT = e.timeStamp
		acc = upwardPxPerMs = moved = 0
	})

	swallowTouch('touchmove', e => {
		if (mode === 'pinch' && e.touches.length >= 2) {
			const size = Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, pinchFont * dist(e.touches) / pinchDist)))
			if (size !== term.options.fontSize) opts.onFont(size)
			return
		}
		if (mode !== 'scroll') return
		const t = e.touches[0]
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
		if (mode === 'scroll') {
			if (moved < 8 && e.timeStamp - startT < 300) opts.onTap(x, y)
			else if (e.timeStamp - lastT < 80 && Math.abs(upwardPxPerMs) > 0.3) glide()
		}
		mode = 'none'
	})

	swallowTouch('touchcancel', () => { mode = 'none' })
}
