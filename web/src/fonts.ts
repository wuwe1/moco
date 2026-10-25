import '@fontsource/noto-sans-sc/400.css'
import dejavu400 from '@fontsource/dejavu-mono/files/dejavu-mono-latin-400-normal.woff2?url'
import dejavu700 from '@fontsource/dejavu-mono/files/dejavu-mono-latin-700-normal.woff2?url'
import fira400 from '@fontsource/fira-code/files/fira-code-latin-400-normal.woff2?url'
import fira700 from '@fontsource/fira-code/files/fira-code-latin-700-normal.woff2?url'
import iosevka400 from '@fontsource/iosevka/files/iosevka-latin-400-normal.woff2?url'
import iosevka700 from '@fontsource/iosevka/files/iosevka-latin-700-normal.woff2?url'
import jetbrains400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url'
import jetbrains700 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url'
import maple400 from '@fontsource/maple-mono/files/maple-mono-latin-400-normal.woff2?url'
import maple700 from '@fontsource/maple-mono/files/maple-mono-latin-700-normal.woff2?url'
import { idbStore } from './idb'
import { cjkFont, customFontList, fontKeyRaw, saveCustomFontList, type CustomFont } from './store'

const LOAD_TIMEOUT_MS = 1500
const SYSTEM_STACK = 'ui-monospace, "SF Mono", Menlo'

type Builtin = { label: string; web?: { family: string; regular: string; bold: string } }
const builtin = {
	system: { label: '系统（SF Mono）' },
	jetbrains: { label: 'JetBrains Mono', web: { family: 'JetBrains Mono', regular: jetbrains400, bold: jetbrains700 } },
	fira: { label: 'Fira Code', web: { family: 'Fira Code', regular: fira400, bold: fira700 } },
	maple: { label: 'Maple Mono', web: { family: 'Maple Mono', regular: maple400, bold: maple700 } },
	iosevka: { label: 'Iosevka', web: { family: 'Iosevka', regular: iosevka400, bold: iosevka700 } },
	dejavu: { label: 'DejaVu Sans Mono', web: { family: 'DejaVu Mono', regular: dejavu400, bold: dejavu700 } },
} satisfies Record<string, Builtin>
type BuiltinKey = keyof typeof builtin
const BUILTIN: Record<BuiltinKey, Builtin> = builtin

export type FontKey = BuiltinKey | `custom:${string}`
export type FontChoice = { key: FontKey; label: string; custom?: CustomFont }

const customKey = (f: CustomFont): FontKey => `custom:${f.id}`
const customOf = (k: string) => customFontList().find(f => customKey(f) === k)

export const fontChoices = (): FontChoice[] => [
	...(Object.keys(BUILTIN) as BuiltinKey[]).map(key => ({ key, label: BUILTIN[key].label })),
	...customFontList().map(f => ({ key: customKey(f), label: f.name, custom: f })),
]

export const fontKey = (): FontKey => {
	const k = fontKeyRaw()
	if (k && (k in BUILTIN || customOf(k))) return k as FontKey
	return 'system'
}

export const CJK_FONTS = { system: '系统（苹方）', noto: 'Noto Sans SC' }
export type CjkFont = keyof typeof CJK_FONTS

const familyOf = (k: FontKey) => {
	if (k.startsWith('custom:')) return `"moco-${k}"`
	const { web } = BUILTIN[k as BuiltinKey]
	return web ? `"${web.family}"` : SYSTEM_STACK
}
export const fontStack = (k: FontKey, cjk: CjkFont) => `${familyOf(k)}, moco-symbols, ${cjk === 'noto' ? '"Noto Sans SC", ' : ''}monospace`
export const currentFontStack = () => fontStack(fontKey(), cjkFont())

// 西文字体都用 FontFace 建、直接 load()：放在 CSS 的 @font-face 里时，Safari 上 document.fonts.load 返回了也不一定真去下载，
// xterm 量格子就按备用字体量了。中文字形本来就是一个字号宽，晚到一点不影响格子，Noto Sans SC 照常走 CSS 按字分块下载
const face = (family: string, source: string | ArrayBuffer, weight = 'normal') => {
	const f = new FontFace(family, typeof source === 'string' ? `url(${source}) format('woff2')` : source, { weight, display: 'block' })
	document.fonts.add(f)
	return f
}
const symbols = face('moco-symbols', '/fonts/moco-symbols.woff2')
const loaded = new Map<FontKey, FontFace[]>()
const files = idbStore<ArrayBuffer>('moco-fonts', 'files')

async function facesOf(k: FontKey): Promise<FontFace[]> {
	const hit = loaded.get(k)
	if (hit) return hit
	let faces: FontFace[] = []
	const custom = customOf(k)
	if (custom) {
		const data = await files.get(custom.id)
		if (data) faces = [face(`moco-${k}`, data)]
	} else {
		const { web } = BUILTIN[k as BuiltinKey]
		if (web) faces = [face(web.family, web.regular, '400'), face(web.family, web.bold, '700')]
	}
	loaded.set(k, faces)
	return faces
}

export function loadFont(k: FontKey): Promise<void> {
	const load = facesOf(k).then(faces => Promise.all([symbols, ...faces].map(f => f.load())))
	const timeout = new Promise<void>(r => setTimeout(r, LOAD_TIMEOUT_MS))
	return Promise.race([load.then(() => {}), timeout]).catch(() => {})
}

// 导入的字体文件存 IndexedDB（几十上百 KB，localStorage 放不下），名单在 localStorage
export async function importFont(file: File): Promise<FontChoice> {
	const data = await file.arrayBuffer()
	try {
		await new FontFace('moco-probe', data).load()
	} catch {
		throw new Error('浏览器认不出这个字体文件')
	}
	const f: CustomFont = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, '') }
	await files.put(f.id, data)
	saveCustomFontList([...customFontList(), f])
	return { key: customKey(f), label: f.name, custom: f }
}

export async function removeFont(f: CustomFont) {
	saveCustomFontList(customFontList().filter(x => x.id !== f.id))
	await files.delete(f.id)
}
