import type { Terminal } from '@xterm/xterm'
import { dlog } from './debug'

// 框里常驻一个零宽字符：框是空的时候 iOS 不报删除，退格就发不出去
const SENTINEL = '​'

const arrow = (c: string) => (t?: Terminal) => (t?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c

type SendKey = { kind: 'send'; id: string; label: string; seq: (t?: Terminal) => string; repeat?: boolean }
type Key = SendKey | { kind: 'ctrl' | 'paste'; id: string; label: string }
export const KEYS: Key[] = [
	{ kind: 'send', id: 'esc', label: 'Esc', seq: () => '\x1b' },
	{ kind: 'send', id: 'tab', label: 'Tab', seq: () => '\t' },
	{ kind: 'ctrl', id: 'ctrl', label: 'Ctrl' },
	{ kind: 'send', id: '^c', label: '^C', seq: () => '\x03' },
	{ kind: 'send', id: '^b', label: '^B', seq: () => '\x02' },
	{ kind: 'send', id: 'left', label: '←', seq: arrow('D'), repeat: true },
	{ kind: 'send', id: 'up', label: '↑', seq: arrow('A'), repeat: true },
	{ kind: 'send', id: 'down', label: '↓', seq: arrow('B'), repeat: true },
	{ kind: 'send', id: 'right', label: '→', seq: arrow('C'), repeat: true },
	{ kind: 'send', id: 'enter', label: '⏎', seq: () => '\r' },
	{ kind: 'paste', id: 'paste', label: '粘贴' },
]
const keyById = new Map(KEYS.map(k => [k.id, k]))

const sendKey = (id: string) => keyById.get(id) as SendKey
const HARDWARE_KEYS: Record<string, SendKey | undefined> = {
	Escape: sendKey('esc'), Tab: sendKey('tab'), ArrowLeft: sendKey('left'), ArrowUp: sendKey('up'), ArrowDown: sendKey('down'), ArrowRight: sendKey('right'),
}

const pressKeepingFocus = (el: HTMLElement, fn: () => void) =>
	el.addEventListener('pointerdown', e => {
		e.preventDefault()
		fn()
	})

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

	for (const btn of root.querySelectorAll<HTMLButtonElement>('#keys button')) {
		const key = keyById.get(btn.dataset.key!)!
		let hold = 0
		const stop = () => {
			clearTimeout(hold)
			clearInterval(hold)
			btn.classList.remove('down')
		}
		pressKeepingFocus(btn, () => {
			btn.classList.add('down')
			if (key.kind === 'ctrl') return setCtrl(!ctrl)
			if (key.kind !== 'send') return
			const fire = () => send(key.seq(term()))
			fire()
			if (key.repeat) hold = window.setTimeout(() => (hold = window.setInterval(fire, 60)), 400)
		})
		btn.addEventListener('pointerup', stop)
		btn.addEventListener('pointercancel', stop)
		btn.addEventListener('pointerleave', stop)
	}

	// 粘贴：iOS 只在点击（click）里放行读剪贴板，按下（pointerdown）不算；系统会先弹一个「粘贴」气泡让人确认
	root.querySelector('[data-key="paste"]')?.addEventListener('click', async () => {
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

	pressKeepingFocus(root.querySelector<HTMLButtonElement>('#kbd')!, () => {
		if (document.activeElement === input) input.blur()
		else input.focus()
	})

	reset()
	return { focus: () => input.focus(), blur: () => input.blur(), paste }
}
