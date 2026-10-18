import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'
import {
  type AgentRec,
  type Board,
  type BoardEvent,
  type PrLookup,
  type PrRec,
  type ToolRec,
  type Waiting,
  QUIET_TOOLS,
  addPrs,
  adoPrLink,
  adoPrShowArgv,
  cacheTtlOf,
  agentStatusOf,
  clip,
  deriveState,
  freshBoard,
  memoryOf,
  parseProbe,
  prLinksOf,
  prsOfTool,
  projectDirName,
  pushEvent,
  scansForPrs,
  sessionTitleOf,
  slashCommand,
  summarize,
  toolLabel,
  trimAgents,
  workItemOf,
} from './lib'

const HEARTBEAT_MS = 5_000
const SLOW_EVERY = 6 // heartbeats between usage/branch refreshes (30 s)
const WRITE_DELAY_MS = 250
const MEMORY_EVERY = 12 // heartbeats between memory samples (60 s)
const MEMORY_MAX_FAILURES = 3 // then the session stops sampling (no PowerShell, not Windows)

// Lists the session's claude.exe and every process under it, with their memory,
// as JSON. ROOT is the claude.exe PID, or 0 to find it: the nearest claude.exe
// above this PowerShell. The probe leaves itself out. A child must be younger
// than its parent, so a reused PID never adopts an unrelated process. One line
// with single quotes only, since it goes through -Command.
const PROBE = [
  "$ErrorActionPreference = 'Stop'",
  '$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate)',
  '$by = @{}',
  '$kids = @{}',
  'foreach ($p in $all) { $id = [int]$p.ProcessId; $by[$id] = $p; $pp = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }; [void]$kids[$pp].Add($id) }',
  '$root = ROOT',
  "if ($root -eq 0 -and $by.ContainsKey($PID)) { $id = [int]$by[$PID].ParentProcessId; for ($i = 0; $i -lt 10 -and $by.ContainsKey($id); $i++) { if ($by[$id].Name -eq 'claude.exe') { $root = $id; break }; $id = [int]$by[$id].ParentProcessId } }",
  "if ($root -eq 0 -or -not $by.ContainsKey($root)) { '{}'; exit 0 }",
  '$ids = New-Object System.Collections.ArrayList',
  '$queue = New-Object System.Collections.Queue',
  '$queue.Enqueue($root)',
  'while ($queue.Count) { $id = $queue.Dequeue(); if ($id -eq $PID -or $ids.Contains($id)) { continue }; [void]$ids.Add($id); if ($kids.ContainsKey($id)) { foreach ($k in $kids[$id]) { if ($by[$k].CreationDate -ge $by[$id].CreationDate) { $queue.Enqueue($k) } } } }',
  '$mem = @{}',
  'foreach ($g in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $mem[$g.Id] = $g }',
  '$out = foreach ($id in $ids) { $p = $by[$id]; $g = $mem[$id]; if ($g) { $c = [string]$p.CommandLine; [pscustomobject]@{ pid = $id; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; cmd = $c.Substring(0, [Math]::Min(300, $c.Length)); mb = [Math]::Round($g.PrivateMemorySize64 / 1MB); wsMb = [Math]::Round($g.WorkingSet64 / 1MB) } } }',
  '[pscustomobject]@{ root = $root; procs = @($out) } | ConvertTo-Json -Compress -Depth 3',
].join('; ')

// Module state. A reload runs the module afresh, and init() picks the
// session's file back up.
let board: Board | null = null
let file = ''
let mainRunning = false
let mainTurnId: string | null = null
let skillSetThisTurn = false
let writeTimer: Timer | null = null
let heartbeat: Timer | null = null
let ticks = 0
let hasWarned = false
let transcriptPath = ''
let memoryPid = 0
let memoryFailures = 0
const tools = new Map<string, ToolRec>()

const now = () => Date.now()

function event(kind: BoardEvent['kind'], text: string, agent?: string) {
  if (board) pushEvent(board, { t: now(), kind, text: clip(text, 200), agent })
}

function notePrs(prs: Omit<PrRec, 'at'>[], agent?: string) {
  if (!board) return
  for (const pr of addPrs(board, prs, now())) event('tool', `PR ${pr.repo} ${pr.host === 'github' ? '#' : '!'}${pr.number}`, agent)
}

