// 这台手机的设备密钥：Ed25519，私钥标成不可导出，存在本站自己的 IndexedDB 里。
// 别的网站读不到；连本站的代码也只能拿它签名，取不出私钥本身
const DB = 'moco'
const STORE = 'keys'
const ID = 'device'

type DeviceKey = { pair: CryptoKeyPair; pub: string }
let cached: Promise<DeviceKey> | undefined

export const b64url = (b: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function db(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1)
		req.onupgradeneeded = () => req.result.createObjectStore(STORE)
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return db().then(d => new Promise((resolve, reject) => {
		const req = fn(d.transaction(STORE, mode).objectStore(STORE))
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	}))
}

export function deviceKey(): Promise<DeviceKey> {
	cached ??= (async () => {
		let pair = await tx<CryptoKeyPair | undefined>('readonly', s => s.get(ID))
		if (!pair) {
			pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair
			await tx('readwrite', s => s.put(pair, ID))
		}
		const pub = b64url(await crypto.subtle.exportKey('raw', pair.publicKey))
		return { pair, pub }
	})()
	cached.catch(() => (cached = undefined))
	return cached
}

// 和 mocod 的 auth.Message 一字不差
export async function signChallenge(name: string, nonce: string): Promise<string> {
	const { pair } = await deviceKey()
	const msg = new TextEncoder().encode(`moco-auth-v1\n${name}\n${nonce}`)
	return b64url(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, msg))
}

// 给人看的指纹：公钥前 8 个字符，分两组
export async function fingerprint(): Promise<string> {
	const { pub } = await deviceKey()
	return `${pub.slice(0, 4)} ${pub.slice(4, 8)}`
}
