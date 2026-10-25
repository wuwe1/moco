// 开发：pnpm dev 起在 127.0.0.1:5174，mocod 的 dev 配置指过来，手机照常打开 https://<电脑>.ts.net，
// 页面由 mocod 转给 Vite，改了代码手机上直接更新（HMR 的 WebSocket 也走 mocod）。
// 出包：pnpm build 到 dist/，mocod 的 web 配置指它；Vite 没开时 mocod 也退回到它
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [preact()],
	build: { target: 'safari16' },
	server: {
		host: '127.0.0.1',
		port: 5174,
		strictPort: true,
		// 经 mocod 转过来，Host 是 Tailscale 上的名字
		allowedHosts: ['.ts.net'],
	},
})
