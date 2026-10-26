import '@xterm/xterm/css/xterm.css'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { fontKey, loadFont } from './fonts'
import { currentTheme } from './store'
import { applyTheme } from './themes'
import './index.css'

// Safari 的双指缩放手势：整页一律不缩（iOS 不认 user-scalable=no）
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault())

// 打开过通知才注册（push.ts）；每次打开页面让它拿最新的 sw.js
function updateServiceWorker() {
	navigator.serviceWorker?.getRegistrations().then(rs => rs.forEach(r => r.update()))
}

applyTheme(currentTheme())
loadFont(fontKey()).then(() => createRoot(document.getElementById('root')!).render(<App />))
updateServiceWorker()
