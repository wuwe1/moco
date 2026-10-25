// 手机上存的东西：连接列表、每个连接最后一屏、字号、配对时报的手机名。设备密钥在 keys.ts（IndexedDB）
export type Host = {
	id: string
	name: string // mocod 报的机器名，签名里也用它，连上时核对
	url: string // https://my-mac.tailnet-name.ts.net
	added: number
	lastUsed?: number
}

export type Screen = { html: string; at: number }

const HOSTS = 'moco.hosts'
const FONT = 'moco.fontSize'
const DEVICE = 'moco.deviceName'
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
		return JSON.parse(localStorage.getItem(screenKey(id)) ?? 'null') ?? undefined
	} catch {
		return undefined
	}
}

export function saveScreen(id: string, s: Screen) {
	try {
		localStorage.setItem(screenKey(id), JSON.stringify(s))
	} catch {
		// 存满了就不存缩略图，不影响使用
	}
}

export function dropScreen(id: string) {
	localStorage.removeItem(screenKey(id))
}

export const fontSize = () => Number(localStorage.getItem(FONT)) || 13
export const setFontSize = (n: number) => localStorage.setItem(FONT, String(n))

export const deviceName = () => localStorage.getItem(DEVICE) ?? 'iPhone'
export const setDeviceName = (s: string) => localStorage.setItem(DEVICE, s)

// 用户输入的地址整理成 https://主机名：可以只填主机名
export function normalizeUrl(input: string): string {
	let s = input.trim().replace(/\/+$/, '')
	if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s
	const u = new URL(s)
	return `${u.protocol}//${u.host}`
}
