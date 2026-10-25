import { DiffModeEnum, DiffView, type DiffFileHighlighter } from '@git-diff-view/react'
import '@git-diff-view/react/styles/diff-view-pure.css'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { currentTheme } from '../store'
import { splitDiff, type FileDiff, type RepoApi } from './api'
import { codeHtml, diffHighlighter, prepare } from './highlight'
import { useLoad } from './useLoad'

export function Loading() {
	return (
		<div className="space-y-2 p-4">
			{[80, 60, 70].map(w => (
				<Skeleton key={w} className="h-4" style={{ width: `${w}%` }} />
			))}
		</div>
	)
}

export const Failed = ({ error }: { error: string }) => <p className="p-4 text-sm text-destructive">{error}</p>
export const Note = ({ children }: { children: React.ReactNode }) => <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>

// 一组文件的 diff：每个文件一个可以收起的块，代码按当前主题高亮
export function DiffList({ text, truncated, collapsed = false }: { text: string; truncated: boolean; collapsed?: boolean }) {
	const diffs = useMemo(() => splitDiff(text), [text])
	const theme = currentTheme()
	const hl = useLoad(() => prepare(theme.shiki, diffs.map(d => d.newPath)).then(h => diffHighlighter(h, theme.shiki)), [text, theme.shiki])
	if (!diffs.length) return <Note>没有改动</Note>
	if (hl.loading) return <Loading />
	return (
		<div className="divide-y">
			{diffs.map(d => (
				<FileBlock key={d.newPath + d.oldPath} diff={d} highlighter={hl.data} mode={theme.mode} collapsed={collapsed && diffs.length > 1} />
			))}
			{truncated && <Note>diff 太长，后面的没有显示</Note>}
		</div>
	)
}

function FileBlock(props: { diff: FileDiff; highlighter?: DiffFileHighlighter; mode: 'dark' | 'light'; collapsed: boolean }) {
	const { diff } = props
	const [open, setOpen] = useState(!props.collapsed)
	const hasHunks = /^@@/m.test(diff.text)
	const name = diff.oldPath !== diff.newPath && diff.oldPath ? `${diff.oldPath} → ${diff.newPath}` : diff.newPath
	return (
		<section>
			<button type="button" className="flex w-full items-center gap-2 bg-card px-3 py-2 text-left text-sm" onClick={() => setOpen(o => !o)}>
				{open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
				<span className="min-w-0 flex-1 truncate font-mono">{name}</span>
				<span className="font-mono text-xs text-ok">+{diff.added}</span>
				<span className="font-mono text-xs text-destructive">−{diff.removed}</span>
			</button>
			{open &&
				(hasHunks ? (
					<div className="selectable">
						<DiffView
							data={{ oldFile: { fileName: diff.oldPath }, newFile: { fileName: diff.newPath }, hunks: [diff.text] }}
							diffViewMode={DiffModeEnum.Unified}
							diffViewWrap
							diffViewTheme={props.mode}
							diffViewFontSize={12}
							diffViewHighlight={!!props.highlighter}
							registerHighlighter={props.highlighter}
						/>
					</div>
				) : (
					<Note>二进制文件，或者只改了权限</Note>
				))}
		</section>
	)
}

export function DiffScreen({ load }: { load: () => Promise<{ diff: string; truncated: boolean }> }) {
	const d = useLoad(load, [load])
	if (d.error) return <Failed error={d.error} />
	if (!d.data) return <Loading />
	return (
		<div className="scroll min-h-0 flex-1">
			<DiffList text={d.data.diff} truncated={d.data.truncated} />
		</div>
	)
}

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`)

export function CodeScreen({ api, repo, rev, path }: { api: RepoApi; repo: string; rev: string; path: string }) {
	const theme = currentTheme()
	const f = useLoad(async () => {
		const file = await api.file(repo, rev, path)
		if (file.content === undefined) return { file }
		const h = await prepare(theme.shiki, [path])
		return { file, html: codeHtml(h, file.content, path, theme.shiki) }
	}, [repo, rev, path, theme.shiki])
	if (f.error) return <Failed error={f.error} />
	if (!f.data) return <Loading />
	const { file, html } = f.data
	if (file.binary) return <Note>二进制文件（{formatSize(file.size)}）</Note>
	if (file.tooLarge) return <Note>文件太大（{formatSize(file.size)}），不显示</Note>
	return <div className="code scroll selectable min-h-0 flex-1" dangerouslySetInnerHTML={{ __html: html! }} />
}

const when = (t: number) => new Date(t * 1000).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export function CommitScreen({ api, repo, rev }: { api: RepoApi; repo: string; rev: string }) {
	const c = useLoad(() => api.commit(repo, rev), [repo, rev])
	if (c.error) return <Failed error={c.error} />
	if (!c.data) return <Loading />
	const d = c.data
	return (
		<div className="scroll min-h-0 flex-1">
			<header className="selectable space-y-1 border-b px-4 py-3">
				<h2 className="text-base font-semibold">{d.subject}</h2>
				{d.body && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{d.body}</p>}
				<p className="font-mono text-xs text-muted-foreground">
					{d.short} · {d.author} · {when(d.time)}
				</p>
			</header>
			<DiffList text={d.diff} truncated={d.truncated} collapsed />
		</div>
	)
}

export { formatSize, when }
