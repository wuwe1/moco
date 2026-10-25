import { isFontKey, type FontKey } from './fonts'
import { BUILTIN, type Theme } from './themes'

export type Host = {
	id: string
	name: string
	url: string
	added: number
	lastUsed?: number
}

export type Screen = { image: string; at: number }

const HOSTS = 'moco.hosts'
const FONT = 'moco.fontSize'
const DEVICE = 'moco.deviceName'
const FONT_FAMILY = 'moco.fontFamily'
const THEME = 'moco.theme'
const CUSTOM_THEMES = 'moco.customThemes'
const TERM_PREFS = 'moco.termPrefs'
const screenKey = (id: string) => `moco.screen.${id}`

export function loadHosts(): Host[] {
	try {
		return JSON.parse(localStorage.getItem(HOSTS) ?? '[]')
	} catch {
		return []
	}
}

export function saveHosts(hosts: Host[]) {
	localStorage.setItem(HOSTS, JSON.stringify(hosts))
}

export function loadScreen(id: string): Screen | undefined {
	try {
		const s = JSON.parse(localStorage.getItem(screenKey(id)) ?? 'null')
		return typeof s?.image === 'string' ? s : undefined
	} catch {
		return undefined
	}
}

export function saveScreen(id: string, s: Screen) {
	try {
		localStorage.setItem(screenKey(id), JSON.stringify(s))
	} catch {
	}
}

export function dropScreen(id: string) {
	localStorage.removeItem(screenKey(id))
}

export const FONT_MIN = 9
export const FONT_MAX = 24
export const fontSize = () => Number(localStorage.getItem(FONT)) || 13
export const setFontSize = (n: number) => localStorage.setItem(FONT, String(n))

export const fontKey = (): FontKey => {
	const k = localStorage.getItem(FONT_FAMILY)
	return isFontKey(k) ? k : 'system'
}
export const setFontKey = (k: FontKey) => localStorage.setItem(FONT_FAMILY, k)

export const deviceName = () => localStorage.getItem(DEVICE) ?? 'iPhone'
export const setDeviceName = (s: string) => localStorage.setItem(DEVICE, s)

export function normalizeUrl(input: string): string {
	let s = input.trim().replace(/\/+$/, '')
	if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s
	const u = new URL(s)
	return `${u.protocol}//${u.host}`
}

const readJSON = <T>(key: string, fallback: T): T => {
	try {
		return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback
	} catch {
		return fallback
	}
}

export const customThemes = (): Theme[] =>
	readJSON<Theme[]>(CUSTOM_THEMES, []).filter(t => t && typeof t.id === 'string' && Array.isArray(t.ansi) && t.ansi.length === 16)
export const saveCustomThemes = (list: Theme[]) => localStorage.setItem(CUSTOM_THEMES, JSON.stringify(list))
export const allThemes = () => [...BUILTIN, ...customThemes()]
export const currentTheme = (): Theme => {
	const id = localStorage.getItem(THEME)
	return allThemes().find(t => t.id === id) ?? BUILTIN[0]
}
export const setThemeId = (id: string) => localStorage.setItem(THEME, id)

export type CursorStyle = 'block' | 'underline' | 'bar'
export type TermPrefs = { cursorStyle: CursorStyle; cursorBlink: boolean; boldBright: boolean }
const DEFAULT_PREFS: TermPrefs = { cursorStyle: 'block', cursorBlink: false, boldBright: true }
export const termPrefs = (): TermPrefs => ({ ...DEFAULT_PREFS, ...readJSON<Partial<TermPrefs>>(TERM_PREFS, {}) })
export const setTermPrefs = (p: TermPrefs) => localStorage.setItem(TERM_PREFS, JSON.stringify(p))