// PR ids being looked up or found this load, by org and id. A lookup that
// fails or finds nothing is dropped, so the next command can try again.
const lookedUp = new Set<string>()

// A PR that a command names only by number: which repo it is in comes from
// Azure DevOps, not from the session's remote (the command may have run in
// another repo). Nothing is recorded when the lookup fails.
async function resolvePr($: EngineInterface, lookup: PrLookup, agent?: string) {
  const key = `${lookup.org}#${lookup.id}`
  const argv = adoPrShowArgv(lookup)
  if (!argv || lookedUp.has(key)) return
  lookedUp.add(key)
  let pr: Omit<PrRec, 'at'> | null = null
  try {
    const run = await $.process.run(argv, { timeoutMs: 15_000 })
    pr = run.exitCode === 0 ? adoPrLink(run.stdout, lookup.id) : null
  } finally {
    if (!pr) lookedUp.delete(key)
  }
  if (!pr) return
  notePrs([pr], agent)
  schedule($)
}

function agentName(agentId?: string): string | undefined {
  if (!agentId || !board) return undefined
  return board.agents.find((a) => a.agentId === agentId)?.type ?? 'subagent'
}

async function claudeDir($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '~'
  return (config || `${home}/.claude`).replace(/\\/g, '/')
}

async function boardDir($: EngineInterface): Promise<string> {
  const explicit = await $.env.get('SESSION_BOARD_DIR')
  if (explicit) return explicit.replace(/\\/g, '/')
  return `${await claudeDir($)}/board`
}

async function flush($: EngineInterface) {
  if (!board || !file) return
  const state = deriveState(board, mainRunning)
  if (state !== board.state) {
    board.state = state
    board.stateSince = now()
  }
  board.tools = [...tools.values()]
  board.agents = trimAgents(board.agents)
  board.updatedAt = now()
  try {
    await $.fs.write(file, JSON.stringify(board, null, 1))
  } catch (err) {
    if (!hasWarned) {
      hasWarned = true
      $.ui.toast(`session-board: cannot write ${file}: ${String(err)}`)
    }
  }
}

// Coalesces bursts of changes into one write.
function schedule($: EngineInterface) {
  if (writeTimer) return
  writeTimer = $.clock.after(WRITE_DELAY_MS, () => {
    writeTimer = null
    void flush($)
  })
}

// The session's transcript. Hooks can't take its path from the classic events,
// as an organization's security plugin may bypass a plugin's classic hooks.
// Usually it's under the folder named after the cwd; else it's searched for.
async function findTranscript($: EngineInterface): Promise<string> {
  if (!board) return ''
  const projects = `${await claudeDir($)}/projects`
  const name = `${board.sessionId}.jsonl`
  const guess = `${projects}/${projectDirName(board.cwd)}/${name}`
  if (await $.fs.exists(guess)) return guess
  for (const dir of await $.fs.list(projects)) {
    const path = `${projects}/${dir.name}/${name}`
    if (dir.kind === 'dir' && (await $.fs.exists(path))) return path
  }
  return ''
}

// The title is in the transcript from the first turn on, and changes with
// /rename. Each response's usage there also says which TTL the cache got.
async function readTranscript($: EngineInterface) {
  if (!board) return
  try {
    transcriptPath ||= await findTranscript($)
    if (!transcriptPath) return
    const transcript = await $.fs.read(transcriptPath)
    if (!board) return
    const title = sessionTitleOf(transcript)
    if (title) board.tabTitle = title
    const ttl = cacheTtlOf(transcript)
    if (ttl && board.cache) board.cache.ttl = ttl
  } catch {}
}

// A main-thread request the prompt cache served or was written by. The cache
// entry's lifetime restarts when the request is sent, so `sent` is the start.
function cacheUsed($: EngineInterface, sent: number, usage: ModelUsage) {
  if (!board || usage.cache_read_input_tokens + usage.cache_creation_input_tokens === 0) return
  board.cache = { at: sent, ttl: board.cache?.ttl ?? null }
  schedule($)
}

