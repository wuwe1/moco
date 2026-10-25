import type { Terminal } from '@xterm/xterm'
import { ArrowRightToLine, ClipboardPaste, CornerDownLeft, ImagePlus, Move, type LucideIcon } from 'lucide-react'
import { dlog } from './debug'

// 框里常驻一个零宽字符：框是空的时候 iOS 不报删除，退格就发不出去
const SENTINEL = '​'

const arrow = (c: string) => (t?: Terminal) => (t?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c

type Dir = 'up' | 'down' | 'left' | 'right'
const ARROWS: Record<Dir, (t?: Terminal) => string> = { up: arrow('A'), down: arrow('B'), right: arrow('C'), left: arrow('D') }

type Face = { id: string; label: string; icon?: LucideIcon }
type SendKey = Face & { kind: 'send'; seq: (t?: Terminal) => string }
type Key = SendKey | (Face & { kind: 'ctrl' | 'dpad' | 'paste' | 'image' })
export const KEYS: Key[] = [
	{ kind: 'send', id: 'esc', label: 'Esc', seq: () => '\x1b' },
	{ kind: 'send', id: 'tab', label: 'Tab', icon: ArrowRightToLine, seq: () => '\t' },
	{ kind: 'ctrl', id: 'ctrl', label: 'Ctrl' },
	{ kind: 'send', id: '^c', label: '^C', seq: () => '\x03' },
	{ kind: 'send', id: '^b', label: '^B', seq: () => '\x02' },
	{ kind: 'dpad', id: 'dpad', label: '方向', icon: Move },
	{ kind: 'paste', id: 'paste', label: '粘贴', icon: ClipboardPaste },
	{ kind: 'image', id: 'image', label: '图片', icon: ImagePlus },
	{ kind: 'send', id: 'enter', label: '回车', icon: CornerDownLeft, seq: () => '\r' },
]
const keyById = new Map(KEYS.map(k => [k.id, k]))

const sendKey = (id: string) => (keyById.get(id) as SendKey).seq
const HARDWARE_KEYS: Record<string, ((t?: Terminal) => string) | undefined> = {
	Escape: sendKey('esc'), Tab: sendKey('tab'), ArrowLeft: ARROWS.left, ArrowUp: ARROWS.up, ArrowDown: ARROWS.down, ArrowRight: ARROWS.right,
}

const SLOP_PX = 12
const DPAD_DEAD_PX = 10
const DPAD_FAR_PX = 40
const DPAD_REPEAT_AFTER_MS = 300
const DPAD_NEAR_EVERY_MS = 120
const DPAD_FAR_EVERY_MS = 40

function dpad(btn: HTMLElement, fire: (d: Dir) => void) {
	let origin: { x: number; y: number } | undefined
	let dir: Dir | undefined
	let dist = 0
	let timer = 0
	const tick = () => {
		if (!dir) return
		fire(dir)
		timer = window.setTimeout(tick, dist >= DPAD_FAR_PX ? DPAD_FAR_EVERY_MS : DPAD_NEAR_EVERY_MS)
	}
	const aim = (next?: Dir) => {
		if (next === dir) return
		dir = next
		clearTimeout(timer)
		if (!next) return void delete btn.dataset.dir
		btn.dataset.dir = next
		fire(next)
		timer = window.setTimeout(tick, DPAD_REPEAT_AFTER_MS)
	}
	const end = () => {
		origin = undefined
		aim(undefined)
		btn.classList.remove('down')
	}
	btn.addEventListener('pointerdown', e => {
		e.preventDefault()
		btn.setPointerCapture(e.pointerId)
		origin = { x: e.clientX, y: e.clientY }
		btn.classList.add('down')
	})
	btn.addEventListener('pointermove', e => {
		if (!origin) return
		const dx = e.clientX - origin.x
		const dy = e.clientY - origin.y
		dist = Math.hypot(dx, dy)
		if (dist < DPAD_DEAD_PX) aim(undefined)
		else if (Math.abs(dx) > Math.abs(dy)) aim(dx > 0 ? 'right' : 'left')
		else aim(dy > 0 ? 'down' : 'up')
	})
	btn.addEventListener('pointerup', end)
	btn.addEventListener('pointercancel', end)
}

// click：iOS 只在 click 里放行读剪贴板；在 pointerup 里 focus() 输入框，随后 iOS 补发的那次轻点会把焦点又拿走，键盘弹一下就收回去
function pressable(btn: HTMLElement, on: { release?: () => void; click?: () => void }) {
	let armed = false
	let released = false
	const over = (e: PointerEvent) => {
		const r = btn.getBoundingClientRect()
		return e.clientX >= r.left - SLOP_PX && e.clientX <= r.right + SLOP_PX && e.clientY >= r.top - SLOP_PX && e.clientY <= r.bottom + SLOP_PX
	}
	const cancel = () => {
		armed = false
		btn.classList.remove('down')
	}
	btn.addEventListener('pointerdown', e => {
		e.preventDefault()
		armed = true
		btn.classList.add('down')
	})
	btn.addEventListener('pointermove', e => {
		if (armed && !over(e)) cancel()
	})
	btn.addEventListener('pointerup', e => {
		released = armed && over(e)
		cancel()
		if (released) on.release?.()
	})
	btn.addEventListener('pointercancel', cancel)
	const { click } = on
	if (click)
		btn.addEventListener('click', () => {
			if (!released) return
			released = false
			click()
		})
}

type Hooks = {
	term: () => Terminal | undefined
	send: (s: string) => void
	onPasteFailed: () => void
	onPickImage: () => void
}

export function keyboard(root: HTMLElement, { term, send, onPasteFailed, onPickImage }: Hooks) {
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
		let out = HARDWARE_KEYS[e.key]?.(term())
		if (!out && e.ctrlKey && e.key.length === 1) out = toCtrl(e.key)
		if (out) {
			e.preventDefault()
			send(out)
		}
	})
	input.addEventListener('focus', reset)

	const readClipboard = async () => {
		try {
			const text = await navigator.clipboard.readText()
			dlog(`读剪贴板：${text.length} 个字`)
			if (text) paste(text)
			else onPasteFailed()
		} catch (e) {
			dlog(`读剪贴板失败：${e}`)
			onPasteFailed()
		}
	}
	for (const btn of root.querySelectorAll<HTMLButtonElement>('#bar [data-key]')) {
		const key = keyById.get(btn.dataset.key!)!
		if (key.kind === 'send') pressable(btn, { release: () => send(key.seq(term())) })
		else if (key.kind === 'dpad') dpad(btn, d => send(ARROWS[d](term())))
		else if (key.kind === 'ctrl') pressable(btn, { release: () => setCtrl(!ctrl) })
		else if (key.kind === 'paste') pressable(btn, { click: readClipboard })
		else pressable(btn, { click: onPickImage })
	}

	pressable(root.querySelector<HTMLButtonElement>('#kbd')!, {
		click: () => {
			if (document.activeElement === input) input.blur()
			else input.focus()
		},
	})

	reset()
	return { focus: () => input.focus(), blur: () => input.blur(), paste }
}
