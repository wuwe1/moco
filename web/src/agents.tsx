import type { AgentStatus, HerdrState } from './herdr'

export const STATUS_WORD: Record<AgentStatus, string> = { blocked: '等你', done: '干完了', working: '干活中', idle: '空闲', unknown: '不确定' }
const ORDER: AgentStatus[] = ['blocked', 'done', 'working', 'idle', 'unknown']

export const StatusDot = ({ status }: { status: AgentStatus }) => <span className="agent-dot" data-status={status} />

export const byUrgency = (agents: HerdrState['agents']) => [...agents].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