async function refreshSlow($: EngineInterface) {
  if (!board) return
  try {
    const usage = await $.session.usage()
    board.context = {
      percent: usage.context.percent ?? null,
      tokens: usage.context.tokens ?? null,
      window: usage.context.window,
    }
    board.costUsd = usage.cost?.usd ?? null
  } catch {}
  try {
    const git = await $.process.run(['git', 'branch', '--show-current'], { cwd: board.cwd, timeoutMs: 5_000 })
    board.branch = git.exitCode === 0 ? git.stdout.trim() || null : null
  } catch {}
  try {
    board.model = await $.session.model()
  } catch {}
}

// The PID is found on the first sample of each load and passed in after that.
async function sampleMemory($: EngineInterface) {
  if (!board || memoryFailures >= MEMORY_MAX_FAILURES) return
  try {
    const script = PROBE.replace('$root = ROOT', `$root = ${memoryPid}`)
    const run = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20_000 })
    const probe = run.exitCode === 0 ? parseProbe(run.stdout) : null
    const memory = probe && board ? memoryOf(probe, now(), board.memory ?? null) : null
    if (!memory || !board) {
      memoryFailures++
      memoryPid = 0
      return
    }
    memoryFailures = 0
    memoryPid = memory.pid
    board.memory = memory
  } catch {
    memoryFailures++
  }
}

// The engine's own agent list catches completions no event reported.
async function syncAgents($: EngineInterface) {
  if (!board) return
  let infos
  try {
    infos = await $.agent.list()
  } catch {
    return
  }
  for (const info of infos) {
    const status = agentStatusOf(info.status)
    const known = board.agents.find((a) => a.agentId === info.id)
    if (known) {
      if (known.status !== status) {
        known.status = status
        if (status === 'done' || status === 'failed') known.endedAt ??= now()
      }
    } else if (status === 'running' || status === 'idle') {
      board.agents.push({
        key: info.id,
        agentId: info.id,
        type: info.type,
        description: clip(info.description, 120),
        status,
        since: now(),
      })
    }
  }
}

async function tick($: EngineInterface) {
  ticks++
  if (ticks % SLOW_EVERY === 0) await refreshSlow($)
  if (ticks % MEMORY_EVERY === 0) await sampleMemory($)
  if (board?.agents.some((a) => a.status === 'running' || a.status === 'idle')) await syncAgents($)
  await flush($)
}

// The served dashboard always matches the one this plugin ships.
async function copyDashboard($: EngineInterface, dir: string) {
  try {
    const source = await $.fs.read(`${$.plugin.root}/dashboard/index.html`)
    const target = `${dir}/index.html`
    const current = (await $.fs.exists(target)) ? await $.fs.read(target) : null
    if (current !== source) await $.fs.write(target, source)
  } catch {}
}

async function init($: EngineInterface, cwd: string, interactive: boolean, reason: string) {
  const dir = await boardDir($)
  const id = await $.session.id()
  file = `${dir}/sessions/${id}.json`

  // A reload of this module mid-session keeps what the file already says.
  let previous: Board | null = null
  try {
    if (await $.fs.exists(file)) previous = JSON.parse(await $.fs.read(file)) as Board
  } catch {}

  board = previous && previous.state !== 'ended' ? previous : freshBoard(id, cwd, now())
  board.cwd = cwd
  board.interactive = interactive
  board.tools = []
  board.prs ??= []
  board.tabTitle ??= null
  board.cache ??= null
  board.memory ??= null
  transcriptPath = ''
  memoryPid = 0
  memoryFailures = 0
  board.waiting = null
  if (board.state === 'running') board.state = 'idle'
  mainRunning = false
  tools.clear()
  try {
    const repo = await $.session.repo()
    board.repo = repo ? { name: repo.name, root: repo.root, remote: repo.remote } : null
  } catch {}
  event('session', previous && previous.state !== 'ended' ? 'board reloaded' : reason)

  await copyDashboard($, dir)
  await refreshSlow($)
  await readTranscript($)
  await flush($)
  void sampleMemory($).then(() => schedule($))

  heartbeat?.cancel()
  heartbeat = $.clock.every(HEARTBEAT_MS, () => void tick($))
}

async function ensure($: EngineInterface): Promise<Board | null> {
  if (board) return board
  try {
    // After /clear, session.end has run and no session.start follows.
    await init($, await $.session.cwd(), true, 'session cleared')
  } catch {}
  return board
}

