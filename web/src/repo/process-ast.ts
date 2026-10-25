import type { DiffFileHighlighter } from '@git-diff-view/react'

// 照 @git-diff-view/lowlight 的 processAST（MIT）：把高亮器给的语法树按行拆开，记下每段文字在行里的起止位置。
// @git-diff-view/react 的类型里声明了 processAST，实际却没导出它；lowlight 整包又带着全部 highlight.js，所以自己写一份
type Node = { type: string; value?: string; children?: Node[]; lineNumber?: number; startIndex?: number; endIndex?: number; properties?: unknown }
type Line = { value: string; lineNumber: number; valueLength: number; nodeList: { node: Node; wrapper?: Node }[] }

export const processAST = ((ast: { children: Node[] }) => {
	let lineNumber = 1
	const lines: Record<number, Line> = {}
	const add = (node: Node, value: string, n: number, wrapper?: Node) => {
		const line = lines[n]
		node.startIndex = line ? line.valueLength : 0
		node.endIndex = node.startIndex + value.length - 1
		if (line) {
			line.value += value
			line.valueLength += value.length
			line.nodeList.push({ node, wrapper })
		} else lines[n] = { value, lineNumber: n, valueLength: value.length, nodeList: [{ node, wrapper }] }
	}
	const walk = (nodes: Node[], wrapper?: Node) => {
		for (const node of nodes) {
			if (node.type === 'text') {
				const value = node.value ?? ''
				if (!value.includes('\n')) {
					add(node, value, lineNumber, wrapper)
					node.lineNumber = lineNumber
					continue
				}
				const parts = value.split('\n')
				node.children = node.children ?? []
				parts.forEach((part, i) => {
					const v = i === parts.length - 1 ? part : `${part}\n`
					const n = i === 0 ? lineNumber : ++lineNumber
					const child: Node = { type: 'text', value: v, lineNumber: n }
					add(child, v, n, wrapper)
					node.children!.push(child)
				})
				node.lineNumber = lineNumber
				continue
			}
			if (node.children) {
				walk(node.children, node)
				node.lineNumber = lineNumber
			}
		}
	}
	walk(ast.children)
	return { syntaxFileObject: lines, syntaxFileLineNumber: lineNumber }
}) as unknown as DiffFileHighlighter['processAST']
