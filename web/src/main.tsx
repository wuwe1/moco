import '@xterm/xterm/css/xterm.css'
import { render } from 'preact'
import { App } from './app'
import './style.css'

// Safari 的双指缩放手势：整页一律不缩（iOS 不认 user-scalable=no）
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault())

render(<App />, document.getElementById('root')!)

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js')
