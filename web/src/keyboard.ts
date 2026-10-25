import type { Terminal } from '@xterm/xterm'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowRightToLine, ArrowUp, ClipboardPaste, CornerDownLeft, type LucideIcon } from 'lucide-preact'
import { dlog } from './debug'

// 框里常驻一个零宽字符：框是空的时候 iOS 不报删除，退格就发不出去
const SENTINEL = '​'

const arrow = (c: string) => (t?: Terminal) => (t?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c

type Face = { id: string; label: string; icon?: LucideIcon; pinned?: boolean }
type SendKey = Face & { kind: 'send'; seq: (t?: Terminal) => string; repeat?: boolean }
type Key = SendKey | (Face & { kind: 'ctrl' | 'paste' })
export const KEYS: Key[] = [
	{ kind: 'send', id: 'esc', label: 'Esc', seq: () => '\x1b' },
	{ kind: 'send', id: 'tab', label: 'Tab', icon: ArrowRightToLine, seq: () => '\t' },
	{ kind: 'ctrl', id: 'ctrl', label: 'Ctrl' },
	{ kind: 'send', id: '^c', label: '^C', seq: () => '\x03' },
	{ kind: 'send', id: '^b', label: '^B', seq: () => '\x02' },
	{ kind: 'send', id: 'left', label: '左', icon: ArrowLeft, seq: arrow('D'), repeat: true },
	{ kind: 'send', id: 'up', label: '上', icon: ArrowUp, seq: arrow('A'), repeat: true },
	{ kind: 'send', id: 'down', label: '下', icon: ArrowDown, seq: arrow('B'), repeat: true },
	{ kind: 'send', id: 'right', label: '右', icon: ArrowRight, seq: arrow('C'), repeat: true },
	{ kind: 'paste', id: 'paste', label: '粘贴', icon: ClipboardPaste },
	{ kind: 'send', id: 'enter', label: '回车', icon: CornerDownLeft, seq: () => '\r', pinned: true },
]
const keyById = new Map(KEYS.map(k => [k.id, k]))

const sendKey = (id: string) => keyById.get(id) as SendKey
const HARDWARE_KEYS: Record<string, SendKey | undefined> = {
	Escape: sendKey('esc'), Tab: sendKey('tab'), ArrowLeft: sendKey('left'), ArrowUp: sendKey('up'), ArrowDown: sendKey('down'), ArrowRight: sendKey('right'),
}

const SLOP_PX = 12
const REPEAT_AFTER_MS = 400
const REPEAT_EVERY_MS = 60

function pressable(btn: HTMLElement, on: { release: () => void; repeat?: () => void }) {
	let armed = false
	let repeating = false
	let timer = 0
	const over = (e: PointerEvent) => {
		const r = btn.getBoundingClientRect()
		return e.clientX >= r.left - SLOP_PX && e.clientX <= r.right + SLOP_PX && e.clientY >= r.top - SLOP_PX && e.clientY <= r.bottom + SLOP_PX
	}
	const cancel = () => {
		armed = repeating = false
		clearTimeout(timer)
		clearInterval(timer)
		btn.classList.remove('down')
	}
	btn.addEventListener('pointerdown', e => {
		e.preventDefault()
		armed = true
		btn.classList.add('down')
		const { repeat } = on
		if (repeat)
			timer = window.setTimeout(() => {
				repeating = true
				repeat()
				timer = window.setInterval(repeat, REPEAT_EVERY_MS)
			}, REPEAT_AFTER_MS)
	})
	btn.addEventListener('pointermove', e => {
		if (armed && !over(e)) cancel()
	})
	btn.addEventListener('pointerup', e => {
		const released = armed && !repeating && over(e)
		cancel()
		if (released) on.release()
	})
	btn.addEventListener('pointercancel', cancel)
}

export function keyboard(root: HTMLElement, term: () => Terminal | undefined, send: (s: string) => void, onPasteFailed: () => void) {
	const input = root.querySelector('#input') as HTMLTextAreaElement
	const compose = root.querySelector('#compose') as HTMLDivElement
	const ctrlBtn = root.querySelector('[data-key="ctrl"]') as HTMLButtonElement
	let ctrl = false

	const setCtrl = (on: boolean) => {
		ctrl = on
		ctrlBtn.setAttribute('aria-pressed', String(on))
	}
	const reset = () => {
		input.value = SENTINEL
		input.setSelectionRange(1, 1)
	}
	const toCtrl = (c: string) => {
		const code = c.toUpperCase().charCodeAt(0)
		if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
		if (c === ' ') return '\x00'
		if (c === '?') return '\x7f'
		return c
	}
	const type = (s: string) => {
		if (ctrl && s.length === 1) {
			s = toCtrl(s)
			setCtrl(false)
		}
		send(s)
	}
	const paste = (s: string) => {
		s = s.replace(/\r?\n/g, '\r')
		const bracketed = term()?.modes.bracketedPasteMode
		const lines = s.split('\r').length
		if (!bracketed && lines > 1 && !confirm(`粘贴 ${lines} 行？终端里的程序没开粘贴模式，每一行都会像按了回车一样执行。`)) return
		send(bracketed ? `\x1b[200~${s}\x1b[201~` : s)
	}

	input.addEventListener('beforeinput', e => {
		if (e.isComposing || e.inputType === 'insertCompositionText') return
		switch (e.inputType) {
			case 'insertText':
			case 'insertReplacementText':
				e.preventDefault()
				if (e.data) type(e.data)
				break
			case 'insertLineBreak':
			case 'insertParagraph':
				e.preventDefault()
				send('\r')
				break
			case 'deleteContentBackward':
				e.preventDefault()
				send('\x7f')
				break
			case 'insertFromPaste':
				e.preventDefault()
				paste(e.data ?? e.dataTransfer?.getData('text/plain') ?? '')
				break
		}
	})
	input.addEventListener('compositionupdate', e => {
		compose.textContent = e.data
		compose.hidden = !e.data
	})
	input.addEventListener('compositionend', e => {
		compose.hidden = true
		if (e.data) type(e.data)
		setTimeout(reset)
	})
	input.addEventListener('keydown', e => {
		if (e.isComposing) return
		let out = HARDWARE_KEYS[e.key]?.seq(term())
		if (!out && e.ctrlKey && e.key.length === 1) out = toCtrl(e.key)
		if (out) {
			e.preventDefault()
			send(out)
		}
	})
	input.addEventListener('focus', reset)

	let pasteReleased = false
	for (const btn of root.querySelectorAll<HTMLButtonElement>('#bar [data-key]')) {
		const key = keyById.get(btn.dataset.key!)!
		if (key.kind === 'send') {
			const fire = () => send(key.seq(term()))
			pressable(btn, { release: fire, repeat: key.repeat ? fire : undefined })
		} else if (key.kind === 'ctrl') pressable(btn, { release: () => setCtrl(!ctrl) })
		else pressable(btn, { release: () => (pasteReleased = true) })
	}

	// 粘贴：iOS 只在点击（click）里放行读剪贴板，按下（pointerdown）不算；系统会先弹一个「粘贴」气泡让人确认
	root.querySelector('[data-key="paste"]')?.addEventListener('click', async () => {
		if (!pasteReleased) return
		pasteReleased = false
		try {
			const text = await navigator.clipboard.readText()
			dlog(`读剪贴板：${text.length} 个字`)
			if (text) paste(text)
			else onPasteFailed()
		} catch (e) {
			dlog(`读剪贴板失败：${e}`)
			onPasteFailed()
		}
	})

	pressable(root.querySelector<HTMLButtonElement>('#kbd')!, {
		release: () => {
			if (document.activeElement === input) input.blur()
			else input.focus()
		},
	})

	reset()
	return { focus: () => input.focus(), blur: () => input.blur(), paste }
}
