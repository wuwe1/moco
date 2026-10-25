// 终端上的手势：单指拖动 = 滚轮（交给 herdr / pi 自己滚，松手带惯性），双指捏合 = 改字号，轻点交给 onTap（点在哪由它定）
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
	let velocity = 0 // px/ms，手指往上推为正
	let moved = 0
	let startT = 0
	let x = 0
	let y = 0
	let pinchDist = 0
	let pinchFont = 0
	let raf = 0

	// 一行一个滚轮事件，位置是手指下面：herdr 按位置决定滚哪个窗格。
	// 每帧最多发 WHEEL_PER_FRAME 个，多的留到下一帧：每个滚轮 herdr 都要重画，发太快手机收不过来
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
		// 换方向时丢掉还没发的
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
			if (moved < 8 && e.timeStamp - startT < 300) opts.onTap(x, y)
			else if (e.timeStamp - lastT < 80 && Math.abs(velocity) > 0.3) glide()
		}
		mode = 'none'
	}, opt)

	el.addEventListener('touchcancel', () => { mode = 'none' }, opt)
}
