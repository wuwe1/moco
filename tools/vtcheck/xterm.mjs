// 把录下的输出喂给 xterm.js（无界面版，解析器和手机上是同一份），在和 vtcheck dump 一样的检查点导出整屏，逐格对比。
//
//	node tools/vtcheck/xterm.mjs <capture.jsonl> <vt.json> [v6|v11|graphemes]
//
// 第三个参数是 xterm.js 的字宽算法：v6 是默认（手机上现在用的），v11 是 unicode11 插件，graphemes 是按字素簇算
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { Unicode11Addon } = require('@xterm/addon-unicode11')
const { UnicodeGraphemesAddon } = require('@xterm/addon-unicode-graphemes')

const [file, vtFile, width = 'v6'] = process.argv.slice(2)
const recs = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const vt = JSON.parse(readFileSync(vtFile, 'utf8'))

const term = new Terminal({ cols: recs[0].r[0], rows: recs[0].r[1], scrollback: 0, allowProposedApi: true })
if (width === 'v11') {
	term.loadAddon(new Unicode11Addon())
	term.unicode.activeVersion = '11'
} else if (width === 'graphemes') {
	term.loadAddon(new UnicodeGraphemesAddon())
	term.unicode.activeVersion = '15-graphemes'
}
const core = term._core

// 每格的字段用 \x1f 隔开：单元格里的字可能就是 |
const SEP = '\x1f'
const color = (mode, value) => (mode === 'd' ? 'd' : mode === 'p' ? 'p' + value : '#' + value.toString(16).padStart(6, '0'))
const MOUSE = { none: '', x10: '?9', vt200: '?1000', drag: '?1002', any: '?1003' }

function snapshot(at) {
	const buf = term.buffer.active
	const cell = buf.getNullCell()
	const cells = []
	for (let y = 0; y < term.rows; y++) {
		const line = buf.getLine(buf.viewportY + y)
		const row = []
		for (let x = 0; x < term.cols; x++) {
			line.getCell(x, cell)
			const w = cell.getWidth()
			let ch = cell.getChars()
			if (ch === '' && w !== 0) ch = ' '
			const fg = color(cell.isFgDefault() ? 'd' : cell.isFgPalette() ? 'p' : 'r', cell.getFgColor())
			const bg = color(cell.isBgDefault() ? 'd' : cell.isBgPalette() ? 'p' : 'r', cell.getBgColor())
			let a = ''
			if (cell.isBold()) a += 'b'
			if (cell.isDim()) a += 'f'
			if (cell.isItalic()) a += 'i'
			if (cell.isBlink()) a += 'k'
			if (cell.isInverse()) a += 'r'
			if (cell.isInvisible()) a += 'c'
			if (cell.isStrikethrough()) a += 's'
			if (cell.isUnderline()) a += 'u'
			row.push([ch, w, fg, bg, a].join(SEP))
		}
		cells.push(row)
	}
	const m = term.modes
	const modes = {
		'?1': m.applicationCursorKeysMode,
		'?6': m.originMode,
		'?7': m.wraparoundMode,
		'?66': m.applicationKeypadMode,
		'?1004': m.sendFocusMode,
		'?1049': buf.type === 'alternate',
		'?2004': m.bracketedPasteMode,
		'?1006': core.coreMouseService.activeEncoding === 'SGR',
		mouse: MOUSE[m.mouseTrackingMode],
	}
	// 一行写满后的「待换行」状态：xterm.js 把光标记在最后一列再往右一格，x/vt 记在最后一列，统一成后者
	return { at, cols: term.cols, rows: term.rows, cursor: [Math.min(buf.cursorX, term.cols - 1), buf.cursorY], hidden: core.coreService.isCursorHidden, modes, cells }
}

// x/vt 的模式是一组打开的编号，换成和上面一样的形状
function vtModes(list) {
	const on = new Set(list ?? [])
	const mouse = ['?1003', '?1002', '?1000', '?9'].find(k => on.has(k)) ?? ''
	return {
		'?1': on.has('?1'), '?6': on.has('?6'), '?7': on.has('?7'), '?66': on.has('?66'), '?1004': on.has('?1004'),
		'?1049': on.has('?1049') || on.has('?1047') || on.has('?47'), '?2004': on.has('?2004'), '?1006': on.has('?1006'), mouse,
	}
}

