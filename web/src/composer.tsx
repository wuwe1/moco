import { ArrowUp, ImagePlus, Keyboard } from 'lucide-react'
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

const MAX_LINES_PX = 140

// 草稿按窗格记：切到别的 agent 再回来，没发的还在
const drafts = new Map<string, string>()
export const hasDraft = (key: string) => drafts.has(key)

export type ComposerHandle = { focus: () => void; insert: (s: string) => void }

// 写好再发：普通输入框，输入法、自动纠正、听写都照常；回车（或发送键）把整段交给 onSend
export const Composer = forwardRef<
	ComposerHandle,
	{ draftKey: string; onSend: (text: string) => void; onKeys: () => void; onImage: () => void; onFocusChange: (focused: boolean) => void }
>(function Composer(props, ref) {
	const box = useRef<HTMLTextAreaElement>(null)
	const [text, setTextState] = useState(() => drafts.get(props.draftKey) ?? '')
	const composing = useRef(false)
	const setText = (s: string) => {
		setTextState(s)
		if (s) drafts.set(props.draftKey, s)
		else drafts.delete(props.draftKey)
	}
	useLayoutEffect(() => setTextState(drafts.get(props.draftKey) ?? ''), [props.draftKey])
	useLayoutEffect(() => {
		const el = box.current!
		el.style.height = ''
		el.style.height = `${Math.min(el.scrollHeight, MAX_LINES_PX)}px`
	}, [text])
	useImperativeHandle(ref, () => ({
		focus: () => box.current?.focus(),
		insert: s => {
			const el = box.current!
			const at = el.selectionStart ?? text.length
			setText(text.slice(0, at) + s + text.slice(el.selectionEnd ?? at))
		},
	}))
	const send = () => {
		props.onSend(text)
		setText('')
	}
	// 按住不让输入框丢焦点：键盘不收起
	const keep = (e: React.PointerEvent) => e.preventDefault()

	return (
		<form
			className="composer"
			onSubmit={e => {
				e.preventDefault()
				send()
			}}
		>
			<button type="button" aria-label="图片" onPointerDown={keep} onClick={props.onImage}>
				<ImagePlus size={18} />
			</button>
			<textarea
				ref={box}
				rows={1}
				value={text}
				placeholder="写好再发，回车发送"
				enterKeyHint="send"
				onChange={e => setText(e.currentTarget.value)}
				onFocus={() => props.onFocusChange(true)}
				onBlur={() => props.onFocusChange(false)}
				onCompositionStart={() => (composing.current = true)}
				// Safari 在输入法上屏之后还会补一个 isComposing=false 的回车：晚一拍再放开
				onCompositionEnd={() => setTimeout(() => (composing.current = false))}
				onKeyDown={e => {
					if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return
					e.preventDefault()
					send()
				}}
			/>
			<button type="submit" className="send" aria-label="发送" onPointerDown={keep}>
				<ArrowUp size={18} />
			</button>
			<button type="button" className="keys" aria-label="改成逐键输入" onPointerDown={keep} onClick={props.onKeys}>
				<Keyboard size={18} />
			</button>
		</form>
	)
})
