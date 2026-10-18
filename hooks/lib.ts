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
  // The session's title, which Claude Code also puts on the terminal tab.
  tabTitle?: string | null
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
  // When the main thread last sent a request that used the prompt cache, and
  // the cache's TTL as the transcript's last cache write shows it (null: not known yet).
  cache?: { at: number; ttl: CacheTtl | null } | null
  // The session's claude.exe and what it started, sampled once a minute (Windows only).
  memory?: SessionMemory | null
}

export type CacheTtl = '5m' | '1h'

// A process under the session, as the memory probe reports it. Sizes in MB:
// `mb` is private memory, `wsMb` the working set (what is in physical RAM).
export type ProcRec = { pid: number; ppid: number; name: string; cmd: string; mb: number; wsMb: number }
export type ProbeResult = { root: number; procs: ProcRec[] }

// One direct child of the session's claude.exe with everything under it, such as
// an MCP server's npx wrapper and the node process it runs.
export type ChildMem = { label: string; mb: number; procs: number }

export type SessionMemory = {
  pid: number
  at: number
  mb: number
  wsMb: number
  childMb: number
  children: ChildMem[]
  // [time, mb] of the claude.exe process, oldest first.
  history: [number, number][]
}

export const MEMORY_HISTORY = 120 // two hours at one sample a minute

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
// but no link to the PR itself. The JSON can follow other output, so it's
// matched rather than parsed; more than one id is a listing.
function adoJsonPrUrl(text: string): string | null {
  const ids = new Set([...text.matchAll(/"pullRequestId":\s*(\d+)/g)].map((m) => m[1]))
  const web = text.match(/"webUrl":\s*"(https:\/\/[^"]*\/_git\/[^"/]+)"/)?.[1]
  const [id] = ids
  return ids.size === 1 && web ? `${web}/pullrequest/${id}` : null
}

