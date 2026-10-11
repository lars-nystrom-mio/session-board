import type { EngineInterface, Register, Timer } from 'claude-code'
import {
  type AgentRec,
  type Board,
  type BoardEvent,
  type ToolRec,
  type Waiting,
  QUIET_TOOLS,
  addPrs,
  agentStatusOf,
  clip,
  deriveState,
  freshBoard,
  prLinksOf,
  pushEvent,
  scansForPrs,
  slashCommand,
  summarize,
  toolLabel,
  trimAgents,
  workItemOf,
} from './lib'

const HEARTBEAT_MS = 5_000
const SLOW_EVERY = 6 // heartbeats between usage/branch refreshes (30 s)
const WRITE_DELAY_MS = 250

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
const tools = new Map<string, ToolRec>()

const now = () => Date.now()

function event(kind: BoardEvent['kind'], text: string, agent?: string) {
  if (board) pushEvent(board, { t: now(), kind, text: clip(text, 200), agent })
}

function notePrs(text: string | undefined, agent?: string) {
  if (!board || !text) return
  const prs = prLinksOf(text)
  if (!addPrs(board, prs, now())) return
  for (const pr of prs) event('tool', `PR ${pr.repo} ${pr.host === 'github' ? '#' : '!'}${pr.number}`, agent)
}

function agentName(agentId?: string): string | undefined {
  if (!agentId || !board) return undefined
  return board.agents.find((a) => a.agentId === agentId)?.type ?? 'subagent'
}

async function boardDir($: EngineInterface): Promise<string> {
  const explicit = await $.env.get('SESSION_BOARD_DIR')
  if (explicit) return explicit.replace(/\\/g, '/')
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '~'
  return `${(config || `${home}/.claude`).replace(/\\/g, '/')}/board`
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
  await flush($)

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
    notePrs(text, agentName(from))
  } else if (text.trim()) {
    const slash = slashCommand(text)
    const shown = slash ? `/${slash.name} ${slash.args}`.trim() : text
    b.prompt = clip(shown, 600)
    b.promptAt = now()
    event('prompt', shown)
    if (slash) setSkill(slash.name, slash.args)
    notePrs(text)
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

function toolEnded($: EngineInterface, rec: ToolRec, tool: string, outcome: 'ok' | 'denied' | 'failed', output?: string) {
  tools.delete(rec.id)
  if (outcome === 'ok') notePrs(output, agentName(rec.agentId))
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
    let output: string | undefined
    try {
      const result = await next(e)
      outcome = result.deny !== undefined ? 'denied' : result.isError ? 'failed' : 'ok'
      if (outcome === 'ok' && scansForPrs(e.tool, e as unknown as Record<string, unknown>)) output = result.text
      return result
    } finally {
      toolEnded($, rec, e.tool, outcome, output)
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
