import type { Terminal } from '@xterm/xterm'
import { useEffect, useState } from 'react'

export type Choice = { key: string; label: string }

// 1. Yes、❯ 2. No、│ 3. …：前面可以有框线和选中标记
const ITEM = /^[\s│┃|]*(?:[❯›>▶]\s*)?(\d)[.)]\s+(.*?)[\s│┃|]*$/
// 选项下面可能有说明、或者长选项折到下一行：隔几行不是编号也算同一组
const MAX_GAP = 4

// 屏幕上最下面一组从 1 开始连续编号的选项。Claude Code 的权限提问、AskUserQuestion 都是这个样子；
// 上面对话里的编号列表也会被认出来，所以取最下面的那组
export function choicesOnScreen(term: Terminal): Choice[] {
	const buf = term.buffer.active
	const lines: string[] = []
	for (let y = 0; y < term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
	let found: Choice[] = []
	for (let i = 0; i < lines.length; i++) {
		const first = ITEM.exec(lines[i])
		if (first?.[1] !== '1') continue
		const group = [{ key: '1', label: first[2] }]
		for (let j = i + 1, gap = 0; j < lines.length && gap <= MAX_GAP; j++) {
			const m = ITEM.exec(lines[j])
			if (m && Number(m[1]) === group.length + 1) {
				group.push({ key: m[1], label: m[2] })
				gap = 0
			} else gap++
		}
		if (group.length >= 2) found = group
	}
	return found
}

const RESCAN_MS = 150
const same = (a: Choice[], b: Choice[]) => a.length === b.length && a.every((c, i) => c.label === b[i].label)

// 当前窗格的 agent 在等你时，把屏幕上的选项列成大按钮，点了发那个数字
export function Answers({ term, onAnswer }: { term: Terminal; onAnswer: (key: string) => void }) {
	const [choices, setChoices] = useState<Choice[]>(() => choicesOnScreen(term))
	const [sent, setSent] = useState<Choice[]>()
	useEffect(() => {
		let timer = 0
		const scan = () => {
			clearTimeout(timer)
			timer = window.setTimeout(() => setChoices(prev => {
				const next = choicesOnScreen(term)
				return same(prev, next) ? prev : next
			}), RESCAN_MS)
		}
		scan()
		const sub = term.onWriteParsed(scan)
		return () => {
			clearTimeout(timer)
			sub.dispose()
		}
	}, [term])
	// 点过一次就收起，等屏幕上换了一组选项再出来：herdr 的状态要一秒左右才变回来，免得连点两次
	if (!choices.length || (sent && same(sent, choices))) return null
	return (
		<div className="answers" role="group" aria-label="回答">
			{choices.map(c => (
				<button
					key={c.key}
					type="button"
					onPointerDown={e => e.preventDefault()}
					onClick={() => {
						setSent(choices)
						onAnswer(c.key)
					}}
				>
					<b>{c.key}</b>
					<span>{c.label}</span>
				</button>
			))}
		</div>
	)
}