function setWaiting($: EngineInterface, waiting: Waiting) {
  if (!board) return
  board.waiting = waiting
  event('waiting', `${waiting.kind}: ${waiting.detail}`)
  schedule($)
}

function setSkill(name: string, args: string) {
  if (!board || !name) return
  board.activeSkill = name
  if (!skillSetThisTurn || !board.skill) {
    board.skill = { name, args, at: now() }
    skillSetThisTurn = true
    board.workItem = workItemOf(args, true) ?? board.workItem
  }
  event('skill', `${name} ${args}`)
}

async function startSession($: EngineInterface, cwd: string, interactive: boolean) {
  try {
    await init($, cwd, interactive, 'session started')
  } catch {}
}

async function endSession($: EngineInterface, reason: string) {
  if (!board) return
  heartbeat?.cancel()
  heartbeat = null
  writeTimer?.cancel()
  writeTimer = null
  mainRunning = false
  board.state = 'ended'
  board.endReason = reason
  board.waiting = null
  for (const a of board.agents) if (a.status === 'running' || a.status === 'idle') a.status = 'done'
  tools.clear()
  event('session', `ended (${reason})`)
  await flush($)
  board = null
}

async function turnStarted($: EngineInterface, text: string) {
  const b = await ensure($)
  if (!b) return
  mainRunning = true
  mainTurnId = null
  skillSetThisTurn = false
  b.turns++
  b.waiting = null
  const handback = /^\s*<(agent-message|task-notification)[\s>]/.test(text)
  if (handback) {
    // A subagent reporting back, not the person: keep the prompt as it was.
    const from = text.match(/^\s*<[^>]*\sfrom="([^"]*)"/)?.[1]
    event('agent', `report from ${agentName(from) ?? 'a subagent'}`)
    notePrs(prLinksOf(text), agentName(from))
  } else if (text.trim()) {
    const slash = slashCommand(text)
    const shown = slash ? `/${slash.name} ${slash.args}`.trim() : text
    b.prompt = clip(shown, 600)
    b.promptAt = now()
    event('prompt', shown)
    if (slash) setSkill(slash.name, slash.args)
    notePrs(prLinksOf(text))
    b.workItem = workItemOf(shown, false) ?? b.workItem
  }
  schedule($)
}

type TurnEnd = { agentId?: string; turnId: string; isAborted: boolean; reason: string; durationMs: number }

async function turnCompleted($: EngineInterface, e: TurnEnd) {
  if (!board) return
  const secs = Math.round(e.durationMs / 1000)
  if (e.agentId) {
    const agent = board.agents.find((a) => a.agentId === e.agentId)
    if (agent) {
      agent.status = e.isAborted || e.reason === 'error' ? 'failed' : 'done'
      agent.endedAt = now()
      event('agent', `${agent.type} ${agent.status === 'done' ? 'finished' : 'stopped'} (${secs}s)`)
    }
  } else if (!mainTurnId || e.turnId === mainTurnId) {
    mainRunning = false
    board.waiting = null
    event('turn', e.isAborted ? 'interrupted' : `turn done in ${secs}s`)
    await refreshSlow($)
    await readTranscript($)
  }
  schedule($)
}

function agentSpawned($: EngineInterface, rec: AgentRec) {
  if (!board) return
  board.agents = board.agents.filter((a) => a.key !== rec.key)
  board.agents.push(rec)
  event('agent', `${rec.type} started: ${rec.description}`)
  schedule($)
}

// Records a tool call as it starts; returns its id for toolEnded.
async function toolStarted($: EngineInterface, tool: string, input: Record<string, unknown>, toolUseId: string | undefined, agentId: string | undefined) {
  const b = await ensure($)
  if (!b) return null
  const id = toolUseId || `${tool}:${now()}:${Math.random()}`
  const rec: ToolRec = { id, tool: toolLabel(tool), summary: summarize(tool, input), agentId, since: now() }
  tools.set(id, rec)

  if (agentId) {
    const agent = b.agents.find((a) => a.agentId === agentId)
    if (agent) {
      agent.lastTool = rec.summary ? `${rec.tool} · ${rec.summary}` : rec.tool
      if (agent.status === 'idle') agent.status = 'running'
    }
  }
  if (tool === 'Skill' && !agentId) setSkill(String(input.skill ?? ''), String(input.args ?? ''))
  if (tool === 'AskUserQuestion') setWaiting($, { kind: 'question', detail: rec.summary, tool, since: now() })
  if (tool === 'ExitPlanMode') setWaiting($, { kind: 'plan', detail: 'plan ready for approval', tool, since: now() })
  if (!QUIET_TOOLS.has(tool) && tool !== 'Skill' && tool !== 'Agent') {
    event('tool', rec.summary ? `${rec.tool} · ${rec.summary}` : rec.tool, agentName(agentId))
  }
  schedule($)
  return rec
}

