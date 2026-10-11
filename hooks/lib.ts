// Pure helpers and the shape of a session's status file. No `$` here, so the
// tests can run them directly.

export type SessionState = 'running' | 'waiting' | 'background' | 'idle' | 'ended'

export type ToolRec = {
  id: string
  tool: string
  summary: string
  agentId?: string
  since: number
}

export type AgentRec = {
  key: string
  agentId?: string
  type: string
  description: string
  status: 'running' | 'idle' | 'done' | 'failed'
  since: number
  endedAt?: number
  lastTool?: string
}

export type BoardEvent = {
  t: number
  kind: 'session' | 'prompt' | 'skill' | 'agent' | 'tool' | 'error' | 'turn' | 'waiting'
  text: string
  agent?: string
}

export type PrRec = {
  url: string
  repo: string
  number: number
  host: 'github' | 'ado'
  at: number
}

export type Waiting = {
  kind: 'permission' | 'question' | 'plan' | 'notification'
  detail: string
  tool?: string
  since: number
}

// The file each session writes to <board>/sessions/<sessionId>.json.
export type Board = {
  v: 1
  sessionId: string
  interactive: boolean
  cwd: string
  project: string
  repo: { name: string | null; root: string; remote: string | null } | null
  branch: string | null
  model: string | null
  startedAt: number
  updatedAt: number
  state: SessionState
  stateSince: number
  endReason?: string
  waiting: Waiting | null
  prompt: string | null
  promptAt: number | null
  skill: { name: string; args: string; at: number } | null
  activeSkill: string | null
  workItem: string | null
  prs: PrRec[]
  turns: number
  tools: ToolRec[]
  agents: AgentRec[]
  events: BoardEvent[]
  context: { percent: number | null; tokens: number | null; window: number } | null
  costUsd: number | null
}

export const MAX_EVENTS = 80
export const MAX_AGENTS = 30
export const MAX_PRS = 6

// Tools too frequent to be worth a line in the timeline. They still show as
// the session's current activity while they run.
export const QUIET_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'LS', 'SubagentHandback'])

export function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function toolLabel(tool: string): string {
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  return mcp ? `${(mcp[1] ?? '').replace(/^claude_ai_/, '')} · ${mcp[2]}` : tool
}

// One short line saying what a tool call is doing.
export function summarize(tool: string, input: Record<string, unknown>): string {
  const s = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return clip(s('command'), 120)
    case 'Read':
    case 'Write':
    case 'Edit':
      return basename(s('file_path'))
    case 'NotebookEdit':
      return basename(s('notebook_path'))
    case 'Grep':
    case 'Glob':
      return clip(s('pattern'), 80)
    case 'Agent':
      return clip(`${s('subagent_type') || 'general-purpose'}: ${s('description')}`, 120)
    case 'Skill':
      return clip(`${s('skill')} ${s('args')}`, 120)
    case 'WebFetch':
      return clip(s('url'), 120)
    case 'WebSearch':
      return clip(s('query'), 120)
    case 'AskUserQuestion': {
      const questions = input.questions as { question?: string }[] | undefined
      return clip(questions?.[0]?.question ?? '', 160)
    }
    default:
      return clip(s('description') || s('command') || s('query') || s('url'), 120)
  }
}

// "/deliver-story 1234" -> { name, args }. A slash command reaches the
// turn as markup: <command-name>/x</command-name> ... <command-args>y</command-args>.
export function slashCommand(text: string): { name: string; args: string } | null {
  const tagged = text.match(/<command-name>\/?([^<]+)<\/command-name>/)
  if (tagged?.[1]) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? ''
    return { name: tagged[1].trim(), args: clip(args, 200) }
  }
  const tag = text.match(/^\s*<command-message>([^<]+)<\/command-message>/)
  if (tag?.[1]) return { name: tag[1].trim(), args: '' }
  const m = text.trim().match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/)
  return m?.[1] ? { name: m[1], args: clip(m[2] ?? '', 200) } : null
}

