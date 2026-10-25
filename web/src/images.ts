import type { Terminal } from '@xterm/xterm'
import { grid, locate } from './grid'

export type Placement = { i: number; x: number; y: number; c: number; r: number; sx: number; sy: number; sw: number; sh: number; z: number }

const sizeOrNativePx = (cells: number, cellPx: number, nativePx: number) => (cells ? cells * cellPx : nativePx)
const placementRect = (p: Placement, cw: number, ch: number) => ({ x: p.x * cw, y: p.y * ch, w: sizeOrNativePx(p.c, cw, p.sw), h: sizeOrNativePx(p.r, ch, p.sh) })

export class ImageLayer {
	private canvas = document.createElement('canvas')
	private bitmaps = new Map<number, ImageBitmap>()
	private pngs = new Map<number, Uint8Array<ArrayBuffer>>()
	private placements: Placement[] = []

	constructor(private term: Terminal) {
		this.canvas.className = 'images'
		term.onResize(() => this.drawAfterRemeasure())
		term.onRender(() => this.sizeChanged() && this.draw())
	}

	private drawAfterRemeasure() {
		requestAnimationFrame(() => this.draw())
	}

	private drawn = ''
	private sizeChanged() {
		const g = grid(this.term)
		return !!g && `${g.screen.clientWidth}x${g.screen.clientHeight}` !== this.drawn
	}

	mount() {
		if (this.term.element && this.canvas.parentElement !== this.term.element) this.term.element.appendChild(this.canvas)
		this.draw()
	}

	async add(id: number, png: Uint8Array<ArrayBuffer>) {
		try {
			const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
			this.bitmaps.get(id)?.close()
			this.bitmaps.set(id, bitmap)
			this.pngs.set(id, png)
			this.draw()
		} catch {
		}
	}

	forget(id: number) {
		this.bitmaps.get(id)?.close()
		this.bitmaps.delete(id)
		this.pngs.delete(id)
	}

	set(placements: Placement[]) {
		this.placements = placements
		this.draw()
	}

	reset() {
		for (const b of this.bitmaps.values()) b.close()
		this.bitmaps.clear()
		this.pngs.clear()
		this.placements = []
		this.draw()
	}

	draw() {
		const g = grid(this.term)
		if (!g) return
		const { screen, cw, ch } = g
		const { canvas } = this
		const w = screen.clientWidth
		const h = screen.clientHeight
		this.drawn = `${w}x${h}`
		const dpr = window.devicePixelRatio || 1
		if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
			canvas.width = Math.round(w * dpr)
			canvas.height = Math.round(h * dpr)
			canvas.style.width = `${w}px`
			canvas.style.height = `${h}px`
		}
		canvas.style.left = `${screen.offsetLeft}px`
		canvas.style.top = `${screen.offsetTop}px`
		const ctx = canvas.getContext('2d')!
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, w, h)
		ctx.imageSmoothingQuality = 'high'
		for (const p of this.placements) {
			const bitmap = this.bitmaps.get(p.i)
			if (!bitmap || p.sw <= 0 || p.sh <= 0) continue
			const a = placementRect(p, cw, ch)
			ctx.drawImage(bitmap, p.sx, p.sy, p.sw, p.sh, a.x, a.y, a.w, a.h)
		}
	}

	hit(clientX: number, clientY: number): { png: Uint8Array<ArrayBuffer>; w: number; h: number } | undefined {
		const at = locate(this.term, clientX, clientY)
		if (!at) return
		const { x, y } = at
		for (let k = this.placements.length - 1; k >= 0; k--) {
			const p = this.placements[k]
			const bitmap = this.bitmaps.get(p.i)
			const png = this.pngs.get(p.i)
			if (!bitmap || !png) continue
			const a = placementRect(p, at.cw, at.ch)
			if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return { png, w: bitmap.width, h: bitmap.height }
		}
	}

	cellSize(): { w: number; h: number } | undefined {
		const g = grid(this.term)
		return g && { w: Math.round(g.cw), h: Math.round(g.ch) }
	}
}
