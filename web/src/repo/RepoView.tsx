import { ChevronDown, ChevronLeft, FolderGit2, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Conn } from '../conn'
import { repoFor, setRepoFor } from '../store'
import { repoApi, type Repo } from './api'
import './repo.css'
import { ChangesTab, CommitsTab, FilesTab, type Screen } from './tabs'
import { useLoad } from './useLoad'
import { CodeScreen, CommitScreen, DiffScreen, Loading, Note } from './views'

const STATUS_DOT: Record<string, string> = { working: 'bg-wait', blocked: 'bg-destructive', done: 'bg-ok', idle: 'bg-muted-foreground' }

function RepoPicker(props: { repos?: Repo[]; current?: string; open: boolean; onOpenChange: (o: boolean) => void; onPick: (path: string) => void }) {
	const [manual, setManual] = useState('')
	return (
		<Drawer open={props.open} onOpenChange={props.onOpenChange}>
			<DrawerContent className="max-h-[80dvh]">
				<DrawerHeader className="text-left">
					<DrawerTitle>选仓库</DrawerTitle>
					<DrawerDescription>herdr 里各个 agent 所在的仓库</DrawerDescription>
				</DrawerHeader>
				<ul className="scroll divide-y">
					{!props.repos && <Loading />}
					{props.repos?.length === 0 && <Note>herdr 里没找到在 git 仓库里的 agent，可以在下面填路径</Note>}
					{props.repos?.map(r => (
						<li key={r.path}>
							<button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-accent" onClick={() => props.onPick(r.path)}>
								<FolderGit2 className="size-5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1">
									<span className="block truncate font-medium">
										{r.name} <span className="font-mono text-sm font-normal text-muted-foreground">{r.branch}</span>
									</span>
									<span className="block truncate font-mono text-xs text-muted-foreground">{r.path}</span>
								</span>
								<span className="flex gap-1">
									{r.agents.map((a, i) => (
										<span key={i} title={`${a.agent} ${a.status}`} className={`size-2 rounded-full ${STATUS_DOT[a.status] ?? 'bg-muted-foreground'}`} />
									))}
								</span>
							</button>
						</li>
					))}
				</ul>
				<form
					className="flex gap-2 p-4"
					onSubmit={e => {
						e.preventDefault()
						if (manual.trim()) props.onPick(manual.trim())
					}}
				>
					<Input value={manual} onChange={e => setManual(e.currentTarget.value)} placeholder="/Users/me/repos/project" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="font-mono" />
					<Button type="submit" variant="secondary" disabled={!manual.trim()}>
						打开
					</Button>
				</form>
			</DrawerContent>
		</Drawer>
	)
}

export default function RepoView(props: { conn: Conn; hostId: string; onClose: () => void }) {
	const api = useMemo(() => repoApi(props.conn), [props.conn])
	const repos = useLoad(() => api.repos(), [api])
	const [repo, setRepo] = useState(() => repoFor(props.hostId))
	const [tab, setTab] = useState('changes')
	const [stack, setStack] = useState<Screen[]>([])
	const [picking, setPicking] = useState(false)
	const [nonce, setNonce] = useState(0)
	useEffect(() => {
		if (!repo && repos.data?.length) setRepo(repos.data[0].path)
		if (!repo && repos.data?.length === 0) setPicking(true)
	}, [repo, repos.data])
	const top = stack.at(-1)
	const current = repos.data?.find(r => r.path === repo)
	const name = current?.name ?? repo?.split('/').pop()
	const pick = (path: string) => {
		setRepoFor(props.hostId, path)
		setRepo(path)
		setStack([])
		setPicking(false)
	}
	const push = (s: Screen) => setStack(st => [...st, s])
	const tabProps = repo && { api, repo, push }

	// 挂到 body 下：放在终端抽屉里会被抽屉那套老按钮样式管着
	return createPortal(
		<div className="repo-view fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
			<header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
				<Button variant="ghost" size="icon" aria-label={top ? '返回' : '关闭'} onClick={top ? () => setStack(st => st.slice(0, -1)) : props.onClose}>
					{top ? <ChevronLeft className="size-5" /> : <X className="size-5" />}
				</Button>
				{top ? (
					<span className="min-w-0 flex-1 truncate font-mono text-sm">{top.title}</span>
				) : (
					<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setPicking(true)}>
						<FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
						<span className="truncate font-medium">{name ?? '选仓库'}</span>
						{current?.branch && <span className="truncate font-mono text-sm text-muted-foreground">{current.branch}</span>}
						<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
					</button>
				)}
				{!top && repo && (
					<Button variant="ghost" size="icon" aria-label="刷新" onClick={() => setNonce(n => n + 1)}>
						<RefreshCw className="size-4" />
					</Button>
				)}
			</header>

			{top?.kind === 'diff' && <DiffScreen load={top.load} />}
			{top?.kind === 'file' && repo && <CodeScreen api={api} repo={repo} rev={top.rev} path={top.path} />}
			{top?.kind === 'commit' && repo && <CommitScreen api={api} repo={repo} rev={top.rev} />}
			{!top && tabProps && (
				<Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
					<TabsList className="mx-3 my-2 grid grid-cols-3">
						<TabsTrigger value="changes">改动</TabsTrigger>
						<TabsTrigger value="files">文件</TabsTrigger>
						<TabsTrigger value="commits">提交</TabsTrigger>
					</TabsList>
					<TabsContent value="changes" className="scroll min-h-0 flex-1 pb-8">
						<ChangesTab key={repo + nonce} {...tabProps} />
					</TabsContent>
					<TabsContent value="files" className="scroll min-h-0 flex-1 pb-8">
						<FilesTab key={repo + nonce} {...tabProps} />
					</TabsContent>
					<TabsContent value="commits" className="scroll min-h-0 flex-1 pb-8">
						<CommitsTab key={repo + nonce} {...tabProps} />
					</TabsContent>
				</Tabs>
			)}
			{!top && !repo && <Note>还没选仓库</Note>}
			<RepoPicker repos={repos.data} current={repo} open={picking} onOpenChange={setPicking} onPick={pick} />
		</div>,
		document.body,
	)
}
