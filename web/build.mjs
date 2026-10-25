// 打成一个自带 JS、CSS 的 dist/index.html：ttyd -I 只认一个文件
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const out = await build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	minify: true,
	format: 'iife',
	target: 'safari16',
	outdir: 'out',
	write: false,
})
const js = out.outputFiles.find(f => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script')
const css = out.outputFiles.find(f => f.path.endsWith('.css')).text
const html = (await readFile('src/index.html', 'utf8'))
	.replace('<!-- css -->', () => `<style>${css}</style>`)
	.replace('<!-- js -->', () => `<script>${js}</script>`)
await mkdir('dist', { recursive: true })
await writeFile('dist/index.html', html)
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB`)
