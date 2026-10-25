// 一个连接 = 一个终端 + 一条到 mocod 的连接。离开终端页时不断开，回来立刻能用；
// 离开时把当前这一屏存成 HTML，首页的缩略图就是它
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { Terminal } from '@xterm/xterm'
import { Conn, type State } from './conn'
import { theme } from './theme'
import { dlog } from './debug'
import { gestures } from './gestures'
import { ImageLayer } from './images'
import { fontSize, saveScreen, setFontSize, type Host } from './store'


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
	readonly images: ImageLayer
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
			this.images.mount()
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
		if (this.opened && !this.el.hidden) {
			this.fit.fit()
			this.images.draw()
		}
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