// The web URL of an Azure DevOps repo from its remote, and the repo's name.
function adoRepoOf(remote: string): { web: string; repo: string } | null {
  const m = remote.match(/^https:\/\/(?:[^@/]+@)?((?:dev\.azure\.com\/[^/]+|[\w-]+\.visualstudio\.com)\/[^/]+\/_git\/([^/?#\s]+))/i)
  return m?.[1] && m[2] ? { web: `https://${m[1]}`, repo: decode(m[2]) } : null
}

// `az repos pr update --id 36067 --query pullRequestId -o tsv` names the PR
// only by number, so its link is built from the session repo's remote. Skipped
// when the command names another repository.
export function adoPrOfCommand(command: string, output: string, remote: string | null): Omit<PrRec, 'at'> | null {
  const call = command.match(/\baz\s+repos\s+pr\s+(\w[\w-]*)[^;&|\n]*/i)
  const ado = remote ? adoRepoOf(remote) : null
  if (!call || !ado || call[1]?.toLowerCase() === 'list') return null
  const args = call[0]
  const named = args.match(/\s(?:--repository|-r)[=\s]+["']?([^"'\s]+)/)?.[1]
  if (named && decode(named).toLowerCase() !== ado.repo.toLowerCase()) return null
  const id = args.match(/\s--id[=\s]+["']?(\d+)/)?.[1] ?? (call[1]?.toLowerCase() === 'create' ? output.trim().match(/(?:^|\n)(\d+)$/)?.[1] : undefined)
  return id ? { url: `${ado.web}/pullrequest/${id}`, repo: ado.repo, number: Number(id), host: 'ado' } : null
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

// Tools whose output can name a PR this session made or works on. Listings
// are skipped, matched as the gh or az call itself: a PR body passed in the
// same command can mention "pr list" in prose.
export function scansForPrs(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : ''
    return !/\b(?:gh|az\s+repos)\s+pr\s+list\b/i.test(command)
  }
  return tool === 'Agent' || tool.startsWith('mcp__')
}

// The PRs a finished tool call names: links in its output, or for an
// `az repos pr` command, the PR it acts on.
export function prsOfTool(tool: string, input: Record<string, unknown>, output: string, remote: string | null): Omit<PrRec, 'at'>[] {
  const found = prLinksOf(output)
  if (tool === 'Bash' || tool === 'PowerShell') {
    const byNumber = adoPrOfCommand(typeof input.command === 'string' ? input.command : '', output, remote)
    if (byNumber) found.push(byNumber)
  }
  return found
}

// Adds PRs not seen yet and returns those.
export function addPrs(board: Board, prs: Omit<PrRec, 'at'>[], now: number): PrRec[] {
  const added: PrRec[] = []
  for (const pr of prs) {
    const same = (p: PrRec) => p.host === pr.host && p.number === pr.number && p.repo.toLowerCase() === pr.repo.toLowerCase()
    if (board.prs.some(same)) continue
    const rec = { ...pr, at: now }
    board.prs.push(rec)
    added.push(rec)
  }
  if (board.prs.length > MAX_PRS) board.prs.splice(0, board.prs.length - MAX_PRS)
  return added
}

// The folder under ~/.claude/projects that holds a session's transcript:
// its cwd with every character but letters and digits made a dash.
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// The session's title from its transcript: the last /rename, else the last
// title Claude Code generated. The terminal tab shows the same one.
export function sessionTitleOf(transcript: string): string | null {
  let custom: string | null = null
  let ai: string | null = null
  for (const line of transcript.split('\n')) {
    if (!line.includes('-title"')) continue
    try {
      const rec = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown }
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') custom = rec.customTitle
      if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') ai = rec.aiTitle
    } catch {}
  }
  const title = (custom ?? ai)?.trim()
  return title ? clip(title, 120) : null
}

type UsageRec = {
  isSidechain?: boolean
  message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
}

// The TTL of the main thread's newest cache write, from the usage the API
// reported on each response. Null when the transcript has none yet.
export function cacheTtlOf(transcript: string): CacheTtl | null {
  let ttl: CacheTtl | null = null
  for (const line of transcript.split('\n')) {
    if (!line.includes('"ephemeral_')) continue
    try {
      const rec = JSON.parse(line) as UsageRec
      const written = rec.message?.usage?.cache_creation
      if (rec.isSidechain || !written) continue
      if ((written.ephemeral_1h_input_tokens ?? 0) > 0) ttl = '1h'
      else if ((written.ephemeral_5m_input_tokens ?? 0) > 0) ttl = '5m'
    } catch {}
  }
  return ttl
}

const SHELLS = new Set(['cmd.exe', 'conhost.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe'])
const TOOL_SHELLS = new Set(['powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe'])

// A name for a child process tree, its top process first: the npx package it
// runs (with the host for mcp-remote), "shell commands" for a Bash or
// PowerShell tool call, else its first process that isn't a shell.
export function childLabel(procs: ProcRec[]): string {
  const cmds = procs.map((p) => p.cmd).join('\n')
  const npx = cmds.match(/npx-cli\.js"?\s+(?:"?-[-\w]*"?\s+)*"?([^"\s]+)/)?.[1]
  if (npx) {
    const pkg = npx.replace(/(.)@[^/]*$/, '$1')
    const host = pkg === 'mcp-remote' ? cmds.match(/https?:\/\/([^/\s"]+)/)?.[1] : undefined
    return host ? `${pkg} ${host}` : pkg
  }
  if (procs[0] && TOOL_SHELLS.has(procs[0].name.toLowerCase())) return 'shell commands'
  const named = procs.find((p) => !SHELLS.has(p.name.toLowerCase())) ?? procs[0]
  return named ? named.name.replace(/\.exe$/i, '') : '?'
}

// The probe's JSON output; null when it found no claude.exe or printed something else.
export function parseProbe(stdout: string): ProbeResult | null {
  try {
    const raw = JSON.parse(stdout.trim()) as { root?: number; procs?: ProcRec | ProcRec[] }
    if (!raw.root || !raw.procs) return null
    return { root: raw.root, procs: Array.isArray(raw.procs) ? raw.procs : [raw.procs] }
  } catch {
    return null
  }
}

// Groups the processes under the session's claude.exe by its direct children
// and appends the sample to the history, which starts over if the PID changed.
export function memoryOf(probe: ProbeResult, at: number, previous: SessionMemory | null): SessionMemory | null {
  const root = probe.procs.find((p) => p.pid === probe.root)
  if (!root) return null
  const byPid = new Map(probe.procs.map((p) => [p.pid, p]))
  const groups = new Map<number, ProcRec[]>()
  for (const p of probe.procs) {
    if (p === root) continue
    let top = p
    for (let i = 0; i < 20 && top.ppid !== root.pid; i++) {
      const parent = byPid.get(top.ppid)
      if (!parent) break
      top = parent
    }
    if (top.ppid !== root.pid) continue
    groups.set(top.pid, [...(groups.get(top.pid) ?? []), p])
  }
  const children = [...groups.entries()]
    .map(([top, procs]) => [...procs.filter((p) => p.pid === top), ...procs.filter((p) => p.pid !== top)])
    .map((procs) => ({ label: childLabel(procs), mb: procs.reduce((sum, p) => sum + p.mb, 0), procs: procs.length }))
    .sort((a, b) => b.mb - a.mb)
  const history: [number, number][] = previous?.pid === root.pid ? [...previous.history, [at, root.mb]] : [[at, root.mb]]
  return {
    pid: root.pid,
    at,
    mb: root.mb,
    wsMb: root.wsMb,
    childMb: children.reduce((sum, c) => sum + c.mb, 0),
    children,
    history: history.slice(-MEMORY_HISTORY),
  }
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
    tabTitle: null,
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
    cache: null,
    memory: null,
  }
}
