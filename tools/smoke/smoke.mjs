import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const repo = new URL('../..', import.meta.url).pathname
const home = mkdtempSync(join(tmpdir(), 'mocod-smoke-'))
const bin = join(home, 'mocod')
execFileSync('go', ['build', '-o', bin, './cmd/mocod'], { cwd: repo, stdio: 'inherit' })
execFileSync('pnpm', ['build'], { cwd: join(repo, 'web'), stdio: 'ignore' })
const port = 7699
writeFileSync(join(home, 'config.json'), JSON.stringify({
	name: 'e2e', listen: `127.0.0.1:${port}`, web: join(repo, 'web/dist'),
	command: ['bash', '--norc', '--noprofile'], origins: ['127.0.0.1'],
}))
const env = { ...process.env, MOCOD_HOME: home }
const mocod = spawn(bin, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
let mocodLog = ''
mocod.stderr.on('data', d => (mocodLog += d))

const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; ; i++) {
	try { if ((await fetch(`${base}/health`)).ok) break } catch {}
	if (i > 50) throw new Error('mocod 没起来\n' + mocodLog)
	await sleep(100)
}
const pairCode = () => execFileSync(bin, ['pair'], { env }).toString().match(/(\d{3}) (\d{3})/).slice(1).join('')

const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'] })
// 无头 Chrome 弹不出软键盘：换一个 visualViewport，__keyboard(px) 当作键盘占了底下 px 高
await ctx.addInitScript(() => {
	const vv = new EventTarget()
	let kb = 0
	Object.defineProperties(vv, {
		height: { get: () => innerHeight - kb },
		width: { get: () => innerWidth },
		offsetTop: { get: () => 0 },
		offsetLeft: { get: () => 0 },
		scale: { get: () => 1 },
	})
	Object.defineProperty(window, 'visualViewport', { get: () => vv })
	window.__keyboard = px => {
		kb = px
		vv.dispatchEvent(new Event('resize'))
	}
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => m.type() === 'error' && errors.push(m.text()))

let step = ''
const check = async (name, fn) => {
	step = name
	await fn()
	console.log('ok  ', name)
}
const screenText = () => page.evaluate(() => document.querySelector('.pane:not([hidden]) .xterm-rows')?.textContent ?? '')
const until = async (fn, what, ms = 5000) => {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (await fn()) return
		await sleep(50)
	}
	throw new Error(`等不到：${what}\n屏幕：${await screenText()}`)
}
const count = (s, sub) => s.split(sub).length - 1
const keyButton = k => page.locator(`#bar [data-key="${k}"]`)
const key = k => keyButton(k).tap()
let cdp
// 一根手指：在 from 按下，按住 holdMs，沿 moves（相对 from 的位移）挪过去，再松开
const touch = async (from, { holdMs = 0, moves = [], thenHoldMs = 0 } = {}) => {
	cdp ??= await ctx.newCDPSession(page)
	const send = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] })
	await send('touchStart', from)
	await sleep(holdMs)
	for (const [dx, dy] of moves) {
		await send('touchMove', { x: from.x + dx, y: from.y + dy })
		await sleep(16)
	}
	await sleep(thenHoldMs)
	await send('touchEnd')
}
const center = async loc => {
	await loc.scrollIntoViewIfNeeded()
	const b = await loc.boundingBox()
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
const redPixel = () => page.evaluate(() => {
	const c = document.querySelector('.pane:not([hidden]) canvas.images')
	if (!c?.width) return
	const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
	for (let i = 0; i < d.length; i += 4) {
		if (d[i] > 200 && d[i + 1] < 50 && d[i + 3] > 200) {
			const r = c.getBoundingClientRect()
			const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width)
			return { x: r.left + (px + 4) * r.width / c.width, y: r.top + (py + 4) * r.height / c.height }
		}
	}
})
const rows = () => page.evaluate(() => document.querySelector('.pane:not([hidden]) .xterm-rows').children.length)
const keyboardUp = px => page.evaluate(px => window.__keyboard(px), px)
// 提示符那一行（最后一行有字的）在终端区域里看得见
const cursorShown = () => page.evaluate(() => {
	const lines = [...document.querySelector('.pane:not([hidden]) .xterm-rows').children]
	const c = lines.findLast(r => r.textContent.trim())?.getBoundingClientRect()
	const p = document.querySelector('#panes').getBoundingClientRect()
	return !!c && c.top >= p.top - 1 && c.bottom <= p.bottom + 1
})
const status = () => page.locator('#grab .status').textContent()
const toastText = () => page.evaluate(() => document.querySelector('.toast')?.textContent ?? '')
const pair = async () => {
	await page.fill('#add input[inputmode="url"]', base)
	await page.fill('#add input[inputmode="numeric"]', pairCode())
	await page.click('#add button.primary')
	await until(async () => (await status()) === '已连接', '已连接')
}
const closeSheet = async () => {
	await sleep(450) // 等抽屉滑上来的动画（.38s）走完再量把手的位置
	const box = await page.locator('#grab').boundingBox()
	await page.mouse.move(box.x + 50, box.y + 10)
	await page.mouse.down()
	await page.mouse.move(box.x + 50, box.y + 300, { steps: 8 })
	await page.mouse.up()
	await until(() => page.evaluate(() => !document.querySelector('#sheet.open')), '抽屉收起')
}

