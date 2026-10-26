import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { byUrgency, StatusDot, STATUS_WORD } from './agents'
import { dlog } from './debug'
import { agentsIn, herdrOf, tabsOfFocused, useHerdr, type HerdrState } from './herdr'

type Tab = HerdrState['tabs'][number]

// 终端抽屉里的 herdr 面板：上面是快捷操作（新 tab、上/下一个、放大、按编号切），下面是所有 workspace 和 tab，带 agent 状态
export function HerdrPanel(props: { hostId: string; open: boolean; onOpenChange: (o: boolean) => void; onError: (msg: string) => void }) {
	const st = useHerdr(props.hostId)
	const call = (method: string, params: Record<string, unknown> = {}) => {
		dlog(`herdr 面板：${method} ${JSON.stringify(params)}`)
		props.onOpenChange(false)
		herdrOf(props.hostId)
			?.call(method, params)
			.catch(e => props.onError(`herdr 没切过去：${e.message}`))
	}
	// 有 agent 的 tab 切到最要紧的那个 agent 的窗格：herdr 顺带把「干完了」标成看过。
	// 用 pane.focus 不用 agent.focus：herdr 只在 workspace/tab/pane.focus 之后让连着的客户端跟过去，agent.focus 只改它自己记的焦点
	const go = (st: HerdrState, t: Tab) => {
		const a = byUrgency(agentsIn(st, t.id))[0]
		if (a) call('pane.focus', { pane_id: a.pane })
		else call('tab.focus', { tab_id: t.id })
	}

	return (
		<Drawer open={props.open} onOpenChange={props.onOpenChange}>
			<DrawerContent className="herdr-panel max-h-[85dvh]">
				<DrawerHeader className="text-left">
					<DrawerTitle>herdr</DrawerTitle>
					<DrawerDescription>{st ? `在看 ${st.workspaces.find(w => w.id === st.workspace)?.label ?? ''}` : '这台电脑上 herdr 没开'}</DrawerDescription>
				</DrawerHeader>
				{st && <Quick st={st} call={call} />}
				{st && (
					<div className="scroll pb-6">
						{[...st.workspaces]
							.sort((a, b) => a.number - b.number)
							.map(w => (
								<section key={w.id}>
									<h3 className="flex items-center gap-2 px-4 pt-4 pb-1 text-[13px] font-medium text-muted-foreground">
										<StatusDot status={w.status} />
										{w.label || `workspace ${w.number}`}
									</h3>
									<ul>
										{st.tabs
											.filter(t => t.workspace === w.id)
											.sort((a, b) => a.number - b.number)
											.map(t => (
												<TabRow key={t.id} st={st} tab={t} onClick={() => go(st, t)} />
											))}
									</ul>
								</section>
							))}
					</div>
				)}
			</DrawerContent>
		</Drawer>
	)
}

function Quick({ st, call }: { st: HerdrState; call: (method: string, params?: Record<string, unknown>) => void }) {
	const tabs = tabsOfFocused(st)
	const i = tabs.findIndex(t => t.id === st.tab)
	const current = tabs[i]
	const step = (d: number) => tabs.length > 1 && call('tab.focus', { tab_id: tabs[(i + d + tabs.length) % tabs.length].id })
	return (
		<div className="space-y-3 px-4">
			<div className="flex gap-2">
				<Button variant="secondary" className="flex-1" onClick={() => call('tab.create', { workspace_id: st.workspace, focus: true })}>
					<Plus /> 新 tab
				</Button>
				<ButtonGroup>
					<Button variant="secondary" size="icon" aria-label="上一个 tab" disabled={tabs.length < 2} onClick={() => step(-1)}>
						<ChevronLeft />
					</Button>
					<Button variant="secondary" size="icon" aria-label="下一个 tab" disabled={tabs.length < 2} onClick={() => step(1)}>
						<ChevronRight />
					</Button>
				</ButtonGroup>
				<Button variant="secondary" size="icon" aria-label={current?.zoomed ? '还原窗格' : '放大窗格'} disabled={!current || (current.panes < 2 && !current.zoomed)} onClick={() => call('pane.zoom')}>
					{current?.zoomed ? <Minimize2 /> : <Maximize2 />}
				</Button>
			</div>
			{tabs.length > 1 && (
				<div className="grid grid-cols-9 gap-1.5" aria-label="切到第几个 tab">
					{tabs.slice(0, 9).map(t => (
						<Button key={t.id} variant={t.id === st.tab ? 'default' : 'secondary'} className="relative h-10 px-0 font-mono" onClick={() => call('tab.focus', { tab_id: t.id })}>
							{t.number}
							{t.status !== 'unknown' && t.status !== 'idle' && <span className="absolute top-1 right-1"><StatusDot status={t.status} /></span>}
						</Button>
					))}
				</div>
			)}
		</div>
	)
}

function TabRow({ st, tab, onClick }: { st: HerdrState; tab: Tab; onClick: () => void }) {
	const agents = byUrgency(agentsIn(st, tab.id))
	const title = agents.find(a => a.title)?.title || tab.label
	const here = tab.id === st.tab
	return (
		<li>
			<button type="button" data-tab={tab.id} aria-current={here || undefined} className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-accent aria-[current]:bg-accent/60" onClick={onClick}>
				<span className="w-5 shrink-0 text-center font-mono text-sm text-muted-foreground">{tab.number}</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm">{title}</span>
					{agents.length > 0 && (
						<span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
							{agents.map(a => (
								<span key={a.pane} className="flex items-center gap-1">
									<StatusDot status={a.status} />
									{a.name} {STATUS_WORD[a.status]}
								</span>
							))}
						</span>
					)}
				</span>
				{tab.panes > 1 && <span className="text-xs text-muted-foreground">{tab.panes} 格</span>}
			</button>
		</li>
	)
}
