import type { Terminal } from '@xterm/xterm'
import { grid, locate } from './grid'

// 行列都按屏幕上看到的算（不留回滚，屏幕就是整个缓冲区）；end 是最后一格（含）
export type Cell = { col: number; row: number }
export type Range = { start: Cell; end: Cell }

const URL_RE = /https?:\/\/[^\s<>"'`│]+/g
const TRAILING = /[.,;:!?)\]}'"]+$/
// 词的边界：空白、引号括号、herdr 画的边框
const BREAK = /[\s"'`()[\]{}<>,;|│┃─━┌┐└┘├┤┬┴┼╭╮╯╰]/

const before = (a: Cell, b: Cell) => a.row < b.row || (a.row === b.row && a.col <= b.col)
export const ordered = (a: Cell, b: Cell): Range => (before(a, b) ? { start: a, end: b } : { start: b, end: a })

const line = (term: Terminal, row: number) => term.buffer.active.getLine(term.buffer.active.viewportY + row)

// 一行的字，和每个字（UTF-16 单元）在哪一列；宽字符的后半格不占字
function cellsOf(term: Terminal, row: number) {
	const l = line(term, row)
	let text = ''
	const cols: number[] = []
	if (!l) return { text, cols }
	for (let x = 0; x < term.cols; x++) {
		const c = l.getCell(x)
		if (!c || c.getWidth() === 0) continue
		const ch = c.getChars() || ' '
		text += ch
		for (let i = 0; i < ch.length; i++) cols.push(x)
	}
	return { text, cols }
}

export function cellAt(term: Terminal, x: number, y: number): Cell | undefined {
	const p = locate(term, x, y)
	if (!p) return
	return { col: Math.min(term.cols - 1, Math.max(0, p.col)), row: Math.min(term.rows - 1, Math.max(0, p.row)) }
}

// 长按处的词；按在链接上就是整个链接
export function wordAt(term: Terminal, at: Cell): Range {
	const { text, cols } = cellsOf(term, at.row)
	let i = cols.length - 1
	while (i >= 0 && cols[i] > at.col) i--
	if (i < 0) return { start: at, end: at }
	while (i > 0 && cols[i - 1] === cols[i]) i--
	const span = (a: number, b: number): Range => ({ start: { col: cols[a], row: at.row }, end: { col: cols[b], row: at.row } })
	for (const m of text.matchAll(URL_RE)) {
		const url = m[0].replace(TRAILING, '')
		if (i >= m.index && i < m.index + url.length) return span(m.index, m.index + url.length - 1)
	}
	if (BREAK.test(text[i])) return span(i, i)
	let a = i
	let b = i
	while (a > 0 && !BREAK.test(text[a - 1])) a--
	while (b < text.length - 1 && !BREAK.test(text[b + 1])) b++
	return span(a, b)
}

export function screenRange(term: Terminal): Range {
	let last = term.rows - 1
	while (last > 0 && !line(term, last)?.translateToString(true)) last--
	return { start: { col: 0, row: 0 }, end: { col: term.cols - 1, row: last } }
}

// 最后一格是宽字符的前半格时，多选上后半格
const endWidth = (term: Terminal, end: Cell) => Math.max(1, line(term, end.row)?.getCell(end.col)?.getWidth() ?? 1)

export function highlight(term: Terminal, r: Range | undefined) {
	if (!r) return term.clearSelection()
	const len = (r.end.row - r.start.row) * term.cols + r.end.col - r.start.col + endWidth(term, r.end)
	term.select(r.start.col, term.buffer.active.viewportY + r.start.row, len)
}

export function rangeText(term: Terminal, r: Range) {
	let out = ''
	for (let row = r.start.row; row <= r.end.row; row++) {
		const l = line(term, row)
		if (!l) break
		const from = row === r.start.row ? r.start.col : 0
		const to = row === r.end.row ? r.end.col + endWidth(term, r.end) : term.cols
		if (row > r.start.row && !l.isWrapped) out += '\n'
		out += l.translateToString(false, from, to)
	}
	return out.replace(/[ \t]+$/gm, '')
}

export const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s)

// 选区头尾在页面上的位置（client 坐标）：头是第一格的左上角，尾是最后一格的右下角
export function edgePoints(term: Terminal, r: Range) {
	const g = grid(term)
	if (!g) return
	const s = g.screen.getBoundingClientRect()
	return {
		start: { x: s.left + r.start.col * g.cw, y: s.top + r.start.row * g.ch },
		end: { x: s.left + (r.end.col + endWidth(term, r.end)) * g.cw, y: s.top + (r.end.row + 1) * g.ch },
		ch: g.ch,
	}
}
