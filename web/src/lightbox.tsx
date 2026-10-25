// 放大看原图：终端里的图被 herdr 缩到几格大，还可能被窗格裁掉一块；这里用 mocod 发来的整张 PNG。
// 打开时整张放进屏幕（比屏幕小就按原大小），双指缩放、单指拖，双击在「适合屏幕」和放大之间切换，
// 轻点或在原大小时往下拖就关掉
import { useEffect, useMemo, useRef } from 'preact/hooks'

export type Picture = { png: Uint8Array<ArrayBuffer>; w: number; h: number }

export function Lightbox(props: { img: Picture; onClose: () => void }) {
	const { img } = props
	const url = useMemo(() => URL.createObjectURL(new Blob([img.png], { type: 'image/png' })), [img])
	useEffect(() => () => URL.revokeObjectURL(url), [url])
	const stage = useRef<HTMLDivElement>(null)
	const pic = useRef<HTMLImageElement>(null)
	const close = useRef(props.onClose)
	close.current = props.onClose
	useEffect(() => zoomable(stage.current!, pic.current!, img.w, img.h, () => close.current()), [img])

	// iOS 的分享面板里有「存储图像」
	const file = useMemo(() => new File([img.png], 'image.png', { type: 'image/png' }), [img])
	const canShare = !!navigator.canShare?.({ files: [file] })

	return (
		<div class="lightbox">
			<div class="stage" ref={stage}>
				<img ref={pic} src={url} width={img.w} height={img.h} alt="" />
			</div>
			<div class="lb-bar">
				<span class="size">{img.w} × {img.h}</span>
				{canShare && <button class="text" onClick={() => navigator.share({ files: [file] }).catch(() => {})}>分享</button>}
				<button class="icon" aria-label="关闭" onClick={props.onClose}>×</button>
			</div>
		</div>
	)
}

function zoomable(stage: HTMLElement, img: HTMLImageElement, w: number, h: number, onClose: () => void) {
	let fit = 1
	let max = 4
	let s = 1
	let tx = 0
	let ty = 0

	const apply = (settle = false) => {
		stage.classList.toggle('settle', settle)
		img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`
	}
	// 比屏幕窄（矮）就居中，比屏幕大就不许拖出空白
	const clamp = () => {
		const vw = stage.clientWidth
		const vh = stage.clientHeight
		tx = w * s <= vw ? (vw - w * s) / 2 : Math.min(0, Math.max(vw - w * s, tx))
		ty = h * s <= vh ? (vh - h * s) / 2 : Math.min(0, Math.max(vh - h * s, ty))
	}
	const reset = () => {
		fit = Math.min(stage.clientWidth / w, stage.clientHeight / h, 1)
		max = Math.max(fit * 8, 2)
		s = fit
		clamp()
		apply()
	}
	// 以屏幕上 (x, y) 那一点为中心缩放到 next
	const zoomAt = (x: number, y: number, next: number) => {
		tx = x - ((x - tx) / s) * next
		ty = y - ((y - ty) / s) * next
		s = next
	}

	type P = { x: number; y: number }
	const pt = (t: Touch): P => {
		const r = stage.getBoundingClientRect()
		return { x: t.clientX - r.left, y: t.clientY - r.top }
	}
	const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
	const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y)

	let mode: 'none' | 'pan' | 'pinch' = 'none'
	let start: P = { x: 0, y: 0 }
	let t0 = { s, tx, ty }
	let d0 = 1
	let moved = 0
	let startT = 0
	let lastTap = 0
	let tapTimer = 0

	const beginPan = (p: P) => {
		mode = 'pan'
		start = p
		t0 = { s, tx, ty }
	}

	const down = (e: TouchEvent) => {
		e.preventDefault()
		if (e.touches.length >= 2) {
			mode = 'pinch'
			const a = pt(e.touches[0])
			const b = pt(e.touches[1])
			start = mid(a, b)
			d0 = dist(a, b)
			t0 = { s, tx, ty }
			moved = Infinity
			return
		}
		beginPan(pt(e.touches[0]))
		moved = 0
		startT = e.timeStamp
	}
	const move = (e: TouchEvent) => {
		e.preventDefault()
		if (mode === 'pinch' && e.touches.length >= 2) {
			const a = pt(e.touches[0])
			const b = pt(e.touches[1])
			const m = mid(a, b)
			s = t0.s
			tx = t0.tx
			ty = t0.ty
			zoomAt(start.x, start.y, Math.min(max, Math.max(fit * 0.7, (t0.s * dist(a, b)) / d0)))
			tx += m.x - start.x
			ty += m.y - start.y
			apply()
		} else if (mode === 'pan') {
			const p = pt(e.touches[0])
			moved = Math.max(moved, Math.hypot(p.x - start.x, p.y - start.y))
			tx = t0.tx + p.x - start.x
			ty = t0.ty + p.y - start.y
			apply()
		}
	}
	const up = (e: TouchEvent) => {
		e.preventDefault()
		// 捏合时先抬起一根手指：剩下那根接着拖
		if (e.touches.length === 1) return beginPan(pt(e.touches[0]))
		if (e.touches.length) return
		const was = mode
		mode = 'none'
		const end = pt(e.changedTouches[0])
		if (was === 'pan' && moved < 8 && e.timeStamp - startT < 300) return tap(end)
		const atFit = s <= fit * 1.01
		if (was === 'pan' && atFit && end.y - start.y > 100) return onClose()
		if (s < fit) zoomAt(end.x, end.y, fit)
		clamp()
		apply(true)
	}

	// 单击要等一下，看是不是双击
	const tap = (p: P) => {
		const now = performance.now()
		if (now - lastTap < 280) {
			clearTimeout(tapTimer)
			lastTap = 0
			if (s > fit * 1.01) zoomAt(p.x, p.y, fit)
			else zoomAt(p.x, p.y, Math.min(max, Math.max(fit * 2.5, 1)))
			clamp()
			apply(true)
			return
		}
		lastTap = now
		tapTimer = window.setTimeout(onClose, 280)
	}

	const opt = { passive: false }
	stage.addEventListener('touchstart', down, opt)
	stage.addEventListener('touchmove', move, opt)
	stage.addEventListener('touchend', up, opt)
	stage.addEventListener('touchcancel', up, opt)
	// 电脑上调试：点一下关掉（触屏上 touchstart 拦掉了，不会有 click）
	const click = () => onClose()
	stage.addEventListener('click', click)
	window.addEventListener('resize', reset)
	reset()
	return () => {
		clearTimeout(tapTimer)
		stage.removeEventListener('touchstart', down)
		stage.removeEventListener('touchmove', move)
		stage.removeEventListener('touchend', up)
		stage.removeEventListener('touchcancel', up)
		stage.removeEventListener('click', click)
		window.removeEventListener('resize', reset)
	}
}
