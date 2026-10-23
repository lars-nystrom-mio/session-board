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
  kind: 'question' | 'plan'
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
  // Jobs that will wake this session: CronCreate, /loop and ScheduleWakeup.
  crons?: CronRec[]
  // Background shells and monitors that haven't reported back yet.
  shells?: ShellRec[]
  // Set through the board_status tool: the task the session was started with is
  // finished. A queue in server/serve.py frees the session's slot on it.
  done?: { at: number; note: string } | null
}

// A background task the session will hear from: a Bash or PowerShell call run
// in the background, or a Monitor. `until` is when the board stops waiting for
// its notification, which can arrive inside a running turn, where no hook sees it.
export type ShellRec = { id: string; toolUseId: string; summary: string; since: number; until: number }

// A scheduled job. `cron` is '' for a ScheduleWakeup, which fires once at `nextAt`.
export type CronRec = {
  id: string
  cron: string
  human: string
  prompt: string
  recurring: boolean
  createdAt: number
  // When it fires next (null: the expression never matches again).
  nextAt: number | null
  // The scheduler's per-job offset from the cron match, kept for later firings.
  offsetMs: number
  firedAt?: number
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

// The organization at the start of an Azure DevOps URL, either host style. The
// name is letters, digits, `_`, `-` and `.` only, so what comes out is safe to
// put in a command line. The one place an org is read from text.
const ADO_ORG_URL = /^https:\/\/(?:[^@/]+@)?(?:dev\.azure\.com\/([\w.-]+)|([\w-]+)\.visualstudio\.com)(?=[/?#]|$)/i

function canonicalOrg(name: string): string {
  return `https://dev.azure.com/${name.toLowerCase()}`
}

// An Azure DevOps repo's web URL from its remote or `repository.webUrl`, the
// repo's name, and its organization as https://dev.azure.com/<org>.
export function adoRepoOf(url: string): { web: string; repo: string; org: string } | null {
  const text = url.trim()
  const o = text.match(ADO_ORG_URL)
  const name = o?.[1] ?? o?.[2]
  const r = o && name ? text.slice(o[0].length).match(/^\/([^/]+)\/_git\/([^/?#\s]+)/) : null
  if (!o || !name || !r?.[1] || !r[2]) return null
  return { web: `${o[0].replace(/^https:\/\/[^@/]+@/i, 'https://')}/${r[1]}/_git/${r[2]}`, repo: decode(r[2]), org: canonicalOrg(name) }
}

// What `--org` takes (a URL of either host style, or a bare name) as
// https://dev.azure.com/<org>; null for anything else.
export function adoOrgOf(text: string): string | null {
  const o = text.match(ADO_ORG_URL)
  const name = o?.[1] ?? o?.[2] ?? text.match(/^([\w.-]+)$/)?.[1]
  return name ? canonicalOrg(name) : null
}

// The command that asks Azure DevOps which repo a PR is in; stdout is the
// repo's web URL. The id is a number and the org is read back through
// `adoOrgOf`, so nothing from the original command reaches the script.
export function adoPrShowArgv(lookup: PrLookup): string[] | null {
  const org = /^https:\/\/dev\.azure\.com\/[\w.-]+$/.test(lookup.org) ? adoOrgOf(lookup.org) : null
  if (!org || !Number.isSafeInteger(lookup.id) || lookup.id <= 0) return null
  const script = `az repos pr show --id ${lookup.id} --org '${org}' --query repository.webUrl -o tsv`
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]
}

// A PR that an `az repos pr` command names only by number. Its id is unique
// within the organization, but which repo it is in isn't in the command.
export type PrLookup = { id: number; org: string }

// `az repos pr update --id 36067 --query pullRequestId -o tsv` names the PR
// only by number. The organization is the one the command names, else the
// session repo's. Nothing is guessed about the repo: the caller asks Azure
// DevOps (`adoPrLink` builds the link).
export function adoPrLookupOf(command: string, output: string, remote: string | null): PrLookup | null {
  const call = command.match(/\baz\s+repos\s+pr\s+(\w[\w-]*)[^;&|\n]*/i)
  if (!call || call[1]?.toLowerCase() === 'list') return null
  // Quoted text with spaces is a description or a title, not an option.
  const args = call[0].replace(/"[^"]*\s[^"]*"|'[^']*\s[^']*'/g, '""')
  const named = args.match(/\s(?:--organization|--org)[=\s]+(\S+)/)?.[1]?.replace(/^["']|["']$/g, '')
  const org = named !== undefined ? adoOrgOf(named) : remote ? (adoRepoOf(remote)?.org ?? null) : null
  const id = args.match(/\s--id[=\s]+["']?(\d+)/)?.[1] ?? (call[1]?.toLowerCase() === 'create' ? output.trim().match(/(?:^|\n)(\d+)$/)?.[1] : undefined)
  return org && id ? { id: Number(id), org } : null
}

// The PR's link, from its repo's `repository.webUrl` and its number.
export function adoPrLink(webUrl: string, id: number): Omit<PrRec, 'at'> | null {
  const ado = adoRepoOf(webUrl)
  return ado ? { url: `${ado.web}/pullrequest/${id}`, repo: ado.repo, number: id, host: 'ado' } : null
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

// The PRs a finished tool call names: links in its output. For an
// `az repos pr` command that names its PR only by number and whose output
// doesn't, a lookup to resolve (the caller asks Azure DevOps).
export function prsOfTool(tool: string, input: Record<string, unknown>, output: string, remote: string | null): { prs: Omit<PrRec, 'at'>[]; lookup: PrLookup | null } {
  const prs = prLinksOf(output)
  let lookup: PrLookup | null = null
  if (tool === 'Bash' || tool === 'PowerShell') {
    lookup = adoPrLookupOf(typeof input.command === 'string' ? input.command : '', output, remote)
    if (lookup && prs.some((p) => p.host === 'ado' && p.number === lookup?.id)) lookup = null
  }
  return { prs, lookup }
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

export const WAKEUP_ID = 'wakeup'
export const CRON_EXPIRY_MS = 7 * 24 * 3600_000 // the scheduler expires a recurring job after 7 days
const CRON_LATE_MS = 3600_000 // a one-shot this far past due without a firing seen is dropped
const FIRE_SLACK_MS = 90_000 // a turn this soon before a job's time can still be its firing

// The values one cron field allows, or null when it doesn't parse.
function cronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/)
    if (!m) return null
    const step = m[4] ? Number(m[4]) : 1
    let lo = m[1] === '*' ? min : Number(m[2])
    let hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo
    if (step < 1 || lo < min || hi > max || lo > hi) return null
    for (; lo <= hi; lo += step) values.add(lo)
  }
  return values
}

// The first minute after `after` that a 5-field cron expression matches, in
// local time; null when it doesn't parse or matches nothing within a year.
// Day of month and day of week both restricted means either may match.
export function nextCronMatch(cron: string, after: number): number | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return null
  const minute = cronField(f[0] ?? '', 0, 59)
  const hour = cronField(f[1] ?? '', 0, 23)
  const dom = cronField(f[2] ?? '', 1, 31)
  const month = cronField(f[3] ?? '', 1, 12)
  const dow = cronField(f[4] ?? '', 0, 7)
  if (!minute || !hour || !dom || !month || !dow) return null
  if (dow.has(7)) dow.add(0)
  const anyDom = f[2] === '*'
  const anyDow = f[4] === '*'
  const t = new Date(after)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  const end = after + 366 * 24 * 3600_000
  while (t.getTime() <= end) {
    const dayOk = anyDom || anyDow ? dom.has(t.getDate()) && dow.has(t.getDay()) : dom.has(t.getDate()) || dow.has(t.getDay())
    if (!month.has(t.getMonth() + 1) || !dayOk) {
      t.setHours(24, 0, 0, 0)
    } else if (!hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
    } else if (!minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1)
    } else {
      return t.getTime()
    }
  }
  return null
}

// The last match at or before `t`, looking back a day from `from`: the match
// the scheduler offset to get `t`, which can be later than the next match after `from`.
function matchBefore(cron: string, t: number, from: number): number | null {
  let last: number | null = null
  let m = nextCronMatch(cron, Math.min(from, t) - 24 * 3600_000)
  for (let i = 0; m !== null && m <= t && i < 3000; i++) {
    last = m
    m = nextCronMatch(cron, m)
  }
  return last
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function putCron(board: Board, rec: CronRec) {
  board.crons = [...(board.crons ?? []).filter((c) => c.id !== rec.id), rec]
}

// A job as the board keeps it, from CronCreate's input and result or a CronList entry.
function cronRec(id: string, cron: string, human: string, prompt: string, recurring: boolean, nextFireAt: number | null, now: number, previous?: CronRec): CronRec {
  const match = nextFireAt !== null ? matchBefore(cron, nextFireAt, now) : nextCronMatch(cron, now - (previous?.offsetMs ?? 0))
  const nextAt = nextFireAt ?? (match !== null ? match + (previous?.offsetMs ?? 0) : null)
  return {
    id,
    cron,
    human: clip(human || cron, 80),
    prompt: clip(prompt, 300),
    recurring,
    createdAt: previous?.createdAt ?? now,
    nextAt,
    offsetMs: nextFireAt !== null && match !== null ? nextFireAt - match : (previous?.offsetMs ?? 0),
    firedAt: previous?.firedAt,
  }
}

// Updates the board's jobs from a finished CronCreate, CronDelete, CronList or
// ScheduleWakeup call. Returns a line for the timeline, or null when the call
// wasn't one of these or its result had nothing to go on.
export function cronToolDone(board: Board, tool: string, input: Record<string, unknown>, result: unknown, now: number): string | null {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  switch (tool) {
    case 'CronCreate': {
      const id = str(r.id)
      if (!id) return null
      const recurring = typeof r.recurring === 'boolean' ? r.recurring : input.recurring !== false
      const rec = cronRec(id, str(input.cron), str(r.humanSchedule), str(input.prompt), recurring, num(r.nextFireAt), now)
      putCron(board, rec)
      return `scheduled ${rec.human}`
    }
    case 'CronDelete': {
      const id = str(r.id) || str(input.id)
      const before = board.crons?.length ?? 0
      board.crons = (board.crons ?? []).filter((c) => c.id !== id)
      return board.crons.length < before ? `unscheduled ${id}` : null
    }
    case 'CronList': {
      if (!Array.isArray(r.jobs)) return null
      const old = new Map((board.crons ?? []).map((c) => [c.id, c]))
      const listed = (r.jobs as Record<string, unknown>[]).filter((j) => str(j.id)).map((j) =>
        cronRec(str(j.id), str(j.cron), str(j.humanSchedule), str(j.prompt), j.recurring !== false, num(j.nextFireAt), now, old.get(str(j.id))))
      board.crons = [...(board.crons ?? []).filter((c) => c.id === WAKEUP_ID && !listed.some((j) => j.id === WAKEUP_ID)), ...listed]
      return null
    }
    case 'ScheduleWakeup': {
      const at = num(r.scheduledFor)
      board.crons = (board.crons ?? []).filter((c) => c.id !== WAKEUP_ID)
      if (r.stopped === true || at === null) return null
      const prompt = str(input.prompt)
      putCron(board, {
        id: WAKEUP_ID,
        cron: '',
        human: 'wakeup',
        prompt: clip(/^<<autonomous-loop/.test(prompt) ? '/loop (autonomous)' : prompt, 300),
        recurring: false,
        createdAt: now,
        nextAt: at,
        offsetMs: 0,
      })
      return null
    }
    default:
      return null
  }
}

// A main turn started: if it's a job firing, a one-shot is done and a
// recurring one moves on to its next match. A job is recognised by its prompt,
// a wakeup by its time having come, since its prompt may be a sentinel.
export function cronFired(board: Board, text: string, now: number): CronRec | null {
  const prompt = clip(text, 300)
  const fired = (board.crons ?? []).find((c) =>
    c.nextAt !== null && (c.id === WAKEUP_ID ? c.nextAt <= now + 5_000 : c.nextAt <= now + FIRE_SLACK_MS && prompt !== '' && c.prompt === prompt))
  if (!fired) return null
  if (fired.recurring) {
    const match = nextCronMatch(fired.cron, Math.max(now, fired.nextAt ?? now) - fired.offsetMs)
    fired.nextAt = match !== null ? match + fired.offsetMs : null
    fired.firedAt = now
  } else {
    board.crons = (board.crons ?? []).filter((c) => c !== fired)
  }
  return fired
}

// Drops jobs the scheduler has dropped by now, and moves a recurring job past
// a firing that went unseen (it may have fired into a busy turn).
export function pruneCrons(board: Board, now: number): void {
  if (!board.crons?.length) return
  board.crons = board.crons.filter((c) => {
    if (c.recurring) return c.createdAt + CRON_EXPIRY_MS > now
    return c.nextAt === null || c.nextAt + CRON_LATE_MS > now
  })
  for (const c of board.crons) {
    if (c.recurring && c.nextAt !== null && c.nextAt + FIRE_SLACK_MS < now) {
      const match = nextCronMatch(c.cron, now - c.offsetMs)
      c.nextAt = match !== null ? match + c.offsetMs : null
    }
  }
}

export const SHELL_MAX_MS = 2 * 3600_000 // a background shell not heard from in this long is forgotten

// Updates the board's background tasks from a finished tool call: a shell or a
// Monitor started, or TaskStop stopping one. Returns a line for the timeline.
export function shellToolDone(board: Board, tool: string, input: Record<string, unknown>, result: unknown, toolUseId: string, now: number): string | null {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  if (tool === 'TaskStop') {
    const id = str(input.task_id) || str(input.shell_id) || str(r.task_id)
    const before = board.shells?.length ?? 0
    board.shells = (board.shells ?? []).filter((s) => s.id !== id)
    return board.shells.length < before ? `stopped ${id}` : null
  }
  const id = tool === 'Monitor' ? str(r.taskId) : tool === 'Bash' || tool === 'PowerShell' ? str(r.backgroundTaskId) : ''
  if (!id) return null
  const timeout = tool === 'Monitor' && r.persistent !== true ? num(r.timeoutMs) : null
  const summary = summarize(tool, input)
  board.shells = [...(board.shells ?? []).filter((s) => s.id !== id),
    { id, toolUseId, summary, since: now, until: now + Math.min(timeout ?? SHELL_MAX_MS, SHELL_MAX_MS) }]
  return `in background: ${summary || tool}`
}

// A `<task-notification>` turn: the task it reports on has ended.
export function shellReported(board: Board, text: string): ShellRec | null {
  const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
  const use = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim()
  const ended = (board.shells ?? []).find((s) => s.id === id || (use !== undefined && s.toolUseId === use))
  if (ended) board.shells = (board.shells ?? []).filter((s) => s !== ended)
  return ended ?? null
}

export function pruneShells(board: Board, now: number): void {
  if (board.shells?.length) board.shells = board.shells.filter((s) => s.until > now)
}

export const BOARD_STATUS_TOOL = {
  name: 'board_status',
  description:
    "Tells the session board (the user's dashboard of Claude Code sessions) where this session stands. " +
    'Call it with status "done" once the task this session was started with is finished, such as a work item ' +
    'delivered, and nothing more will happen without the user: a queue of work items waits for it to start ' +
    'the next session in this repo. Call it with "working" if the user then gives you more to do. ' +
    'Not after every turn, and not for a step of a larger task.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'working'] },
      note: { type: 'string', description: 'One line: what was done, or what is left.' },
    },
    required: ['status'],
  },
}

// A board_status call; returns what the model reads back.
export function boardStatus(board: Board, input: Record<string, unknown>, now: number): string {
  const note = clip(str(input.note), 200)
  if (input.status === 'done') {
    board.done = { at: now, note }
    return 'Recorded: done. The board frees this session for the next queued work item once the turn ends.'
  }
  if (input.status === 'working') {
    board.done = null
    return 'Recorded: working.'
  }
  return 'status must be "done" or "working"; nothing recorded.'
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
    crons: [],
    shells: [],
    done: null,
  }
}
