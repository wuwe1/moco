// 终端画面的格子：.xterm-screen 的大小除以行列数。手势、图片层、轻点都按它把像素换成格子
import type { Terminal } from '@xterm/xterm'

export type Grid = { screen: HTMLElement; cw: number; ch: number }

// 终端还没打开（没有 element）或还没量出行列时没有
export function grid(term: Terminal): Grid | undefined {
	const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
	if (!screen || !term.cols || !term.rows) return
	return { screen, cw: screen.clientWidth / term.cols, ch: screen.clientHeight / term.rows }
}

// 手指在屏幕上的位置换成画面里的：x、y 是离画面左上角的 CSS 像素，col、row 是第几格（从 0 数）
export function locate(term: Terminal, clientX: number, clientY: number) {
	const g = grid(term)
	if (!g) return
	const r = g.screen.getBoundingClientRect()
	const x = clientX - r.left
	const y = clientY - r.top
	return { ...g, x, y, col: Math.floor(x / g.cw), row: Math.floor(y / g.ch) }
}