// A work item id: "#1234" anywhere, or a bare 4–7 digit number in skill args.
export function workItemOf(text: string, allowBare: boolean): string | null {
  const hash = text.match(/#(\d{3,7})\b/)
  if (hash?.[1]) return hash[1]
  if (!allowBare) return null
  const bare = text.match(/\b(\d{4,7})\b/)
  return bare?.[1] ?? null
}

// A pull request's web URL on GitHub or Azure DevOps (both host styles).
const PR_URL =
  /https:\/\/(?:github\.com\/[\w.-]+\/([\w.-]+)\/pull|(?:dev\.azure\.com\/[^/\s"'<>]+|[\w-]+\.visualstudio\.com)\/[^/\s"'<>]+\/_git\/([^/\s"'<>]+)\/pullrequest)\/(\d+)/gi

// More PRs than this in one piece of text is a listing, not this session's PR.
const MAX_PRS_PER_TEXT = 3

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

// `az repos pr create/show` prints JSON with the id and the repo's web URL,
// but no link to the PR itself.
function adoJsonPrUrl(text: string): string | null {
  if (!text.trimStart().startsWith('{')) return null
  try {
    const obj = JSON.parse(text) as { pullRequestId?: unknown; repository?: { webUrl?: unknown } }
    const web = obj.repository?.webUrl
    return typeof obj.pullRequestId === 'number' && typeof web === 'string' ? `${web.replace(/\/+$/, '')}/pullrequest/${obj.pullRequestId}` : null
  } catch {
    return null
  }
}

// The PR links in a tool's output, a prompt or an agent's report.
export function prLinksOf(text: string): Omit<PrRec, 'at'>[] {
  const found = new Map<string, Omit<PrRec, 'at'>>()
  const json = adoJsonPrUrl(text)
  for (const source of json ? [json, text] : [text]) {
    for (const m of source.matchAll(PR_URL)) {
      const github = m[1] !== undefined
      const repo = decode(m[1] ?? m[2] ?? '')
      const number = Number(m[3])
      const url = m[0]
      const key = `${github ? 'github' : 'ado'}:${repo.toLowerCase()}:${number}`
      if (!found.has(key)) found.set(key, { url, repo, number, host: github ? 'github' : 'ado' })
    }
  }
  return found.size > MAX_PRS_PER_TEXT ? [] : [...found.values()]
}

// Tools whose output can name a PR this session made or works on. Listings are skipped.
export function scansForPrs(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : ''
    return !/\bpr\s+list\b/i.test(command)
  }
  return tool === 'Agent' || tool.startsWith('mcp__')
}

// Adds PRs not seen yet; returns whether any were new.
export function addPrs(board: Board, prs: Omit<PrRec, 'at'>[], now: number): boolean {
  let added = false
  for (const pr of prs) {
    const same = (p: PrRec) => p.host === pr.host && p.number === pr.number && p.repo.toLowerCase() === pr.repo.toLowerCase()
    if (board.prs.some(same)) continue
    board.prs.push({ ...pr, at: now })
    added = true
  }
  if (board.prs.length > MAX_PRS) board.prs.splice(0, board.prs.length - MAX_PRS)
  return added
}

export function pushEvent(board: Board, event: BoardEvent): void {
  board.events.push(event)
  if (board.events.length > MAX_EVENTS) board.events.splice(0, board.events.length - MAX_EVENTS)
}

// Keep running agents, drop the oldest finished ones past the cap.
export function trimAgents(agents: AgentRec[]): AgentRec[] {
  if (agents.length <= MAX_AGENTS) return agents
  const finished = agents.filter((a) => a.status === 'done' || a.status === 'failed')
  const drop = new Set(finished.slice(0, agents.length - MAX_AGENTS))
  return agents.filter((a) => !drop.has(a))
}

export function deriveState(board: Board, mainRunning: boolean): SessionState {
  if (board.state === 'ended') return 'ended'
  if (board.waiting) return 'waiting'
  if (mainRunning) return 'running'
  if (board.agents.some((a) => a.status === 'running')) return 'background'
  return 'idle'
}

export function agentStatusOf(status: string): AgentRec['status'] {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
    case 'killed':
      return 'failed'
    case 'idle':
      return 'idle'
    default:
      return 'running'
  }
}

export function freshBoard(sessionId: string, cwd: string, now: number): Board {
  return {
    v: 1,
    sessionId,
    interactive: true,
    cwd,
    project: basename(cwd),
    repo: null,
    branch: null,
    model: null,
    startedAt: now,
    updatedAt: now,
    state: 'idle',
    stateSince: now,
    waiting: null,
    prompt: null,
    promptAt: null,
    skill: null,
    activeSkill: null,
    workItem: null,
    prs: [],
    turns: 0,
    tools: [],
    agents: [],
    events: [],
    context: null,
    costUsd: null,
  }
}
