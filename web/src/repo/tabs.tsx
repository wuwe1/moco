import { ChevronRight, File, FileDiff, Folder, GitCommitHorizontal, Package } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import type { Commit, FileStatus, RepoApi } from './api'
import { Failed, formatSize, Loading, Note, when } from './views'
import { useLoad } from './useLoad'

export type Screen =
	| { kind: 'diff'; title: string; load: () => Promise<{ diff: string; truncated: boolean }> }
	| { kind: 'file'; title: string; rev: string; path: string }
	| { kind: 'commit'; title: string; rev: string }

type TabProps = { api: RepoApi; repo: string; push: (s: Screen) => void }

const KIND: Record<FileStatus['kind'], { letter: string; className: string }> = {
	modified: { letter: 'M', className: 'text-wait' },
	added: { letter: 'A', className: 'text-ok' },
	deleted: { letter: 'D', className: 'text-destructive' },
	renamed: { letter: 'R', className: 'text-wait' },
	untracked: { letter: 'U', className: 'text-ok' },
	conflict: { letter: '!', className: 'text-destructive' },
}

function Row(props: { icon?: React.ReactNode; title: React.ReactNode; detail?: React.ReactNode; onClick: () => void; label?: string }) {
	return (
		<li>
			<button type="button" aria-label={props.label} className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left active:bg-accent" onClick={props.onClick}>
				{props.icon}
				<span className="min-w-0 flex-1">{props.title}</span>
				{props.detail}
				<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
			</button>
		</li>
	)
}

const PathTitle = ({ path }: { path: string }) => {
	const i = path.lastIndexOf('/')
	return (
		<span className="block truncate font-mono text-sm">
			{i >= 0 && <span className="text-muted-foreground">{path.slice(0, i + 1)}</span>}
			{path.slice(i + 1)}
		</span>
	)
}

export function ChangesTab({ api, repo, push }: TabProps) {
	const s = useLoad(() => api.status(repo), [repo])
	if (s.error) return <Failed error={s.error} />
	if (!s.data) return <Loading />
	const { files } = s.data
	const groups: { title: string; files: FileStatus[]; mode: 'staged' | 'unstaged' | 'untracked' }[] = [
		{ title: '已暂存', mode: 'staged', files: files.filter(f => f.kind !== 'untracked' && f.staged !== ' ') },
		{ title: '未暂存', mode: 'unstaged', files: files.filter(f => f.kind !== 'untracked' && f.unstaged !== ' ') },
		{ title: '未跟踪', mode: 'untracked', files: files.filter(f => f.kind === 'untracked') },
	]
	return (
		<div>
			<p className="flex items-center gap-2 px-4 pt-3 pb-1 text-sm text-muted-foreground">
				<span className="font-mono">{s.data.branch || `(${s.data.head})`}</span>
				{s.data.ahead > 0 && <Badge variant="secondary">↑{s.data.ahead}</Badge>}
				{s.data.behind > 0 && <Badge variant="secondary">↓{s.data.behind}</Badge>}
			</p>
			{!files.length && <Note>工作区是干净的</Note>}
			{groups
				.filter(g => g.files.length)
				.map(g => (
					<section key={g.mode}>
						<h3 className="px-4 pt-4 pb-1 text-[13px] font-medium text-muted-foreground">
							{g.title} · {g.files.length}
						</h3>
						<ul className="divide-y">
							{g.files.map(f => (
								<Row
									key={f.path}
									icon={<span className={`w-4 shrink-0 text-center font-mono text-sm font-semibold ${KIND[f.kind].className}`}>{KIND[f.kind].letter}</span>}
									title={<PathTitle path={f.path} />}
									onClick={() =>
										push({
											kind: 'diff',
											title: f.path,
											load: () => api.diff(repo, { path: f.path, staged: g.mode === 'staged', untracked: g.mode === 'untracked' }),
										})
									}
								/>
							))}
						</ul>
					</section>
				))}
			{files.length > 0 && (
				<div className="flex gap-2 p-4">
					<Button variant="secondary" className="flex-1" onClick={() => push({ kind: 'diff', title: '全部未暂存的改动', load: () => api.diff(repo, {}) })}>
						<FileDiff /> 全部未暂存
					</Button>
					<Button variant="secondary" className="flex-1" onClick={() => push({ kind: 'diff', title: '全部已暂存的改动', load: () => api.diff(repo, { staged: true }) })}>
						<FileDiff /> 全部已暂存
					</Button>
				</div>
			)}
		</div>
	)
}