function toolEnded($: EngineInterface, rec: ToolRec, tool: string, outcome: 'ok' | 'denied' | 'failed', prs: Omit<PrRec, 'at'>[]) {
  tools.delete(rec.id)
  notePrs(prs, agentName(rec.agentId))
  if (outcome === 'denied') event('error', `${rec.tool} denied`, agentName(rec.agentId))
  if (outcome === 'failed') event('error', `${rec.tool} failed${rec.summary ? `: ${rec.summary}` : ''}`, agentName(rec.agentId))
  if (board?.waiting && (board.waiting.tool === tool || board.waiting.kind === 'notification')) board.waiting = null
  schedule($)
}

function permissionAsked($: EngineInterface, toolName: string, toolInput: unknown) {
  if (!board) return
  const detail = summarize(toolName, (toolInput ?? {}) as Record<string, unknown>)
  setWaiting($, {
    kind: 'permission',
    detail: detail ? `${toolLabel(toolName)} · ${detail}` : toolLabel(toolName),
    tool: toolName,
    since: now(),
  })
}

function notified($: EngineInterface, type: string, message: string) {
  if (board && type === 'permission_prompt' && !board.waiting) {
    setWaiting($, { kind: 'notification', detail: clip(message, 160), since: now() })
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await startSession($, e.cwd, e.isInteractive)
    return result
  })

  on('session.end', async ($, e, next) => {
    await endSession($, e.reason)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await turnStarted($, e.text)
    const result = await next(e)
    mainTurnId = result.turnId
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await turnCompleted($, e)
    return next(e)
  })

  // A model request; it streams, so the hook forwards the chunks as they come.
  on('turn.step', async function* ($, e, next) {
    const sent = now()
    const result = yield* next(e)
    try {
      if (!e.agentId && result.usage) cacheUsed($, sent, result.usage)
    } catch {}
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e) // the board only observes: on failure the request goes on
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      agentSpawned($, {
        key: result.agentId ?? e.tool_use_id,
        agentId: result.agentId,
        type: e.subagentType,
        description: clip(e.description, 120),
        status: 'running',
        since: now(),
      })
    }
    return result
  }).catch(($, e, next) => next(e)) // the board only observes: on failure the call goes on

  on('tool.call', async ($, e, next) => {
    const rec = await toolStarted($, e.tool, e as unknown as Record<string, unknown>, e.tool_use_id, e.agentId)
    if (!rec) return next(e)
    let outcome: 'ok' | 'denied' | 'failed' = 'failed'
    let prs: Omit<PrRec, 'at'>[] = []
    try {
      const result = await next(e)
      outcome = result.deny !== undefined ? 'denied' : result.isError ? 'failed' : 'ok'
      const input = e as unknown as Record<string, unknown>
      if (outcome === 'ok' && scansForPrs(e.tool, input)) {
        const found = prsOfTool(e.tool, input, result.text ?? '', board?.repo?.remote ?? null)
        prs = found.prs
        // Fire and forget: the lookup never holds up the tool call.
        if (found.lookup) void resolvePr($, found.lookup, agentName(e.agentId)).catch(() => {})
      }
      return result
    } finally {
      toolEnded($, rec, e.tool, outcome, prs)
    }
  }).catch(($, e, next) => next(e)) // the board only observes: on failure the call goes on

  // The permission dialog is about to ask the person.
  on('classic.PermissionRequest', async ($, e, next) => {
    permissionAsked($, e.tool_name, e.tool_input)
    return next(e)
  }).catch(($, e, next) => next(e)) // the board only observes: on failure the call goes on

  on('classic.Notification', async ($, e, next) => {
    notified($, e.notification_type, e.message)
    return next(e)
  }).catch(($, e, next) => next(e)) // the board only observes: on failure the call goes on
}
