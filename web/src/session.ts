import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { Terminal } from '@xterm/xterm'
import { useEffect, useState } from 'preact/hooks'
import { Conn } from './conn'
import { theme } from './theme'
import { dlog } from './debug'
import { gestures } from './gestures'
import { grid, locate } from './grid'
import { ImageLayer } from './images'
import { fontSize, keyboardMode, saveScreen, setFontSize, type Host } from './store'

const THAW_AFTER_MS = 800

const sessions = new Map<string, Session>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(fn => fn())

export function useRerenderOnSessionChange() {
	const [, bump] = useState(0)
	useEffect(() => {
		const fn = () => bump(n => n + 1)
		listeners.add(fn)
		return () => void listeners.delete(fn)
	}, [])
}

export function getOrCreateSession(host: Host): Session {
	let s = sessions.get(host.id)
	if (!s) {
		s = new Session(host)
		sessions.set(host.id, s)
	}
	return s
}

export const connOf = (id: string): Conn | undefined => sessions.get(id)?.conn

export function dropSession(id: string) {
	sessions.get(id)?.dispose()
	sessions.delete(id)
	changed()
}

export class Session {
	readonly el = document.createElement('div')
	readonly term: Terminal
	readonly conn: Conn
	readonly images: ImageLayer
	private fit = new FitAddon()
	private serializer = new SerializeAddon()
	private opened = false
	private panned = false
	private frozen?: HTMLElement
	private thawTimer = 0
	onPlainTap = () => {}
	onImage = (_img: { png: Uint8Array<ArrayBuffer>; w: number; h: number }) => {}

	constructor(readonly host: Host) {
		this.el.className = 'pane'
		this.term = new Terminal({
			fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
			fontSize: fontSize(),
			theme,
			// 不留本地回滚：滚动都交给 herdr；留了 fit 会在右边给滚动条让出 14px
			scrollback: 0,
			cursorBlink: false,
			// 字宽插件还在 proposed API 里
			allowProposedApi: true,
		})
		// 字宽按字素簇算（👨‍👩‍👧 算一个字、占两格），和 herdr 排版的算法一致；
		// 默认的 Unicode 6 表会让带 emoji 的行错位（tools/vtcheck 里对过）
		this.term.loadAddon(new UnicodeGraphemesAddon())
		this.term.unicode.activeVersion = '15-graphemes'
		this.term.loadAddon(this.fit)
		this.term.loadAddon(this.serializer)
		this.images = new ImageLayer(this.term)
		this.conn = new Conn(
			host,
			this.term,
			state => {
				this.el.classList.toggle('offline', state !== 'open')
				changed()
			},
			this.images,
		)
		this.conn.onFrameDrawn = () => this.thaw()
		this.term.onRender(() => this.follow())
		this.term.onData(d => this.conn.send(d))
		this.term.onResize(({ cols, rows }) => {
			dlog(`终端改成 ${cols}×${rows}`)
			this.conn.resize(cols, rows)
		})
	}

	attach(parent: HTMLElement) {
		dlog(`打开 ${this.host.name}，连接状态 ${this.conn.state}`)
		if (this.el.parentElement !== parent) parent.appendChild(this.el)
		this.el.hidden = false
		this.openOnFirstAttach()
		this.fitNow()
		if (this.conn.state === 'closed') this.conn.connect()
	}

	private openOnFirstAttach() {
		if (this.opened) return
		this.opened = true
		this.term.open(this.el)
		this.images.mount()
		gestures(this.el, this.term, { onTap: (x, y) => this.tap(x, y), onFont: setFontForAllSessions })
	}

	private tap(x: number, y: number) {
		const img = this.images.hit(x, y)
		if (img) return this.onImage(img)
		if (!this.click(x, y)) this.onPlainTap()
	}

	// 程序开了鼠标上报（herdr、pi 都开）：在那一格按下、松开左键。
	// 用 xterm.js 内部的鼠标服务编码（按程序设的 SGR 等格式），不派发 DOM 的 mousedown：
	// 那样 xterm.js 会把焦点抢到它自己的输入框，弹出另一个键盘
	private click(clientX: number, clientY: number) {
		const mouse = (this.term as any)._core?.coreMouseService
		const p = locate(this.term, clientX, clientY)
		if (this.term.modes.mouseTrackingMode === 'none' || !mouse?.triggerMouseEvent || !p) return false
		const at = {
			col: p.col,
			row: p.row,
			x: Math.round(p.x),
			y: Math.round(p.y),
			button: 0,
			ctrl: false,
			alt: false,
			shift: false,
		}
		mouse.triggerMouseEvent({ ...at, action: 1 })
		mouse.triggerMouseEvent({ ...at, action: 0 })
		return true
	}

	detach() {
		dlog(`收起 ${this.host.name}，连接状态 ${this.conn.state}`)
		this.snapshot()
		this.el.hidden = true
	}

	layout(keyboardOpen: boolean) {
		const mode = keyboardMode()
		this.panned = keyboardOpen && mode === 'pan'
		if (this.panned) return this.follow()
		this.el.style.height = ''
		this.el.style.transform = ''
		this.fitNow(mode === 'swap')
	}

	fitNow(hideUntilNewFrame = false) {
		if (!this.opened || this.el.hidden || this.panned) return
		const before = `${this.term.cols}x${this.term.rows}`
		if (hideUntilNewFrame) this.freeze()
		this.fit.fit()
		if (`${this.term.cols}x${this.term.rows}` === before) this.thaw()
		this.images.draw()
	}

	private follow() {
		const g = this.panned && grid(this.term)
		if (!g) return
		const full = g.screen.offsetTop + g.screen.offsetHeight
		const visible = this.el.parentElement!.clientHeight
		const cursorBottom = g.screen.offsetTop + (this.term.buffer.active.cursorY + 1) * g.ch
		const y = Math.min(Math.max(0, cursorBottom - visible), Math.max(0, full - visible))
		this.el.style.height = `${full}px`
		this.el.style.transform = `translateY(${-y}px)`
	}

	private freeze() {
		const screen = grid(this.term)?.screen
		if (this.frozen || !screen) return
		const shot = screen.cloneNode(true) as HTMLElement
		shot.className = 'frozen'
		shot.style.left = `${screen.offsetLeft}px`
		shot.style.top = `${screen.offsetTop}px`
		screen.parentElement!.appendChild(shot)
		this.frozen = shot
		this.thawTimer = window.setTimeout(() => {
			dlog(`截图盖了 ${THAW_AFTER_MS}ms 还没等到新尺寸的帧，直接揭掉`)
			this.thaw()
		}, THAW_AFTER_MS)
	}

	private thaw() {
		clearTimeout(this.thawTimer)
		this.frozen?.remove()
		this.frozen = undefined
	}

	snapshot() {
		if (!this.opened || this.conn.state !== 'open') return
		saveScreen(this.host.id, { html: this.serializer.serializeAsHTML({ includeGlobalBackground: true }), at: Date.now() })
	}

	dispose() {
		this.conn.close()
		this.term.dispose()
		this.el.remove()
	}
}

function setFontForAllSessions(size: number) {
	setFontSize(size)
	sessions.forEach(s => {
		s.term.options.fontSize = size
		s.fitNow()
	})
}
