import type { DiffFileHighlighter } from '@git-diff-view/react'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, bundledLanguagesAlias } from 'shiki/langs'
import { bundledThemes, type BundledTheme } from 'shiki/themes'
import { processAST } from './process-ast'

// 正则用 JavaScript 引擎，不用下 Oniguruma 的 wasm；语言和配色按需加载，各自拆包
let core: Promise<HighlighterCore> | undefined
const highlighter = () => (core ??= createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }))

const EXT: Record<string, string> = {
	ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
	py: 'python', rs: 'rust', rb: 'ruby', kt: 'kotlin', md: 'markdown', yml: 'yaml', sh: 'shellscript', bash: 'shellscript',
	zsh: 'shellscript', h: 'c', hpp: 'cpp', cc: 'cpp', hh: 'cpp', cs: 'csharp', ps1: 'powershell', bat: 'bat', toml: 'toml',
}
const NAMES: Record<string, string> = { Dockerfile: 'docker', Makefile: 'make', 'go.mod': 'go', 'go.sum': 'text' }

const loaders: Record<string, (typeof bundledLanguages)[keyof typeof bundledLanguages]> = { ...bundledLanguagesAlias, ...bundledLanguages }
const known = (id: string) => (id in loaders ? id : undefined)

export function langOf(path: string): string | undefined {
	const base = path.split('/').pop() ?? ''
	if (NAMES[base]) return known(NAMES[base])
	const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
	return known(EXT[ext] ?? ext)
}

// 先异步把配色和要用的语言载进来，之后的高亮都是同步的（diff 组件要求同步）
export async function prepare(theme: string, paths: string[]) {
	const h = await highlighter()
	if (!h.getLoadedThemes().includes(theme)) await h.loadTheme(bundledThemes[theme as BundledTheme]())
	const langs = [...new Set(paths.map(langOf).filter((l): l is string => !!l))]
	await Promise.all(langs.filter(l => !h.getLoadedLanguages().includes(l)).map(l => h.loadLanguage(loaders[l]())))
	return h
}

export const codeHtml = (h: HighlighterCore, code: string, path: string, theme: string) => {
	const lang = langOf(path)
	return h.codeToHtml(code, { lang: lang && h.getLoadedLanguages().includes(lang) ? lang : 'text', theme })
}

export function diffHighlighter(h: HighlighterCore, theme: string): DiffFileHighlighter {
	let maxLine = 20000
	let ignore: (string | RegExp)[] = []
	return {
		name: `shiki-${theme}`,
		type: 'style',
		get maxLineToIgnoreSyntax() {
			return maxLine
		},
		setMaxLineToIgnoreSyntax: v => (maxLine = v),
		get ignoreSyntaxHighlightList() {
			return ignore
		},
		setIgnoreSyntaxHighlightList: v => (ignore = v),
		getAST: (raw: string, fileName?: string) => {
			const lang = fileName ? langOf(fileName) : undefined
			return h.codeToHast(raw, { lang: lang && h.getLoadedLanguages().includes(lang) ? lang : 'text', theme }) as ReturnType<DiffFileHighlighter['getAST']>
		},
		processAST,
		hasRegisteredCurrentLang: () => true,
	}
}
