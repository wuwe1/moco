import type { Terminal } from '@xterm/xterm'

export type Grid = { screen: HTMLElement; cw: number; ch: number }

export function grid(term: Terminal): Grid | undefined {
	const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
	if (!screen || !term.cols || !term.rows) return
	return { screen, cw: screen.clientWidth / term.cols, ch: screen.clientHeight / term.rows }
}

export function locate(term: Terminal, clientX: number, clientY: number) {
	const g = grid(term)
	if (!g) return
	const r = g.screen.getBoundingClientRect()
	const x = clientX - r.left
	const y = clientY - r.top
	return { ...g, x, y, col: Math.floor(x / g.cw), row: Math.floor(y / g.ch) }
}
