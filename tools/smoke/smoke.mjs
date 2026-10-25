import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
const touch = async (from, { holdMs = 0, moves = [] } = {}) => {
	cdp ??= await ctx.newCDPSession(page)
	const send = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] })
	await send('touchStart', from)
	await sleep(holdMs)
	for (const [dx, dy] of moves) {
		await send('touchMove', { x: from.x + dx, y: from.y + dy })
		await sleep(16)
	}
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
const setMode = m => page.evaluate(m => localStorage.setItem('moco.keyboardMode', m), m)
// 提示符那一行（最后一行有字的）在终端区域里看得见
const cursorShown = () => page.evaluate(() => {
	const lines = [...document.querySelector('.pane:not([hidden]) .xterm-rows').children]
	const c = lines.findLast(r => r.textContent.trim())?.getBoundingClientRect()
	const p = document.querySelector('#panes').getBoundingClientRect()
	return !!c && c.top >= p.top - 1 && c.bottom <= p.bottom + 1
})
const status = () => page.locator('#grab .status').textContent()
const pair = async () => {
	await page.fill('#add input[inputmode="url"]', base)
	await page.fill('#add input[inputmode="numeric"]', pairCode())
	await page.click('#add button.primary')
	await until(async () => (await status()) === '已连接', '已连接')
}
const closeSheet = async () => {
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
	await check('按键栏 ↑ ⏎', async () => {
		await key('up')
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
	await check('按住 ← 连发', async () => {
		await page.keyboard.type('echo abcdefghijklmnop')
		await touch(await center(keyButton('left')), { holdMs: 700 })
		await page.keyboard.type('X')
		await page.keyboard.press('Enter')
		await until(async () => /[a-p]+X[a-p]+/.test(await screenText()), '输出里有 X')
		const out = (await screenText()).match(/\s([a-p]+X[a-p]+)/)[1]
		if (out.length - out.indexOf('X') - 1 < 3) throw new Error(`只往左挪了 ${out.length - out.indexOf('X') - 1} 格：${out}`)
	})
	await check('按下滑走再松手：不发', async () => {
		await page.keyboard.type('echo slid$((5*5))')
		await touch(await center(keyButton('enter')), { moves: [[0, -20], [0, -50], [0, -80]] })
		await sleep(300)
		if ((await screenText()).includes('slid25')) throw new Error('滑走了还是发了回车')
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('slid25'), 'slid25')
	})
	await check('按在键上横着划按键栏：不发', async () => {
		await page.keyboard.type('echo ab')
		await touch(await center(keyButton('left')), { moves: [[-20, 0], [-50, 0], [-90, 0], [-130, 0]] })
		await sleep(300)
		await page.keyboard.type('Z')
		await page.keyboard.press('Enter')
		await until(async () => { const t = await screenText(); return count(t, 'abZ') + count(t, 'aZb') >= 2 }, '输出')
		if (count(await screenText(), 'aZb')) throw new Error('划动时发了方向键')
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
		await until(() => page.locator('.host .thumb iframe').count(), '缩略图')
		const html = await page.locator('.host .thumb iframe').getAttribute('srcdoc')
		if (!html.includes('img-done')) throw new Error('缩略图里没有最后一屏')
		await until(async () => (await page.locator('.host .dot').getAttribute('data-state')) === 'open', '首页圆点 open')
	})
	await check('首页的开关改键盘模式', async () => {
		await page.selectOption('.kbmode select', 'pan')
		const m = await page.evaluate(() => localStorage.getItem('moco.keyboardMode'))
		if (m !== 'pan') throw new Error('存的是 ' + m)
	})
	await check('再打开还连着', async () => {
		await page.click('.host')
		await until(async () => (await status()) === '已连接', '已连接')
		await until(async () => (await screenText()).includes('img-done'), '画面还在')
	})
	await check('点状态看日志', async () => {
		await page.locator('#grab .status').click()
		await until(() => page.locator('.debug').count(), '日志面板')
		await page.locator('.debug').click()
	})
	await check('键盘弹出·改大小：行数变少，收起恢复', async () => {
		await setMode('resize')
		const full = await rows()
		await keyboardUp(348)
		await until(async () => (await rows()) < full, '行数变少')
		await keyboardUp(0)
		await until(async () => (await rows()) === full, '行数恢复')
	})
	await check('键盘弹出·等新画面：盖一张截图，新尺寸的帧一到就揭掉', async () => {
		await setMode('swap')
		const full = await rows()
		for (const px of [348, 0]) {
			const covered = await page.evaluate(px => (window.__keyboard(px), !!document.querySelector('.pane .frozen')), px)
			if (!covered) throw new Error(`键盘 ${px}：改尺寸时没盖截图`)
			const t0 = Date.now()
			await until(() => page.evaluate(() => !document.querySelector('.pane .frozen')), '揭掉截图', 2000)
			if (Date.now() - t0 > 600) throw new Error(`键盘 ${px}：等了 ${Date.now() - t0}ms 才揭掉，是兜底超时不是新帧`)
		}
		if ((await rows()) !== full) throw new Error('收起后行数没恢复')
	})
	await check('键盘弹出·不改大小：行数不变，光标露在上面', async () => {
		await setMode('pan')
		const full = await rows()
		await page.focus('#input')
		await page.keyboard.type('clear; seq 1 80')
		await page.keyboard.press('Enter')
		await until(async () => (await screenText()).includes('80'), 'seq 输出')
		await keyboardUp(348)
		await sleep(400)
		if ((await rows()) !== full) throw new Error(`行数变了：${full} → ${await rows()}`)
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
