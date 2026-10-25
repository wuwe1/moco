import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const mocod = 'http://127.0.0.1:7681'

export default defineConfig({
	plugins: [react()],
	build: { target: 'safari16' },
	server: {
		host: '127.0.0.1',
		port: 5174,
		strictPort: true,
		allowedHosts: ['.ts.net'],
		// 写成对象、不开 changeOrigin（写成字符串 Vite 会默认开）：Host 要原样到 mocod，它按 Origin 和 Host 一致认同源
		proxy: {
			'/ws': { target: mocod, ws: true },
			'/pair': { target: mocod },
			'/health': { target: mocod },
		},
	},
})
