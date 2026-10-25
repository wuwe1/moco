// 键盘：看不见的 textarea 收系统键盘和输入法，按键栏补上手机键盘没有的键
// 打一个字就发一个字；拼音这类输入法拼完（compositionend）才发
import type { Terminal } from '@xterm/xterm'

// 框里常驻一个零宽字符：框是空的时候 iOS 不报删除，退格就发不出去
const SENTINEL = '​'

export function keyboard(term: Terminal, send: (s: string) => void) {
	const input = document.getElementById('input') as HTMLTextAreaElement
	const compose = document.getElementById('compose') as HTMLDivElement
	const ctrlBtn = document.querySelector('[data-key="ctrl"]') as HTMLButtonElement
	let ctrl = false

	const setCtrl = (on: boolean) => {
		ctrl = on
		ctrlBtn.setAttribute('aria-pressed', String(on))
	}
	const reset = () => {
		input.value = SENTINEL
		input.setSelectionRange(1, 1)
	}
	const arrow = (c: string) => (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c
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
		send(term.modes.bracketedPasteMode ? `\x1b[200~${s}\x1b[201~` : s)
	}

	const keys: Record<string, () => string> = {
		esc: () => '\x1b',
		tab: () => '\t',
		'^c': () => '\x03',
		'^b': () => '\x02',
		left: () => arrow('D'),
		up: () => arrow('A'),
		down: () => arrow('B'),
		right: () => arrow('C'),
		enter: () => '\r',
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
	// 外接键盘（iPad、Mac 上调试）
	input.addEventListener('keydown', e => {
		if (e.isComposing) return
		const map: Record<string, string> = {
			Escape: '\x1b', Tab: '\t', ArrowLeft: arrow('D'), ArrowUp: arrow('A'), ArrowDown: arrow('B'), ArrowRight: arrow('C'),
		}
		let out = map[e.key]
		if (!out && e.ctrlKey && e.key.length === 1) out = toCtrl(e.key)
		if (out) {
			e.preventDefault()
			send(out)
		}
	})
	input.addEventListener('focus', reset)

	// 按键栏：pointerdown 就触发并拦掉默认行为，焦点留在输入框里，键盘不会收起
	for (const btn of document.querySelectorAll<HTMLButtonElement>('#keys button')) {
		const key = btn.dataset.key!
		let hold = 0
		const stop = () => {
			clearTimeout(hold)
			clearInterval(hold)
			btn.classList.remove('down')
		}
		btn.addEventListener('pointerdown', e => {
			e.preventDefault()
			btn.classList.add('down')
			if (key === 'ctrl') return setCtrl(!ctrl)
			send(keys[key]())
			if (btn.hasAttribute('data-repeat')) hold = window.setTimeout(() => (hold = window.setInterval(() => send(keys[key]()), 60)), 400)
		})
		btn.addEventListener('pointerup', stop)
		btn.addEventListener('pointercancel', stop)
		btn.addEventListener('pointerleave', stop)
	}

	const kbd = document.getElementById('kbd') as HTMLButtonElement
	kbd.addEventListener('pointerdown', e => {
		e.preventDefault()
		if (document.activeElement === input) input.blur()
		else input.focus()
	})

	reset()
	return { focus: () => input.focus() }
}
