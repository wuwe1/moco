// 写手机剪贴板。iOS 只在点按的处理函数里允许写；不是 https 的页面没有 navigator.clipboard，退回 execCommand
export async function writeClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		const ta = document.createElement('textarea')
		ta.value = text
		ta.setAttribute('readonly', '')
		ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
		document.body.appendChild(ta)
		ta.select()
		ta.setSelectionRange(0, text.length)
		const ok = document.execCommand('copy')
		ta.remove()
		return ok
	}
}
