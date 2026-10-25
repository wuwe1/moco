import type { Conn } from '../conn'

// 和 mocod 的 internal/server/git.go 对应
export type Agent = { agent: string; status: string; cwd: string }
export type Repo = { path: string; name: string; branch: string; agents: Agent[] }
export type FileKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'
export type FileStatus = { path: string; orig?: string; staged: string; unstaged: string; kind: FileKind }
export type Status = { branch: string; head: string; ahead: number; behind: number; files: FileStatus[] }
export type Diff = { diff: string; truncated: boolean }
export type Commit = { sha: string; short: string; author: string; time: number; subject: string }
export type CommitDetail = Commit & { body: string; diff: string; truncated: boolean }
export type TreeEntry = { name: string; type: 'dir' | 'file' | 'submodule'; size?: number }
export type FileContent = { content?: string; binary?: boolean; tooLarge?: boolean; size: number }

export const repoApi = (conn: Conn) => ({
	repos: () => conn.request<{ repos: Repo[] }>('repos').then(r => r.repos),
	status: (repo: string) => conn.request<Status>('status', { repo }),
	diff: (repo: string, p: { path?: string; staged?: boolean; untracked?: boolean }) => conn.request<Diff>('diff', { repo, ...p }),
	log: (repo: string, p: { n?: number; skip?: number; path?: string } = {}) => conn.request<{ commits: Commit[] }>('log', { repo, ...p }).then(r => r.commits),
	commit: (repo: string, rev: string) => conn.request<CommitDetail>('commit', { repo, rev }),
	tree: (repo: string, rev: string, path: string) => conn.request<{ entries: TreeEntry[] }>('tree', { repo, rev, path }).then(r => r.entries),
	file: (repo: string, rev: string, path: string) => conn.request<FileContent>('file', { repo, rev, path }),
})
export type RepoApi = ReturnType<typeof repoApi>

// 一段多个文件的 unified diff 按 "diff --git" 切成一个文件一段
export type FileDiff = { oldPath: string; newPath: string; text: string; added: number; removed: number }
export function splitDiff(text: string): FileDiff[] {
	const parts = text.split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git '))
	return parts.map(text => {
		const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(text)
		const minus = /^--- (?:a\/)?(.*)$/m.exec(text)?.[1]
		const plus = /^\+\+\+ (?:b\/)?(.*)$/m.exec(text)?.[1]
		let added = 0
		let removed = 0
		for (const line of text.split('\n')) {
			if (line.startsWith('+') && !line.startsWith('+++')) added++
			else if (line.startsWith('-') && !line.startsWith('---')) removed++
		}
		return {
			oldPath: minus && minus !== '/dev/null' ? minus : (m?.[1] ?? ''),
			newPath: plus && plus !== '/dev/null' ? plus : (m?.[2] ?? ''),
			text,
			added,
			removed,
		}
	})
}
