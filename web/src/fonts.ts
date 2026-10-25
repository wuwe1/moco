import fira400 from '@fontsource/fira-code/files/fira-code-latin-400-normal.woff2?url'
import fira700 from '@fontsource/fira-code/files/fira-code-latin-700-normal.woff2?url'
import jetbrains400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url'
import jetbrains700 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url'
import maple400 from '@fontsource/maple-mono/files/maple-mono-latin-400-normal.woff2?url'
import maple700 from '@fontsource/maple-mono/files/maple-mono-latin-700-normal.woff2?url'

const LOAD_TIMEOUT_MS = 1500
const SYSTEM_STACK = 'ui-monospace, "SF Mono", Menlo'

type Font = { label: string; web?: { family: string; regular: string; bold: string } }
const fonts = {
	system: { label: '系统（SF Mono）' },
	jetbrains: { label: 'JetBrains Mono', web: { family: 'JetBrains Mono', regular: jetbrains400, bold: jetbrains700 } },
	fira: { label: 'Fira Code', web: { family: 'Fira Code', regular: fira400, bold: fira700 } },
	maple: { label: 'Maple Mono', web: { family: 'Maple Mono', regular: maple400, bold: maple700 } },
} satisfies Record<string, Font>
export type FontKey = keyof typeof fonts
export const FONTS: Record<FontKey, Font> = fonts
export const isFontKey = (s: string | null): s is FontKey => !!s && s in FONTS

export const fontStack = (k: FontKey) => {
	const { web } = FONTS[k]
	return `${web ? `"${web.family}"` : SYSTEM_STACK}, moco-symbols, monospace`
}

// 字体都用 FontFace 建、直接 load()：放在 CSS 的 @font-face 里时，Safari 上 document.fonts.load 返回了也不一定真去下载，
// xterm 量格子就按备用字体量了
const face = (family: string, url: string, weight = 'normal') => {
	const f = new FontFace(family, `url(${url}) format('woff2')`, { weight, display: 'block' })
	document.fonts.add(f)
	return f
}
const symbols = face('moco-symbols', '/fonts/moco-symbols.woff2')
const loaded = new Map<FontKey, FontFace[]>()

export function loadFont(k: FontKey): Promise<void> {
	const { web } = FONTS[k]
	if (web && !loaded.has(k)) loaded.set(k, [face(web.family, web.regular, '400'), face(web.family, web.bold, '700')])
	const load = Promise.all([symbols, ...(loaded.get(k) ?? [])].map(f => f.load()))
	const timeout = new Promise<void>(r => setTimeout(r, LOAD_TIMEOUT_MS))
	return Promise.race([load.then(() => {}), timeout]).catch(() => {})
}
