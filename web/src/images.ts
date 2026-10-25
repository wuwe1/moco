// 图片层：程序用 kitty 图形协议发的图（pi 在 herdr 里就这样），mocod 拦下来单独发给手机
// （xterm.js 不认 kitty 协议）。这里在终端上面盖一张 canvas，按放置画到对应的格子上。
// 放置在一帧画完时才生效，图和那一帧的文字同时出现
import type { Terminal } from '@xterm/xterm'

// 和 internal/screen.Placement 对应：左上角第 x 列第 y 行（从 0 数），占 c 列 r 行；只画原图的 (sx,sy,sw,sh) 那块
export type Placement = { i: number; x: number; y: number; c: number; r: number; sx: number; sy: number; sw: number; sh: number; z: number }

export class ImageLayer {
	private canvas = document.createElement('canvas')
	private bitmaps = new Map<number, ImageBitmap>()
	private placements: Placement[] = []

	constructor(private term: Terminal) {
		this.canvas.className = 'images'
		// 行列、字号变了：等 xterm 量完新的格子再画
		term.onResize(() => requestAnimationFrame(() => this.draw()))
		term.onRender(() => this.sizeChanged() && this.draw())
	}

	private drawn = ''
	private sizeChanged() {
		const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null
		return !!screen && `${screen.clientWidth}x${screen.clientHeight}` !== this.drawn
	}

	// 终端打开之后才有 element
	mount() {
		if (this.term.element && this.canvas.parentElement !== this.term.element) this.term.element.appendChild(this.canvas)
		this.draw()
	}

	async add(id: number, png: Uint8Array<ArrayBuffer>) {
		try {
			const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
			this.bitmaps.get(id)?.close()
			this.bitmaps.set(id, bitmap)
			this.draw()
		} catch {
			// 解不出来就不画，文字照常
		}
	}

	forget(id: number) {
		this.bitmaps.get(id)?.close()
		this.bitmaps.delete(id)
	}

	set(placements: Placement[]) {
		this.placements = placements
		this.draw()
	}

	// 换了连接：mocod 那边是新的一块屏幕，图会重新发
	reset() {
		for (const b of this.bitmaps.values()) b.close()
		this.bitmaps.clear()
		this.placements = []
		this.draw()
	}

	// 格子大小从画面量：.xterm-screen 的尺寸除以行列数
	draw() {
		const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null
		const { canvas } = this
		if (!screen || !this.term.cols || !this.term.rows) return
		const w = screen.clientWidth
		const h = screen.clientHeight
		this.drawn = `${w}x${h}`
		const cw = w / this.term.cols
		const ch = h / this.term.rows
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
			// 没给占几格就按原图像素大小（1 个图像像素 = 1 个 CSS 像素）
			const dw = p.c ? p.c * cw : p.sw
			const dh = p.r ? p.r * ch : p.sh
			ctx.drawImage(bitmap, p.sx, p.sy, p.sw, p.sh, p.x * cw, p.y * ch, dw, dh)
		}
	}

	// 手机上一格多少 CSS 像素，告诉 mocod：herdr 照它把图的像素尺寸换算成占几格
	cellSize(): { w: number; h: number } | undefined {
		const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null
		if (!screen || !this.term.cols || !this.term.rows) return
		return { w: Math.round(screen.clientWidth / this.term.cols), h: Math.round(screen.clientHeight / this.term.rows) }
	}
}
