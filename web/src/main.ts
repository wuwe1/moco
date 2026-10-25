import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { Conn } from './conn'
import { gestures } from './gestures'
import { keyboard } from './keyboard'

const FONT_KEY = 'moco.fontSize'

// gruvbox 深色，和 herdr、Ghostty 的配色一致
const theme = {
	background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
	black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
	brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
}

const app = document.getElementById('app')!
const el = document.getElementById('term')!
const bar = document.getElementById('bar')!
const dot = document.getElementById('dot')!

const term = new Terminal({
	fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
	fontSize: Number(localStorage.getItem(FONT_KEY)) || 13,
	theme,
	// 不留本地回滚：滚动都交给 herdr。留了的话 fit 会在右边给滚动条预留 14px，就是那条缝
	scrollback: 0,
	cursorBlink: false,
	// 不能设 disableStdin：它会拦下 xterm 发往终端的一切，包括滚轮转成的序列和对查询的应答。
	// 触屏上 xterm 自己的输入框拿不到焦点（手势里拦了 touch 的默认行为），输入照样只走我们的输入框
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(el)

const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
const conn = new Conn(url, term, state => {
	dot.dataset.state = state
	el.classList.toggle('offline', state !== 'open')
})
term.onData(d => conn.send(d))
term.onResize(({ cols, rows }) => conn.resize(cols, rows))

const kb = keyboard(term, s => conn.send(s))
gestures(el, term, {
	onTap: kb.focus,
	onFont: size => {
		term.options.fontSize = size
		localStorage.setItem(FONT_KEY, String(size))
		fit.fit()
	},
})

// 键盘弹出时只剩 visualViewport 那么高：整个界面缩进去，终端重新算行列
const layout = () => {
	const vv = window.visualViewport
	const h = vv ? vv.height : window.innerHeight
	app.style.height = `${h}px`
	app.style.transform = `translateY(${vv ? vv.offsetTop : 0}px)`
	const keyboardUp = h < window.innerHeight - 80
	app.style.setProperty('--safe-bottom', keyboardUp ? '0px' : 'env(safe-area-inset-bottom)')
	app.style.setProperty('--bar-h', `${bar.offsetHeight}px`)
	fit.fit()
}
window.visualViewport?.addEventListener('resize', layout)
window.visualViewport?.addEventListener('scroll', layout)
window.addEventListener('resize', layout)
// Safari 的双指缩放手势：整页一律不缩
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault())

layout()
document.fonts?.ready.then(layout)
conn.connect()
