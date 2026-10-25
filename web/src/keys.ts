const DB = 'moco'
const STORE = 'keys'
const ID = 'device'

const EXTRACTABLE = false
const authMessage = (name: string, nonce: string) => new TextEncoder().encode(`moco-auth-v1\n${name}\n${nonce}`)

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
			pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, EXTRACTABLE, ['sign', 'verify'])) as CryptoKeyPair
			await tx('readwrite', s => s.put(pair, ID))
		}
		const pub = b64url(await crypto.subtle.exportKey('raw', pair.publicKey))
		return { pair, pub }
	})()
	cached.catch(() => (cached = undefined))
	return cached
}

export async function signChallenge(name: string, nonce: string): Promise<string> {
	const { pair } = await deviceKey()
	return b64url(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, authMessage(name, nonce)))
}

export async function fingerprint(): Promise<string> {
	const { pub } = await deviceKey()
	return `${pub.slice(0, 4)} ${pub.slice(4, 8)}`
}
