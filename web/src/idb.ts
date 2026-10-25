// 一个库一张表的 IndexedDB：键值存取。设备密钥另有自己的库（keys.ts），不和它混
export function idbStore<T>(db: string, store: string) {
	const open = () =>
		new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(db, 1)
			req.onupgradeneeded = () => req.result.createObjectStore(store)
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
	const run = <R>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<R>) =>
		open().then(
			d =>
				new Promise<R>((resolve, reject) => {
					const req = fn(d.transaction(store, mode).objectStore(store))
					req.onsuccess = () => resolve(req.result)
					req.onerror = () => reject(req.error)
				}),
		)
	return {
		get: (key: string) => run<T | undefined>('readonly', s => s.get(key)),
		put: (key: string, value: T) => run('readwrite', s => s.put(value, key)),
		delete: (key: string) => run('readwrite', s => s.delete(key)),
	}
}
