import { dlog } from './debug'
import { allWatches, onWatchReady, type Watch } from './herdr'
import { idbStore } from './idb'
import { b64url } from './keys'

// 推送：手机生成一把 VAPID 密钥、订阅一次，把订阅交给连着的每台 mocod，由它们在 agent 等人、干完活时发通知。
// 一个订阅只认一把 VAPID 密钥，所以密钥是手机的，不是每台电脑各一把
type Vapid = { public: string; private: string }
type Params = { endpoint: string; keys: { p256dh: string; auth: string }; vapid: Vapid }

const ENABLED = 'moco.push'
const vapidStore = idbStore<Vapid>('moco-push', 'vapid')

export const pushEnabled = () => localStorage.getItem(ENABLED) === '1'

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

// install：iPhone 上只有添加到主屏幕、从主屏幕打开的 moco 才能收推送
export type PushSupport = 'ok' | 'install' | 'denied' | 'unsupported'
export function pushSupport(): PushSupport {
	if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIOS() && !standalone() ? 'install' : 'unsupported'
	if (Notification.permission === 'denied') return 'denied'
	return 'ok'
}

async function vapid(): Promise<Vapid> {
	const saved = await vapidStore.get('key')
	if (saved) return saved
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
	const pub = b64url(await crypto.subtle.exportKey('raw', pair.publicKey))
	const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
	const key = { public: pub, private: jwk.d! }
	await vapidStore.put('key', key)
	return key
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

// 现在的订阅；create 时没有就订一个（要已经给了通知权限）
async function params(create: boolean): Promise<Params | undefined> {
	const reg = await navigator.serviceWorker.register('/sw.js')
	await navigator.serviceWorker.ready
	const key = await vapid()
	let sub = await reg.pushManager.getSubscription()
	const subKey = sub?.options.applicationServerKey
	if (sub && subKey && b64url(subKey) !== key.public) {
		await sub.unsubscribe()
		sub = null
	}
	if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(key.public) })
	if (!sub) return
	const json = sub.toJSON()
	return { endpoint: sub.endpoint, keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth }, vapid: key }
}

const supportsPush = (w: Watch) => w.features.includes('push')

const subscribe = (w: Watch, p: Params) => w.request('push.subscribe', { params: { ...p, host: w.host.id } })

// 每台电脑的结果：成功 undefined，失败是原因
export type PerHost = { name: string; error?: string }[]

async function eachHost(fn: (w: Watch) => Promise<unknown>): Promise<PerHost> {
	return Promise.all(
		allWatches().map(async w => {
			if (!supportsPush(w)) return { name: w.host.name, error: 'mocod 太旧，更新一下' }
			try {
				await fn(w)
				return { name: w.host.name }
			} catch (e) {
				return { name: w.host.name, error: e instanceof Error ? e.message : String(e) }
			}
		}),
	)
}

// 要在点按里调：iOS 只在用户点了之后才弹权限框
export async function enablePush(): Promise<PerHost> {
	if ((await Notification.requestPermission()) !== 'granted') throw new Error('没给通知权限')
	const p = await params(true)
	if (!p) throw new Error('订阅失败')
	localStorage.setItem(ENABLED, '1')
	return eachHost(w => subscribe(w, p))
}

export async function disablePush(): Promise<PerHost> {
	localStorage.removeItem(ENABLED)
	const result = await eachHost(w => w.request('push.unsubscribe'))
	const reg = await navigator.serviceWorker.getRegistration()
	await (await reg?.pushManager.getSubscription())?.unsubscribe()
	return result
}

export const testPush = () => eachHost(w => w.request('push.test'))

// 每次连上一台电脑都把订阅再交一次：新加的电脑、mocod 换了机器、订阅被浏览器换过都能接上
onWatchReady(async w => {
	if (!pushEnabled() || !supportsPush(w) || pushSupport() !== 'ok' || Notification.permission !== 'granted') return
	try {
		const p = await params(true)
		if (p) await subscribe(w, p)
	} catch (e) {
		dlog(`推送订阅没交给 ${w.host.name}：${e}`)
	}
})
