import { useEffect, useReducer, type PointerEvent as ReactPointerEvent } from 'react'
import { writeClipboard } from './clipboard'
import { edgePoints, isUrl, type Cell } from './select'
import type { Session } from './session'

const MENU_H = 40
const MENU_GAP = 10

// 选区的两个把手和上面的「复制 / 全选 / 打开」。坐标相对 root（抽屉），抽屉自己有 transform，fixed 不好使
export function SelectionLayer({ session, root, onDone }: { session: Session; root: HTMLElement; onDone: (msg: string) => void }) {
	const [, bump] = useReducer((n: number) => n + 1, 0)
	const sel = session.selection
	useEffect(() => {
		if (!sel) return
		const vv = window.visualViewport
		vv?.addEventListener('resize', bump)
		const off = session.term.onRender(bump)
		return () => {
			vv?.removeEventListener('resize', bump)
			off.dispose()
		}
	}, [session, !!sel])
	if (!sel) return null
	const pts = edgePoints(session.term, sel)
	if (!pts) return null
	const base = root.getBoundingClientRect()
	const start = { x: pts.start.x - base.left, y: pts.start.y - base.top }
	const end = { x: pts.end.x - base.left, y: pts.end.y - base.top }
	const text = session.selectedText()

	const drag = (fixed: Cell, tip: { x: number; y: number }) => (e: ReactPointerEvent) => {
		e.preventDefault()
		e.stopPropagation()
		const el = e.currentTarget as HTMLElement
		el.setPointerCapture(e.pointerId)
		const dx = e.clientX - (tip.x + base.left)
		const dy = e.clientY - (tip.y + base.top)
		const move = (m: PointerEvent) => session.moveEdge(fixed, m.clientX - dx, m.clientY - dy)
		const up = () => {
			el.removeEventListener('pointermove', move)
			el.removeEventListener('pointerup', up)
			el.removeEventListener('pointercancel', up)
		}
		el.addEventListener('pointermove', move)
		el.addEventListener('pointerup', up)
		el.addEventListener('pointercancel', up)
	}

	const above = start.y - MENU_H - MENU_GAP
	const menuTop = above > MENU_GAP ? above : end.y + MENU_GAP + 16
	const menuX = sel.start.row === sel.end.row ? (start.x + end.x) / 2 : base.width / 2
	const done = (msg: string) => {
		session.select(undefined)
		onDone(msg)
	}

	return (
		<div className="selection">
			<div
				className="sel-handle start"
				style={{ left: start.x, top: start.y, height: pts.ch }}
				onPointerDown={drag(sel.end, { x: start.x, y: start.y + pts.ch / 2 })}
			/>
			<div
				className="sel-handle end"
				style={{ left: end.x, top: end.y - pts.ch, height: pts.ch }}
				onPointerDown={drag(sel.start, { x: end.x - 1, y: end.y - pts.ch / 2 })}
			/>
			<div className="sel-menu" style={{ top: menuTop, left: menuX }}>
				<button type="button" onClick={async () => done((await writeClipboard(text)) ? `已复制 ${[...text].length} 个字` : '没复制上')}>
					复制
				</button>
				<button type="button" onClick={() => session.selectAll()}>
					全选
				</button>
				{isUrl(text) && (
					<button
						type="button"
						onClick={() => {
							window.open(text, '_blank', 'noopener')
							done('')
						}}
					>
						打开
					</button>
				)}
			</div>
		</div>
	)
}
