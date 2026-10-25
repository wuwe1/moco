import { processAST } from './process-ast'

// @git-diff-view/core 默认拿 lowlight（带全部 highlight.js，近 1 MB）兜底高亮；我们总是传自己的 Shiki 高亮器，
// vite.config 把 @git-diff-view/lowlight 指到这里：兜底的这个什么都不高亮（maxLineToIgnoreSyntax 为 0，直接跳过）
export const highlighter = {
	name: 'none',
	type: 'class',
	maxLineToIgnoreSyntax: 0,
	setMaxLineToIgnoreSyntax: () => {},
	ignoreSyntaxHighlightList: [],
	setIgnoreSyntaxHighlightList: () => {},
	getAST: () => ({ type: 'root', children: [] }),
	processAST,
	hasRegisteredCurrentLang: () => false,
	getHighlighterEngine: () => null,
}
export { processAST }
export const versions = 'stub'
