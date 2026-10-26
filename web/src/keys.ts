import { idbStore } from './idb'

const ID = 'device'
const keys = idbStore<CryptoKeyPair>('moco', 'keys')

const EXTRACTABLE = false
const authMessage = (name: string, nonce: string) => new TextEncoder().encode(`moco-auth-v1\n${name}\n${nonce}`)

type DeviceKey = { pair: CryptoKeyPair; pub: string }
let cached: Promise<DeviceKey> | undefined

export const b64url = (b: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function deviceKey(): Promise<DeviceKey> {
	cached ??= (async () => {
		let pair = await keys.get(ID)
		if (!pair) {
			pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, EXTRACTABLE, ['sign', 'verify'])) as CryptoKeyPair
			await keys.put(ID, pair)
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
