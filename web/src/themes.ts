import type { ITheme } from '@xterm/xterm'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
const NAMES = [...ANSI, ...ANSI.map(n => `bright${n[0].toUpperCase()}${n.slice(1)}`)]

export type Theme = {
	id: string
	name: string
	mode: 'dark' | 'light'
	background: string
	foreground: string
	cursor?: string
	selection?: string
	ansi: string[] // 16 个：黑红绿黄蓝品青白，再来一遍亮的
	shiki: string // 代码高亮用的 Shiki 主题
	custom?: boolean
}

const t = (id: string, name: string, mode: Theme['mode'], background: string, foreground: string, ansi: string, shiki: string, selection?: string, cursor?: string): Theme => ({
	id,
	name,
	mode,
	background,
	foreground,
	ansi: ansi.split(' '),
	shiki,
	selection,
	cursor,
})

export const BUILTIN: Theme[] = [
	t('gruvbox-dark', 'Gruvbox', 'dark', '#282828', '#ebdbb2', '#282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2', 'gruvbox-dark-medium', '#504945'),
	t('dracula', 'Dracula', 'dark', '#282a36', '#f8f8f2', '#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff', 'dracula', '#44475a'),
	t('nord', 'Nord', 'dark', '#2e3440', '#d8dee9', '#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4', 'nord', '#434c5e'),
	t('solarized-dark', 'Solarized Dark', 'dark', '#002b36', '#839496', '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #586e75 #cb4b16 #859900 #b58900 #268bd2 #6c71c4 #2aa198 #fdf6e3', 'solarized-dark', '#073642'),
	t('catppuccin-mocha', 'Catppuccin Mocha', 'dark', '#1e1e2e', '#cdd6f4', '#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8', 'catppuccin-mocha', '#585b70', '#f5e0dc'),
	t('tokyo-night', 'Tokyo Night', 'dark', '#1a1b26', '#c0caf5', '#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5', 'tokyo-night', '#33467c'),
	t('gruvbox-light', 'Gruvbox Light', 'light', '#fbf1c7', '#3c3836', '#fbf1c7 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836', 'gruvbox-light-medium', '#ebdbb2'),
	t('solarized-light', 'Solarized Light', 'light', '#fdf6e3', '#657b83', '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #586e75 #cb4b16 #859900 #b58900 #268bd2 #6c71c4 #2aa198 #002b36', 'solarized-light', '#eee8d5'),
	t('catppuccin-latte', 'Catppuccin Latte', 'light', '#eff1f5', '#4c4f69', '#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #bcc0cc', 'catppuccin-latte', '#acb0be', '#dc8a78'),
	t('github-light', 'GitHub Light', 'light', '#ffffff', '#24292f', '#24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781 #57606a #a40e26 #1a7f37 #633c01 #218bff #a475f9 #3192aa #8c959f', 'github-light', '#b6e3ff'),
	t('rose-pine-dawn', 'Rosé Pine Dawn', 'light', '#faf4ed', '#575279', '#f2e9e1 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279 #9893a5 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279', 'rose-pine-dawn', '#dfdad9'),
]

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

// 导入的主题：{ v: 1, name, mode: "dark"|"light", colors: { background, foreground, cursor?, selection?, black…brightWhite } }，
// 十六色也可以写成 colors.ansi 数组；缺的按同一明暗的 Gruvbox 补
export function parseTheme(json: string): Theme {
	let raw: unknown
	try {
		raw = JSON.parse(json)
	} catch {
		throw new Error('不是 JSON')
	}
	const o = raw as { v?: unknown; name?: unknown; mode?: unknown; colors?: Record<string, unknown> }
	if (o?.v !== 1) throw new Error('v 要是 1')
	if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 40) throw new Error('name 要有，最多 40 个字')
	if (o.mode !== 'dark' && o.mode !== 'light') throw new Error('mode 要是 dark 或 light')
	const c = o.colors ?? {}
	const color = (key: string, required = false) => {
		const v = c[key]
		if (v === undefined && !required) return undefined
		if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`colors.${key} 要是 #rrggbb`)
		return v
	}
	const base = BUILTIN.find(b => b.id === (o.mode === 'dark' ? 'gruvbox-dark' : 'gruvbox-light'))!
	const list = Array.isArray(c.ansi) ? c.ansi : undefined
	const ansi = NAMES.map((n, i) => {
		const v = list ? list[i] : c[n]
		if (v === undefined) return base.ansi[i]
		if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`colors.${list ? `ansi[${i}]` : n} 要是 #rrggbb`)
		return v
	})
	return {
		id: `custom-${o.name.trim().toLowerCase().replace(/\s+/g, '-')}`,
		name: o.name.trim(),
		mode: o.mode,
		background: color('background', true)!,
		foreground: color('foreground', true)!,
		cursor: color('cursor'),
		selection: color('selection'),
		ansi,
		shiki: o.mode === 'dark' ? 'github-dark' : 'github-light',
		custom: true,
	}
}

export const xtermTheme = (th: Theme): ITheme => ({
	background: th.background,
	foreground: th.foreground,
	cursor: th.cursor ?? th.foreground,
	cursorAccent: th.background,
	selectionBackground: th.selection ?? th.ansi[8],
	...Object.fromEntries(NAMES.map((n, i) => [n, th.ansi[i]])),
})

// 发给 mocod：它替手机回答程序对颜色的查询（OSC 10/11/4）
export const wireTheme = (th: Theme) => ({ fg: th.foreground, bg: th.background, palette: th.ansi })

// App 的颜色都从这几个算（style.css 里用 color-mix）：深色用亮的那组强调色，浅色用普通的
export function applyTheme(th: Theme) {
	const root = document.documentElement
	const accent = (i: number) => th.ansi[th.mode === 'dark' ? i + 8 : i]
	root.dataset.mode = th.mode
	root.style.colorScheme = th.mode
	for (const [k, v] of Object.entries({ term: th.background, fg: th.foreground, ok: accent(2), wait: accent(3), down: accent(1) }))
		root.style.setProperty(`--${k}`, v)
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', th.background)
}