// 和手机端一样先按流解 UTF-8（见 web/src/conn.ts）：xterm.js 自己解时，切在第 2 字节后的 3 字节字会丢
const decoder = new TextDecoder()
const write = data => new Promise(r => term.write(decoder.decode(data, { stream: true }), r))
// 检查点跟着 vt.json 走：它在哪几条记录之后截的屏，这边也在那里截
const stops = new Set(vt.map(c => c.at))
const mine = []
for (let i = 0; i < recs.length; i++) {
	const r = recs[i]
	if (i > 0 && r.r) term.resize(r.r[0], r.r[1])
	if (r.d) await write(Buffer.from(r.d, 'base64'))
	if (stops.has(i)) mine.push(snapshot(i))
}

// ---- 对比 ----
const FIELDS = ['字', '宽度', '前景', '背景', '属性']
const count = Object.fromEntries([...FIELDS, '光标', '光标显隐', '模式'].map(k => [k, 0]))
const examples = []
const perCheckpoint = []
let cellsTotal = 0, linked = 0
for (let k = 0; k < mine.length; k++) {
	const a = mine[k], b = vt[k]
	if (!b || a.at !== b.at || a.cols !== b.cols || a.rows !== b.rows) {
		console.log(`检查点对不上：${JSON.stringify([a.at, a.cols, a.rows])} vs ${JSON.stringify(b && [b.at, b.cols, b.rows])}`)
		process.exit(1)
	}
	if (a.cursor[0] !== b.cursor[0] || a.cursor[1] !== b.cursor[1]) {
		count['光标']++
		if (examples.length < 12) examples.push(`#${a.at} 光标不同：xterm=${a.cursor} vt=${b.cursor}（光标${a.hidden ? '隐藏' : '显示'}）`)
	}
	if (a.hidden !== b.hidden) count['光标显隐']++
	const bm = vtModes(b.modes)
	const modeDiff = Object.keys(a.modes).filter(m => a.modes[m] !== bm[m])
	if (modeDiff.length) {
		count['模式']++
		if (examples.length < 12) examples.push(`#${a.at} 模式不同：${modeDiff.map(m => `${m} xterm=${a.modes[m]} vt=${bm[m]}`).join('，')}`)
	}
	let cpDiff = 0
	for (let y = 0; y < a.rows; y++) {
		let rowDiff = []
		for (let x = 0; x < a.cols; x++) {
			cellsTotal++
			const p = a.cells[y][x].split(SEP)
			const q = b.cells[y][x].split(SEP)
			if (q[5]) linked++
			// 宽字符的后半格只比字和宽度：样式渲染时用前半格的，两边记不记都一样
			// 带超链接的格子 xterm.js 会标下划线，x/vt 把链接单独存
			const diff = FIELDS.filter((_, i) => {
				if (p[1] === '0' && q[1] === '0' && i >= 2) return false
				// 两边都是空格：前景色和粗体、斜体、变暗看不出来，只比背景和下划线、反色、删除线
				if (p[0] === ' ' && q[0] === ' ') {
					if (i === 2) return false
					if (i === 4) return p[4].replace(/[bfik]/g, '') !== q[4].replace(/[bfik]/g, '')
				}
				if (i === 4 && q[5]) return p[4].replace('u', '') !== q[4].replace('u', '')
				return p[i] !== q[i]
			})
			diff.forEach(f => count[f]++)
			if (diff.length) rowDiff.push(`  第 ${x} 列 ${diff.join('/')}: xterm=${JSON.stringify(p.slice(0, 5).join(' '))} vt=${JSON.stringify(q.slice(0, 5).join(' '))}`)
		}
		cpDiff += rowDiff.length
		if (rowDiff.length && examples.length < 12) {
			const text = cells => cells.map(c => c.split(SEP)[0]).join('')
			examples.push(`#${a.at} 第 ${y} 行有 ${rowDiff.length} 格不同\n  xterm: ${text(a.cells[y])}\n  vt:    ${text(b.cells[y])}\n${rowDiff.slice(0, 4).join('\n')}`)
		}
	}
	perCheckpoint.push(`${a.at}:${cpDiff}`)
}
if (process.env.PER) console.log(perCheckpoint.join(' '))
console.log(`字宽算法 ${width}：${mine.length} 个检查点，${cellsTotal} 格（vt 里带超链接的 ${linked} 格，不比）`)
console.log(Object.entries(count).map(([k, v]) => `${k} ${v}`).join('，'))
if (examples.length) console.log('\n' + examples.join('\n\n'))