function RevPicker(props: { api: RepoApi; repo: string; open: boolean; onOpenChange: (o: boolean) => void; onPick: (rev: string, label: string) => void }) {
	const log = useLoad(() => (props.open ? props.api.log(props.repo, { n: 50 }) : Promise.resolve([] as Commit[])), [props.repo, props.open])
	return (
		<Drawer open={props.open} onOpenChange={props.onOpenChange}>
			<DrawerContent className="max-h-[80dvh]">
				<DrawerHeader className="text-left">
					<DrawerTitle>看哪个版本</DrawerTitle>
				</DrawerHeader>
				<ul className="scroll divide-y pb-6">
					<Row title="工作区（当前磁盘上的）" onClick={() => props.onPick('', '工作区')} />
					{log.loading && <Loading />}
					{log.data?.map(c => (
						<Row
							key={c.sha}
							icon={<GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />}
							title={
								<>
									<span className="block truncate text-sm">{c.subject}</span>
									<span className="font-mono text-xs text-muted-foreground">{c.short} · {when(c.time)}</span>
								</>
							}
							onClick={() => props.onPick(c.sha, c.short)}
						/>
					))}
				</ul>
			</DrawerContent>
		</Drawer>
	)
}

export function FilesTab({ api, repo, push }: TabProps) {
	const [rev, setRev] = useState({ sha: '', label: '工作区' })
	const [path, setPath] = useState('')
	const [picking, setPicking] = useState(false)
	const t = useLoad(() => api.tree(repo, rev.sha, path), [repo, rev.sha, path])
	const parts = path ? path.split('/') : []
	return (
		<div>
			<div className="flex items-center gap-2 px-4 pt-3 pb-2">
				<Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
					<GitCommitHorizontal /> {rev.label}
				</Button>
				<Breadcrumb className="min-w-0 flex-1 overflow-x-auto">
					<BreadcrumbList className="flex-nowrap">
						<BreadcrumbItem>
							{parts.length ? <BreadcrumbLink onClick={() => setPath('')}>根</BreadcrumbLink> : <BreadcrumbPage>根</BreadcrumbPage>}
						</BreadcrumbItem>
						{parts.map((p, i) => (
							<span key={i} className="contents">
								<BreadcrumbSeparator />
								<BreadcrumbItem>
									{i < parts.length - 1 ? (
										<BreadcrumbLink onClick={() => setPath(parts.slice(0, i + 1).join('/'))}>{p}</BreadcrumbLink>
									) : (
										<BreadcrumbPage>{p}</BreadcrumbPage>
									)}
								</BreadcrumbItem>
							</span>
						))}
					</BreadcrumbList>
				</Breadcrumb>
			</div>
			{t.error && <Failed error={t.error} />}
			{!t.data && !t.error && <Loading />}
			{t.data && !t.data.length && <Note>空目录</Note>}
			<ul className="divide-y">
				{t.data?.map(e => {
					const full = path ? `${path}/${e.name}` : e.name
					const icon = e.type === 'dir' ? <Folder className="size-4 shrink-0 text-wait" /> : e.type === 'submodule' ? <Package className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />
					return (
						<Row
							key={e.name}
							label={e.name}
							icon={icon}
							title={<span className="block truncate font-mono text-sm">{e.name}</span>}
							detail={e.size !== undefined && <span className="font-mono text-xs text-muted-foreground">{formatSize(e.size)}</span>}
							onClick={() => (e.type === 'dir' ? setPath(full) : e.type === 'file' && push({ kind: 'file', title: full, rev: rev.sha, path: full }))}
						/>
					)
				})}
			</ul>
			<RevPicker
				api={api}
				repo={repo}
				open={picking}
				onOpenChange={setPicking}
				onPick={(sha, label) => {
					setPicking(false)
					setRev({ sha, label })
				}}
			/>
		</div>
	)
}

const PAGE = 50

export function CommitsTab({ api, repo, push }: TabProps) {
	const [pages, setPages] = useState(1)
	const log = useLoad(() => api.log(repo, { n: PAGE * pages }), [repo, pages])
	if (log.error) return <Failed error={log.error} />
	if (!log.data) return <Loading />
	return (
		<div>
			{!log.data.length && <Note>还没有提交</Note>}
			<ul className="divide-y">
				{log.data.map(c => (
					<Row
						key={c.sha}
						title={
							<>
								<span className="block truncate text-sm">{c.subject}</span>
								<span className="block truncate font-mono text-xs text-muted-foreground">
									{c.short} · {c.author} · {when(c.time)}
								</span>
							</>
						}
						onClick={() => push({ kind: 'commit', title: c.short, rev: c.sha })}
					/>
				))}
			</ul>
			{log.data.length === PAGE * pages && (
				<div className="p-4">
					<Button variant="secondary" className="w-full" disabled={log.loading} onClick={() => setPages(p => p + 1)}>
						加载更多
					</Button>
				</div>
			)}
		</div>
	)
}
