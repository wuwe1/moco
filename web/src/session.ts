// 一个连接 = 一个终端 + 一条到 mocod 的连接。离开终端页时不断开，回来立刻能用；
// 离开时把当前这一屏存成 HTML，首页的缩略图就是它
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import { Conn, type State } from './conn'
import { dlog } from './debug'
import { gestures } from './gestures'
import { fontSize, saveScreen, setFontSize, type Host } from './store'

// gruvbox 深色，和 herdr、Ghostty 的配色一致
export const theme = {
	background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
	black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
	brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
}

const sessions = new Map<string, Session>()
const listeners = new Set<() => void>()
export const onSessionsChange = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn))
const changed = () => listeners.forEach(fn => fn())

export function session(host: Host): Session {
	let s = sessions.get(host.id)
	if (!s) {
		s = new Session(host)
		sessions.set(host.id, s)
	}
	return s
}

export const stateOf = (id: string): State | undefined => sessions.get(id)?.conn.state

export function dropSession(id: string) {
	sessions.get(id)?.dispose()
	sessions.delete(id)
	changed()
}

export function forEachSession(fn: (s: Session) => void) {
	sessions.forEach(fn)
}

export class Session {
	readonly el = document.createElement('div')
	readonly term: Terminal
	readonly conn: Conn
	private fit = new FitAddon()
	private serializer = new SerializeAddon()
	private opened = false
	onTap = () => {}

	constructor(readonly host: Host) {
		this.el.className = 'pane'
		this.term = new Terminal({
			fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
			fontSize: fontSize(),
			theme,
			// 不留本地回滚：滚动都交给 herdr；留了 fit 会在右边给滚动条让出 14px
			scrollback: 0,
			cursorBlink: false,
		})
		this.term.loadAddon(this.fit)
		this.term.loadAddon(this.serializer)
		this.conn = new Conn(host, this.term, state => {
			this.el.classList.toggle('offline', state !== 'open')
			changed()
		})
		this.term.onData(d => this.conn.send(d))
		this.term.onResize(({ cols, rows }) => this.conn.resize(cols, rows))
	}

	// 挂到终端页上：第一次挂上时才真正打开终端、开始连接（xterm 要量得到尺寸）
	attach(parent: HTMLElement) {
		dlog(`打开 ${this.host.name}，连接状态 ${this.conn.state}`)
		if (this.el.parentElement !== parent) parent.appendChild(this.el)
		this.el.hidden = false
		if (!this.opened) {
			this.opened = true
			this.term.open(this.el)
			gestures(this.el, this.term, { onTap: () => this.onTap(), onFont: setFont })
		}
		this.fitNow()
		if (this.conn.state === 'closed') this.conn.connect()
	}

	detach() {
		dlog(`收起 ${this.host.name}，连接状态 ${this.conn.state}`)
		this.snapshot()
		this.el.hidden = true
	}

	fitNow() {
		if (this.opened && !this.el.hidden) this.fit.fit()
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

// 字号是全局的：捏合改一个，所有终端一起变
function setFont(size: number) {
	setFontSize(size)
	sessions.forEach(s => {
		s.term.options.fontSize = size
		s.fitNow()
	})
}