try {
	await check('配对', async () => {
		await page.goto(base)
		await pair()
	})
	await check('打字、回车', async () => {
		await until(async () => (await screenText()).includes('$'), '提示符')
		await page.locator('#kbd').tap()
		await page.keyboard.type('echo hi$((1+2))')
		await page.keyboard.press('Enter')
		await until(async () => count(await screenText(), 'hi3') === 1, 'hi3')
	})
	await check('方向盘往上拖一下：发一次 ↑', async () => {
		await touch(await center(keyButton('dpad')), { moves: [[0, -6], [0, -15], [0, -20]] })
		await key('enter')
		await until(async () => count(await screenText(), 'hi3') === 2, '第二个 hi3')
	})
	await check('Ctrl + c', async () => {
		await page.keyboard.type('sleep 30')
		await key('enter')
		await sleep(200)
		await key('ctrl')
		if ((await keyButton('ctrl').getAttribute('aria-pressed')) !== 'true') throw new Error('Ctrl 没亮')
		await page.keyboard.type('c')
		await page.keyboard.type('echo after$((2*3))')
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('after6'), 'after6')
	})
	await check('^C 键', async () => {
		await page.keyboard.type('sleep 30')
		await key('enter')
		await sleep(200)
		await key('^c')
		await page.keyboard.type('echo cc$((3*3))')
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('cc9'), 'cc9')
	})
	await check('粘贴键', async () => {
		await page.evaluate(() => navigator.clipboard.writeText('echo pasted$((4*4))'))
		await keyButton('paste').tap()
		await until(async () => (await screenText()).includes('echo pasted'), '粘贴进命令行')
		await key('enter')
		await until(async () => (await screenText()).includes('pasted16'), 'pasted16')
	})
	await check('外接键盘 ↑', async () => {
		await page.keyboard.press('ArrowUp')
		await page.keyboard.press('Enter')
		await until(async () => count(await screenText(), 'pasted16') === 2, '第二个 pasted16')
	})
	await check('电脑上的程序复制（OSC 52）：进手机剪贴板', async () => {
		await page.keyboard.type(`printf '\\033]52;c;%s\\007' $(printf 'osc52 复制' | base64)`)
		await page.keyboard.press('Enter')
		await until(async () => (await toastText()).includes('已放进手机剪贴板'), '复制提示')
		const got = await page.evaluate(() => navigator.clipboard.readText())
		if (got !== 'osc52 复制') throw new Error(`剪贴板里是 ${JSON.stringify(got)}`)
		await page.keyboard.type('clear')
		await page.keyboard.press('Enter')
	})
	await check('按下滑走再松手：不发', async () => {
		await page.keyboard.type('echo slid$((5*5))')
		await touch(await center(keyButton('enter')), { moves: [[0, -20], [0, -50], [0, -80]] })
		await sleep(300)
		if ((await screenText()).includes('slid25')) throw new Error('滑走了还是发了回车')
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('slid25'), 'slid25')
	})
	const leftOf = async (moves, thenHoldMs) => {
		await page.keyboard.type('echo abcdefghijklmnop')
		await touch(await center(keyButton('dpad')), { moves, thenHoldMs })
		await page.keyboard.type('X')
		await page.keyboard.press('Enter')
		await until(async () => /\s[a-p]*X[a-p]*\s/.test((await screenText()).split('echo ').pop()), '输出')
		const out = (await screenText()).split('echo ').pop().match(/\s([a-p]*X[a-p]*)\s/)[1]
		await page.keyboard.type('clear')
		await page.keyboard.press('Enter')
		return out.length - out.indexOf('X') - 1
	}
	await check('方向盘只点不拖：不发', async () => {
		const n = await leftOf([], 0)
		if (n !== 0) throw new Error(`发了 ${n} 个 ←`)
	})
	await check('方向盘往左拖远按住：连发', async () => {
		const n = await leftOf([[-15, 0], [-50, 0]], 500)
		if (n < 4) throw new Error(`只发了 ${n} 个 ←`)
	})
	await check('方向盘拖回中间：停', async () => {
		const n = await leftOf([[-15, 0], [-3, 0]], 600)
		if (n !== 1) throw new Error(`发了 ${n} 个 ←，应该只有 1 个`)
	})
	await check('按键栏一行排得下', async () => {
		const r = await page.evaluate(() => {
			const bar = document.querySelector('#bar').getBoundingClientRect()
			const bs = [...document.querySelectorAll('#bar button')].map(b => b.getBoundingClientRect())
			return { n: bs.length, rows: new Set(bs.map(b => Math.round(b.top))).size, out: bs.filter(b => b.right > bar.right || b.left < bar.left).length, minW: Math.min(...bs.map(b => b.width)) }
		})
		if (r.n !== 10 || r.rows !== 1 || r.out || r.minW < 30) throw new Error(JSON.stringify(r))
	})
	await check('灰字（SGR 2）：真彩色的也是半透明', async () => {
		await page.keyboard.type("printf 'n0 \\033[2mDIM1\\033[0m \\033[2;38;2;235;219;178mDIM2\\033[0m \\033[2;38;2;214;216;224;48;2;30;30;30m灰字\\033[0m\\n'")
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).split('灰字').length > 2, '灰字')
		const alphas = await page.evaluate(() => [...document.querySelectorAll('.pane:not([hidden]) .xterm-rows span.xterm-dim')]
			.filter(s => /^(DIM[12]|灰字)$/.test(s.textContent.trim()))
			.map(s => [s.textContent.trim(), getComputedStyle(s).webkitTextFillColor]))
		for (const [name, c] of alphas) if (!/(0\.5\)|\/ ?0\.5\))$/.test(c)) throw new Error(`${name} 不灰：${c}`)
		if (alphas.length < 3) throw new Error('没找到灰字 ' + JSON.stringify(alphas))
	})
	await check('图片键：一次选两张，传到电脑，路径都粘贴进终端', async () => {
		const pngOf = (w, h) => page.evaluate(([w, h]) => {
			const c = document.createElement('canvas')
			c.width = w
			c.height = h
			const g = c.getContext('2d')
			g.fillStyle = '#c33'
			g.fillRect(0, 0, w, h)
			return c.toDataURL('image/png').split(',')[1]
		}, [w, h]).then(b => Buffer.from(b, 'base64'))
		const pathCount = async () => (await screenText()).match(/\/moco\/[\d-]+\.png/g)?.length ?? 0
		const small = await pngOf(4, 4)
		const before = await pathCount()
		const chooser = page.waitForEvent('filechooser')
		await key('image')
		await (await chooser).setFiles([
			{ name: 'small.png', mimeType: 'image/png', buffer: small },
			{ name: 'big.png', mimeType: 'image/png', buffer: await pngOf(3000, 1200) },
		])
		await until(async () => (await pathCount()) >= before + 2, '两个路径都出现在终端里')
		const paths = (await screenText()).replace(/\s+/g, ' ').match(/\/\S*?\/moco\/[\d-]+\.png/g).slice(-2)
		if (!readFileSync(paths[0]).equals(small)) throw new Error('小图存下来的内容不一样')
		const big = readFileSync(paths[1])
		const w = big.readUInt32BE(16), h = big.readUInt32BE(20)
		if (w !== 2000 || h !== 800) throw new Error(`大图存成了 ${w}×${h}`)
		await page.keyboard.press('Control+u')
	})
	await check('kitty 图：画在 canvas 上', async () => {
		const red = Buffer.from(Array(16).fill([255, 0, 0]).flat()).toString('base64')
		await page.keyboard.type(`clear; printf '\\033_Ga=T,f=24,s=4,v=4,i=7,c=8,r=4;${red}\\033\\\\'; echo; echo img-done`)
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('img-done'), 'img-done')
		await until(() => redPixel().then(Boolean), 'canvas 上的红色')
	})
	await check('轻点图：出大图，关掉', async () => {
		await page.locator('#kbd').tap()
		const at = await redPixel()
		await page.touchscreen.tap(at.x, at.y)
		await until(() => page.locator('.lightbox').count(), '大图')
		const size = await page.locator('.lightbox .size').textContent()
		if (size !== '4 × 4') throw new Error('大图尺寸 ' + size)
		await page.locator('.lightbox [aria-label="关闭"]').click()
		await until(async () => !(await page.locator('.lightbox').count()), '大图关掉')
	})
	await check('轻点空白处：弹键盘', async () => {
		await page.evaluate(() => document.activeElement?.blur())
		const box = await page.locator('.pane:not([hidden])').boundingBox()
		await page.touchscreen.tap(box.x + box.width - 20, box.y + box.height - 20)
		await until(() => page.evaluate(() => document.activeElement?.id === 'input'), '输入框拿到焦点')
	})
	await check('单指上划：less 往下翻', async () => {
		await page.focus('#input')
		await page.keyboard.type('seq 1 200 | less')
		await page.keyboard.press('Enter')
		await until(async () => /^\s*1\s+2\s/.test(await screenText()), 'less 第一屏')
		await page.evaluate(() => document.activeElement?.blur())
		const box = await page.locator('.pane:not([hidden])').boundingBox()
		const cdp = await ctx.newCDPSession(page)
		const x = box.x + box.width / 2
		const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
		await touch('touchStart', box.y + box.height - 50)
		for (let i = 1; i <= 10; i++) {
			await touch('touchMove', box.y + box.height - 50 - i * 30)
			await sleep(16)
		}
		await sleep(300)
		await touch('touchEnd')
		await until(async () => !/^\s*1\s+2\s/.test(await screenText()), 'less 翻过第一屏')
		await page.focus('#input')
		await page.keyboard.type('q')
	})
	await check('拖把手收起，首页有缩略图', async () => {
		await closeSheet()
		await until(() => page.locator('.host .thumb img').count(), '缩略图')
		const img = await page.locator('.host .thumb img').evaluate(i => i.decode().then(() => [i.src.slice(0, 22), i.naturalWidth]))
		if (img[0] !== 'data:image/png;base64,' || img[1] < 300) throw new Error('缩略图不对：' + img)
		await until(async () => (await page.locator('.host .dot').getAttribute('data-state')) === 'open', '首页圆点 open')
	})
	await check('设置页：换字体、调字号', async () => {
		await page.click('#home [aria-label="设置"]')
		await page.click('#settings [data-font="jetbrains"]')
		await until(() => page.evaluate(() => localStorage.getItem('moco.fontFamily') === 'jetbrains'), '存下字体')
		const size = () => page.locator('#settings [data-font-size]').textContent()
		const before = Number(await size())
		await page.click('#settings [aria-label="大一号"]')
		if (Number(await size()) !== before + 1) throw new Error('字号没变大')
		if ((await page.evaluate(() => localStorage.getItem('moco.fontSize'))) !== String(before + 1)) throw new Error('字号没存下')
		await page.click('#settings [aria-label="小一号"]')
		await page.click('#settings [aria-label="返回"]')
		await until(async () => !(await page.locator('#settings').count()), '回到首页')
	})
	await check('设置页：换主题、光标、导入主题', async () => {
		await page.click('#home [aria-label="设置"]')
		await page.click('#settings [data-theme="catppuccin-latte"]')
		const look = () => page.evaluate(() => [document.documentElement.dataset.mode, getComputedStyle(document.documentElement).getPropertyValue('--term').trim()])
		if ((await look()).join() !== 'light,#eff1f5') throw new Error('App 没换成浅色：' + (await look()))
		await page.click('#settings [role="radio"]:has-text("竖线"), #settings button:has-text("竖线")')
		await page.click('#settings [aria-label="光标闪烁"]')
		const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('moco.termPrefs')))
		if (prefs.cursorStyle !== 'bar' || !prefs.cursorBlink) throw new Error('光标设置没存下：' + JSON.stringify(prefs))
		await page.click('#settings button:has-text("导入主题")')
		await page.fill('[role="dialog"] textarea', JSON.stringify({ v: 1, name: 'Smoke Test', mode: 'dark', colors: { background: '#101010', foreground: '#e0e0e0', red: '#ff0000' } }))
		await page.click('[role="dialog"] button:has-text("导入")')
		await until(async () => (await page.locator('#settings [data-theme="custom-smoke-test"][aria-pressed="true"]').count()) === 1, '导入的主题被选中')
		if ((await look()).join() !== 'dark,#101010') throw new Error('导入的主题没用上：' + (await look()))
		await page.click('#settings [aria-label="删除 Smoke Test"]')
		await until(async () => !(await page.locator('#settings [data-theme="custom-smoke-test"]').count()), '删掉导入的主题')
		await page.click('#settings [data-theme="catppuccin-latte"]')
		await page.click('#settings [aria-label="返回"]')
	})
	await check('再打开还连着', async () => {
		await page.click('.host')
		await until(async () => (await status()) === '已连接', '已连接')
		await until(async () => (await screenText()).includes('img-done'), '画面还在')
	})
	await check('终端用上新字体', async () => {
		const r = await page.evaluate(() => ({
			font: getComputedStyle(document.querySelector('.pane:not([hidden]) .xterm-rows')).fontFamily,
			faces: [...document.fonts].filter(f => /JetBrains|moco-symbols/.test(f.family)).map(f => f.status),
		}))
		if (!/^"?JetBrains Mono"?, moco-symbols/.test(r.font)) throw new Error('字体：' + r.font)
		if (r.faces.length !== 3 || r.faces.some(s => s !== 'loaded')) throw new Error('没加载完：' + r.faces)
	})
	await check('终端跟着主题和光标设置走，mocod 按新配色回答颜色查询', async () => {
		const fg = await page.evaluate(() => getComputedStyle(document.querySelector('.pane:not([hidden]) .xterm-rows')).color)
		if (fg !== 'rgb(76, 79, 105)') throw new Error('终端前景色：' + fg)
		await until(async () => {
			const cls = await page.evaluate(() => document.querySelector('.pane:not([hidden]) .xterm-cursor')?.className ?? '')
			return cls.includes('xterm-cursor-bar') && cls.includes('xterm-cursor-blink')
		}, '光标是闪烁的竖线')
		await page.focus('#input')
		await page.keyboard.type(`printf '\\033]11;?\\007'; read -rs -t2 -d $'\\a' r; echo "bg=\${r#*;}"`)
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('bg=rgb:efef/f1f1/f5f5'), 'mocod 回答新背景色')
	})
	await check('点状态看日志', async () => {
		await page.locator('#grab .status').click()
		await until(() => page.locator('.debug').count(), '日志面板')
		await until(async () => mocodLog.includes('光标行：「'), '日志里有光标行的属性')
		console.log('    ', mocodLog.match(/光标行：[^\n]{0,160}/)[0])
		await page.locator('.debug').click()
	})
	await check('键盘弹出：行数不变，光标露在上面', async () => {
		const full = await rows()
		await page.focus('#input')
		await page.keyboard.type('clear; seq 1 80')
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('80'), 'seq 输出')
		await keyboardUp(348)
		await sleep(400)
		if ((await rows()) !== full) throw new Error(`行数变了：${full} → ${await rows()}`)
		const under = await page.evaluate(() => !!document.elementFromPoint(innerWidth / 2, innerHeight - 5)?.closest('#sheet'))
		if (!under) throw new Error('按键栏下面透出了首页')
		if (!(await cursorShown())) throw new Error('光标被键盘挡住了')
		await page.keyboard.type('clear')
		await page.keyboard.press('Enter')
		await sleep(400)
		if (!(await cursorShown())) throw new Error('clear 之后光标在顶上，画面没跟回去')
		await keyboardUp(0)
		await sleep(400)
		if ((await rows()) !== full) throw new Error('收起后行数变了')
		const t = await page.evaluate(() => document.querySelector('.pane:not([hidden])').style.transform)
		if (t) throw new Error('收起后还推着：' + t)
	})
	await check('字体：Iosevka、中文 Noto Sans SC、导入字体文件', async () => {
		await closeSheet()
		await page.click('#home [aria-label="设置"]')
		await page.click('#settings [data-font="iosevka"]')
		await page.click('#settings [data-cjk="noto"]')
		await page.locator('#settings input[type="file"]').setInputFiles(join(repo, 'web/public/fonts/moco-symbols.woff2'))
		await until(async () => (await page.locator('#settings [data-font^="custom:"][aria-pressed="true"]').count()) === 1, '导入的字体被选中')
		await page.click('#settings [aria-label="返回"]')
		await page.click('.host')
		await until(async () => {
			const font = await page.evaluate(() => {
				const rows = document.querySelector('.pane:not([hidden]) .xterm-rows')
				return rows ? getComputedStyle(rows).fontFamily : ''
			})
			return /moco-custom:.*moco-symbols.*Noto Sans SC/.test(font)
		}, '终端用上导入的字体和 Noto Sans SC')
		await closeSheet()
		await page.click('#home [aria-label="设置"]')
		await page.locator('#settings [aria-label="删除 moco-symbols"]').click()
		await until(async () => (await page.locator('#settings [data-font="system"][aria-pressed="true"]').count()) === 1, '删掉后回到系统字体')
		await page.click('#settings [aria-label="返回"]')
		await page.click('.host')
		await until(async () => (await status()) === '已连接', '已连接')
	})
	await check('仓库：改动、diff 高亮、文件、提交', async () => {
		const repo = join(home, 'demo-repo')
		const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null' } })
		execFileSync('mkdir', ['-p', join(repo, 'src')])
		git('init', '-q', '-b', 'main')
		git('config', 'user.name', 'smoke')
		git('config', 'user.email', 'smoke@example.com')
		writeFileSync(join(repo, 'src/app.ts'), 'export const answer = 41\nexport function greet(name: string) {\n\treturn `hi ${name}`\n}\n')
		writeFileSync(join(repo, 'README.md'), '# demo\n')
		git('add', '.')
		git('commit', '-q', '-m', 'first commit', '-m', 'with a body line')
		writeFileSync(join(repo, 'src/app.ts'), 'export const answer = 42\nexport function greet(name: string) {\n\treturn `hi ${name}`\n}\n')
		writeFileSync(join(repo, 'notes.txt'), 'todo\n')
		writeFileSync(join(repo, 'staged.md'), 'staged\n')
		git('add', 'staged.md')

		await page.click('#grab [aria-label="仓库"]')
		await until(() => page.locator('.repo-view').count(), '仓库面板')
		if (!(await page.locator('[role="dialog"] input').count())) await page.click('.repo-view header button:has-text("选仓库"), .repo-view header button >> nth=1')
		await page.fill('[role="dialog"] input', repo)
		await page.click('[role="dialog"] button:has-text("打开")')
		await until(async () => (await page.locator('.repo-view li').count()) >= 3, '改动列表')
		const text = await page.locator('.repo-view').textContent()
		for (const want of ['已暂存', '未暂存', '未跟踪', 'staged.md', 'src/app.ts', 'notes.txt']) if (!text.includes(want)) throw new Error('改动里没有 ' + want)

		await page.click('.repo-view li button:has-text("app.ts")')
		await until(async () => (await page.locator('.repo-view').textContent()).includes('answer = 42'), 'diff 里的新行')
		await until(() => page.evaluate(() => [...document.querySelectorAll('.repo-view .diff-line-syntax-raw span[style*="color"]')].length > 0), 'diff 有语法高亮')
		await page.click('.repo-view header [aria-label="返回"]')

		await page.click('.repo-view [role="tab"]:has-text("文件")')
		await until(async () => (await page.locator('.repo-view li button[aria-label="notes.txt"]').count()) === 1, '工作区里有未跟踪的文件')
		await page.click('.repo-view li button[aria-label="src"]')
		await page.click('.repo-view li button[aria-label="app.ts"]')
		await until(() => page.evaluate(() => {
			const code = document.querySelector('.repo-view .code')
			return !!code && code.textContent.includes('greet') && code.querySelectorAll('span[style*="color"]').length > 3 && code.querySelectorAll('.line').length >= 4
		}), '代码有高亮和行号')
		await page.click('.repo-view header [aria-label="返回"]')

		await page.click('.repo-view [role="tab"]:has-text("提交")')
		await page.click('.repo-view li button:has-text("first commit")')
		await until(async () => {
			const t = await page.locator('.repo-view').textContent()
			return t.includes('with a body line') && t.includes('README.md')
		}, '提交详情')
		await page.click('.repo-view header [aria-label="返回"]')
		await page.click('.repo-view header [aria-label="关闭"]')
		await until(async () => !(await page.locator('.repo-view').count()), '关掉仓库面板')
	})
	await check('删掉再配对：旧连接不再听 online', async () => {
		await closeSheet()
		page.once('dialog', d => d.accept())
		await page.click('.host .more')
		await until(async () => !(await page.locator('.host').count()), '删掉')
		await page.click('#home [aria-label="添加电脑"]')
		await pair()
		const before = count(mocodLog, 'wake stale')
		await page.evaluate(() => window.dispatchEvent(new Event('online')))
		await until(async () => (await status()) === '已连接', '重连后已连接')
		await sleep(300)
		const n = count(mocodLog, 'wake stale') - before
		if (n !== 1) throw new Error(`一次 online 有 ${n} 个连接醒来`)
	})
	await check('同一地址再配对：换掉的旧连接关掉', async () => {
		await closeSheet()
		await page.click('#home [aria-label="添加电脑"]')
		await pair()
		if ((await page.locator('.host').count()) !== 1) throw new Error('首页不是一台电脑')
		const before = count(mocodLog, 'wake stale')
		await page.evaluate(() => window.dispatchEvent(new Event('online')))
		await sleep(500)
		const n = count(mocodLog, 'wake stale') - before
		if (n !== 1) throw new Error(`一次 online 有 ${n} 个连接醒来`)
	})
	if (errors.length) throw new Error('页面报错：' + errors.join('\n'))
	console.log('PASS')
} catch (e) {
	console.log('FAIL', step, '\n', e.message, '\n--- mocod\n', mocodLog.slice(-1500))
	await page.screenshot({ path: join(home, 'fail.png') })
	console.log('截图', join(home, 'fail.png'))
	process.exitCode = 1
} finally {
	await browser.close()
	mocod.kill()
}
