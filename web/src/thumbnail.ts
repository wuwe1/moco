import type { IBufferCell, Terminal } from '@xterm/xterm'
import { grid } from './grid'
import { wireTheme } from './theme'

const WIDTH_PX = 240
const PIXEL_RATIO = 2

const LEVELS = [0, 95, 135, 175, 215, 255]
const hex = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`
const palette = (i: number) => {
	if (i < 16) return wireTheme.palette[i]
	if (i < 232) return hex(LEVELS[Math.floor((i - 16) / 36)], LEVELS[Math.floor((i - 16) / 6) % 6], LEVELS[(i - 16) % 6])
	const v = 8 + (i - 232) * 10
	return hex(v, v, v)
}
const rgb = (n: number) => hex((n >> 16) & 255, (n >> 8) & 255, n & 255)
const fgOf = (c: IBufferCell) => (c.isFgRGB() ? rgb(c.getFgColor()) : c.isFgPalette() ? palette(c.getFgColor()) : wireTheme.fg)
const bgOf = (c: IBufferCell) => (c.isBgRGB() ? rgb(c.getBgColor()) : c.isBgPalette() ? palette(c.getBgColor()) : wireTheme.bg)

export function renderThumbnail(term: Terminal): string | undefined {
	const g = grid(term)
	if (!g) return
	const cw = WIDTH_PX / term.cols
	const ch = cw * (g.ch / g.cw)
	const rows = term.rows
	const canvas = document.createElement('canvas')
	canvas.width = WIDTH_PX * PIXEL_RATIO
	canvas.height = Math.ceil(rows * ch * PIXEL_RATIO)
	const ctx = canvas.getContext('2d')!
	ctx.scale(PIXEL_RATIO, PIXEL_RATIO)
	ctx.fillStyle = wireTheme.bg
	ctx.fillRect(0, 0, WIDTH_PX, rows * ch)
	ctx.textBaseline = 'middle'
	const size = (term.options.fontSize ?? 13) * (cw / g.cw)
	const family = term.options.fontFamily
	const buf = term.buffer.active
	const cell = buf.getNullCell()
	for (let y = 0; y < rows; y++) {
		const line = buf.getLine(buf.viewportY + y)
		if (!line) continue
		for (let x = 0; x < term.cols; x++) {
			line.getCell(x, cell)
			const w = cell.getWidth()
			if (!w) continue
			let fg = fgOf(cell)
			let bg = bgOf(cell)
			if (cell.isInverse()) [fg, bg] = [bg, fg]
			if (bg !== wireTheme.bg) {
				ctx.fillStyle = bg
				ctx.fillRect(x * cw, y * ch, w * cw, ch)
			}
			const text = cell.getChars()
			if (!text.trim() || cell.isInvisible()) continue
			ctx.globalAlpha = cell.isDim() ? 0.5 : 1
			ctx.fillStyle = fg
			ctx.font = `${cell.isBold() ? 'bold ' : ''}${size}px ${family}`
			ctx.fillText(text, x * cw, y * ch + ch / 2, w * cw)
		}
	}
	ctx.globalAlpha = 1
	return canvas.toDataURL('image/png')
}
