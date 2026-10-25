import { useCallback, useEffect, useState } from 'react'

// 拿一份数据：deps 变了重拿；reload 手动重拿。旧的请求回来晚了不覆盖新的
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
	const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
	const [nonce, setNonce] = useState(0)
	useEffect(() => {
		let live = true
		setState(s => ({ data: s.data, loading: true }))
		load().then(
			data => live && setState({ data, loading: false }),
			e => live && setState({ error: e instanceof Error ? e.message : String(e), loading: false }),
		)
		return () => {
			live = false
		}
	}, [...deps, nonce])
	return { ...state, reload: useCallback(() => setNonce(n => n + 1), []) }
}
