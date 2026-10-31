import { describe, expect, test } from 'claude-code/testing'
import { boardStatus, pruneShells, shellReported, shellToolDone, SHELL_MAX_MS, addPrs, adoOrgOf, cronFired, cronToolDone, nextCronMatch, pruneCrons, CRON_EXPIRY_MS, WAKEUP_ID, adoPrLink, adoPrLookupOf, adoPrShowArgv, adoRepoOf, cacheTtlOf, childLabel, deriveState, freshBoard, memoryOf, parseMachine, parseProbe, prLinksOf, prsOfTool, pushEvent, projectDirName, scansForPrs, sessionTitleOf, slashCommand, summarize, toolLabel, trimAgents, workItemOf, MAX_AGENTS, MAX_EVENTS, MEMORY_HISTORY, type ProcRec } from './lib'

describe('summaries', () => {
  test('a tool call becomes one short line', async () => {
    expect(summarize('Bash', { command: 'npm   test\n --watch=false' })).toBe('npm test --watch=false')
    expect(summarize('Edit', { file_path: 'C:\\repo\\src\\app.ts' })).toBe('app.ts')
    expect(summarize('Agent', { subagent_type: 'code-writer', description: 'Implement story' })).toBe('code-writer: Implement story')
    expect(summarize('Skill', { skill: 'deliver-story', args: '1234' })).toBe('deliver-story 1234')
    expect(toolLabel('mcp__claude_ai_Slack__slack_send_message')).toBe('Slack · slack_send_message')
  })

  test('slash commands and work items are recognised', async () => {
    expect(slashCommand('/deliver-story 1234, use low review')).toEqual({ name: 'deliver-story', args: '1234, use low review' })
    expect(slashCommand('deliver 1234')).toBe(null)
    expect(slashCommand('<command-message>log-check</command-message>\n<command-name>/log-check</command-name>\n<command-args>yesterday</command-args>'))
      .toEqual({ name: 'log-check', args: 'yesterday' })
    expect(slashCommand('<command-message>log-check</command-message> is running…')).toEqual({ name: 'log-check', args: '' })
    expect(workItemOf('continue on #1234', false)).toBe('1234')
    expect(workItemOf('deliver 1234', false)).toBe(null)
    expect(workItemOf('1234, use autocomplete', true)).toBe('1234')
  })
})

describe('pull requests', () => {
  test('PR links are found in GitHub and Azure DevOps output', async () => {
    expect(prLinksOf('Created https://github.com/acme/app/pull/42.')).toEqual([
      { url: 'https://github.com/acme/app/pull/42', repo: 'app', number: 42, host: 'github' },
    ])
    expect(prLinksOf('see https://dev.azure.com/org/My%20Proj/_git/Api/pullrequest/123?_a=files')[0])
      .toEqual({ url: 'https://dev.azure.com/org/My%20Proj/_git/Api/pullrequest/123', repo: 'Api', number: 123, host: 'ado' })
    expect(prLinksOf('https://org.visualstudio.com/P/_git/Repo/pullrequest/7')[0]?.number).toBe(7)
    expect(prLinksOf('https://github.com/acme/app/pull/new/my-branch')).toEqual([])
  })

  test('az repos pr JSON becomes a link', async () => {
    const json = JSON.stringify({ pullRequestId: 55, repository: { webUrl: 'https://dev.azure.com/org/P/_git/Repo' } }, null, 2)
    expect(prLinksOf(json)).toEqual([{ url: 'https://dev.azure.com/org/P/_git/Repo/pullrequest/55', repo: 'Repo', number: 55, host: 'ado' }])
  })

  test('listings are ignored and duplicates kept once', async () => {
    const many = [1, 2, 3, 4].map((n) => `https://github.com/a/b/pull/${n}`).join(' ')
    expect(prLinksOf(many)).toEqual([])
    expect(scansForPrs('Bash', { command: 'az repos pr list' })).toBe(false)
    expect(scansForPrs('Bash', { command: 'gh pr create --fill' })).toBe(true)
    expect(scansForPrs('Bash', { command: 'gh pr list --state open' })).toBe(false)
    // A PR body written in the same command mentions "pr list" in prose.
    expect(scansForPrs('Bash', { command: "cat > body.md <<'EOF'\nSkipped for `pr list`.\nEOF\ngh pr create --body-file body.md" })).toBe(true)
    expect(scansForPrs('Read', {})).toBe(false)
    const board = freshBoard('s1', '/x', 0)
    expect(addPrs(board, prLinksOf('https://github.com/a/b/pull/1'), 1).length).toBe(1)
    expect(addPrs(board, prLinksOf('https://github.com/A/B/pull/1/files'), 2)).toEqual([])
    expect(board.prs.length).toBe(1)
  })
})

describe('pull requests by number', () => {
  const remote = 'https://dev.azure.com/mioit/Mio.M3/_git/Mio.M3.Sales'
  const org = 'https://dev.azure.com/mioit'
  const vessel = 'https://dev.azure.com/mioit/Mio.SupplyChain/_git/Mio.SupplyChainFulfilment.VesselTracking'

  test('an az repos pr command names its PR by id and org, never by repo', async () => {
    const command = 'wc -c .claude/pr-body.md && az repos pr update --organization https://dev.azure.com/mioit --id 36067 --description "a --org other --id 5" --query pullRequestId -o tsv; rm -r .claude/pr-body.md'
    expect(adoPrLookupOf(command, '2696 .claude/pr-body.md\n36067', remote)).toEqual({ id: 36067, org })
    expect(adoPrLookupOf('az repos pr create --title x --query pullRequestId -o tsv', '36067', 'https://user@dev.azure.com/mioit/Mio.M3/_git/Mio.M3.Sales')).toEqual({ id: 36067, org })
    // The issue's case: another repo's PR, run with the session repo's remote at hand.
    expect(adoPrLookupOf('az repos pr update --org https://dev.azure.com/mioit --id 36319 --status completed', '', vessel)).toEqual({ id: 36319, org })
  })

  test('the organization is the same whichever way it is spelled', async () => {
    const id = (flag: string, r: string | null) => adoPrLookupOf(`az repos pr show --id 7 ${flag}`, '', r)
    const expected = { id: 7, org }
    expect(id('--org mioit', vessel)).toEqual(expected)
    expect(id('--org https://mioit.visualstudio.com/', vessel)).toEqual(expected)
    expect(id('--organization=https://MioIT@dev.azure.com/mioit', null)).toEqual(expected)
    expect(id('', 'https://mioit.visualstudio.com/Mio.M3/_git/Mio.M3.Sales')).toEqual(expected)
    expect(id('--org other', vessel)).toEqual({ id: 7, org: 'https://dev.azure.com/other' })
    expect(adoOrgOf('not an org')).toBe(null)
  })

  test('nothing to look up without an org, an id, or for a listing', async () => {
    expect(adoPrLookupOf('az repos pr update --id 1', '', null)).toBe(null)
    expect(adoPrLookupOf('az repos pr update --id 1', '', 'https://github.com/a/b.git')).toBe(null)
    expect(adoPrLookupOf('az repos pr update --id 1 --org "my org"', '', remote)).toBe(null)
    expect(adoPrLookupOf('az repos pr list --status active', '36067', remote)).toBe(null)
    expect(adoPrLookupOf('az repos pr show --repository x', '', remote)).toBe(null)
    expect(adoPrLookupOf('git push', '36067', remote)).toBe(null)
  })

  test('a hostile --org yields no lookup and nothing reaches the script', async () => {
    for (const org of [`https://dev.azure.com/x'$(calc)'`, `'x$(calc)'`, 'x`calc`', 'https://dev.azure.com/x%27', `https://x'.visualstudio.com`]) {
      expect(adoPrLookupOf(`az repos pr show --id 1 --org ${org}`, '', vessel)).toBe(null)
    }
    expect(adoPrLookupOf('az repos pr show --id 1 --org x;calc', '', vessel)).toEqual({ id: 1, org: 'https://dev.azure.com/x' })
    expect(adoRepoOf(`https://dev.azure.com/x'$(calc)'/p/_git/r`)).toBe(null)
    expect(adoPrShowArgv({ id: 1, org: `https://dev.azure.com/x'$(calc)'` })).toBe(null)
    expect(adoPrShowArgv({ id: 1.5, org })).toBe(null)
    expect(adoPrShowArgv({ id: 36319, org })?.at(-1)).toBe(`az repos pr show --id 36319 --org '${org}' --query repository.webUrl -o tsv`)
  })

  test('the link comes from the repo az reports', async () => {
    expect(adoPrLink('https://dev.azure.com/mioit/OnPremOps/_git/OnPremOps\n', 36319)).toEqual({
      url: 'https://dev.azure.com/mioit/OnPremOps/_git/OnPremOps/pullrequest/36319',
      repo: 'OnPremOps',
      number: 36319,
      host: 'ado',
    })
    expect(adoPrLink('', 1)).toBe(null)
    expect(adoPrLink('ERROR: not logged in', 1)).toBe(null)
  })

  test('a link in the output wins: no lookup', async () => {
    const real = 'https://dev.azure.com/mioit/OnPremOps/_git/OnPremOps'
    const output = `2745 pr-body.md\n${JSON.stringify({ pullRequestId: 36319, repository: { webUrl: real } }, null, 2)}`
    const command = { command: 'az repos pr show --id 36319' }
    const found = prsOfTool('Bash', command, output, vessel)
    expect(found.prs.map((p) => p.url)).toEqual([`${real}/pullrequest/36319`])
    expect(found.lookup).toBe(null)
    expect(addPrs(freshBoard('s1', '/x', 0), found.prs, 1).length).toBe(1)
    // Output that names no PR leaves the lookup.
    expect(prsOfTool('Bash', command, '', vessel)).toEqual({ prs: [], lookup: { id: 36319, org } })
    expect(prsOfTool('Read', command, '', vessel).lookup).toBe(null)
  })
})

describe('terminal tab title', () => {
  test('the last generated title, unless the session was renamed', async () => {
    const ai = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 's1' })
    const lines = [JSON.stringify({ type: 'user', message: { content: 'hi "-title" here' } }), ai('First'), '{broken', ai('Terminal tab name on card')]
    expect(sessionTitleOf(lines.join('\n'))).toBe('Terminal tab name on card')
    expect(sessionTitleOf([JSON.stringify({ type: 'custom-title', customTitle: 'my tab' }), ...lines].join('\n'))).toBe('my tab')
    expect(sessionTitleOf(JSON.stringify({ type: 'user' }))).toBe(null)
  })

  test('the transcript folder is named after the cwd', async () => {
    expect(projectDirName('C:\\Users\\me\\.claude')).toBe('C--Users-me--claude')
    expect(projectDirName('C:\\Workspace\\session-board')).toBe('C--Workspace-session-board')
  })
})

describe('board', () => {
  test('state follows what the session is doing', async () => {
    const board = freshBoard('s1', 'C:/code/app', 0)
    expect(board.project).toBe('app')
    expect(deriveState(board, false)).toBe('idle')
    expect(deriveState(board, true)).toBe('running')
    board.agents.push({ key: 'a', type: 'ci-watcher', description: '', status: 'running', since: 0 })
    expect(deriveState(board, false)).toBe('background')
    board.waiting = { kind: 'question', detail: 'Which branch?', since: 0 }
    expect(deriveState(board, true)).toBe('waiting')
  })

  test('events and finished agents are capped, running agents kept', async () => {
    const board = freshBoard('s1', '/x', 0)
    for (let i = 0; i < MAX_EVENTS + 5; i++) pushEvent(board, { t: i, kind: 'tool', text: String(i) })
    expect(board.events.length).toBe(MAX_EVENTS)
    expect(board.events[0]?.text).toBe('5')

    const agents = Array.from({ length: MAX_AGENTS + 3 }, (_, i) => ({
      key: String(i), type: 't', description: '', since: i,
      status: (i === 0 ? 'running' : 'done') as 'running' | 'done',
    }))
    const kept = trimAgents(agents)
    expect(kept.length).toBe(MAX_AGENTS)
    expect(kept[0]?.status).toBe('running')
  })
})

test('the board answers its own board_status tool', async ($) => {
  const result = await $.tool.call({ tool: 'mcp__session-board__board_status', status: 'done', note: 'merged' })
  expect(result.deny).toBe(undefined)
  // The kit has no session to start the board in; the tool still answers.
  expect(String(result.result)).toMatch(/^Recorded: done|nothing recorded/)
})

test('the board never gets in the way of a tool call', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'hi' }))
  const result = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(result.deny).toBe(undefined)
  expect(result.result).toBe('hi')
})

describe('prompt cache', () => {
  test('the TTL of the main thread newest cache write', async () => {
    const reply = (h1: number, m5: number, isSidechain = false) =>
      JSON.stringify({ type: 'assistant', isSidechain, message: { usage: { cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } } } })
    expect(cacheTtlOf([reply(0, 900), reply(744, 0)].join('\n'))).toBe('1h')
    expect(cacheTtlOf([reply(744, 0), reply(0, 900)].join('\n'))).toBe('5m')
    expect(cacheTtlOf([reply(0, 900), reply(0, 0), reply(744, 0, true)].join('\n'))).toBe('5m')
    expect(cacheTtlOf(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBe(null)
  })
})

describe('memory', () => {
  const proc = (pid: number, ppid: number, name: string, mb: number, cmd = name): ProcRec => ({ pid, ppid, name, cmd, mb, wsMb: mb })
  // As the probe saw a real session: an Azure MCP server behind cmd and npx, a
  // stdio MCP server, and a Bash tool call that was running.
  const procs = [
    proc(100, 1, 'claude.exe', 700),
    proc(200, 100, 'cmd.exe', 8, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"@azure/mcp@latest^" ^"server^" ^"start^""'),
    proc(300, 100, 'SecondBrainMcp.exe', 18),
    proc(400, 100, 'bash.exe', 2),
    proc(201, 200, 'node.exe', 78, '"C:\\Program Files\\nodejs\\\\node.exe"  "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npx-cli.js" "-y" "@azure/mcp@latest" "server" "start"'),
    proc(202, 201, 'azmcp.exe', 28),
    proc(301, 300, 'conhost.exe', 1),
    proc(401, 400, 'node.exe', 18),
  ]

  test('child trees are named after what they run', async () => {
    expect(childLabel(procs.filter((p) => [200, 201, 202].includes(p.pid)))).toBe('@azure/mcp')
    expect(childLabel([proc(1, 0, 'node.exe', 1, '"node" "C:\\npm\\npx-cli.js" "-y" "mcp-remote" "https://kanban.example.com/api/mcp"')])).toBe('mcp-remote kanban.example.com')
    expect(childLabel([proc(1, 0, 'conhost.exe', 1), proc(2, 1, 'SecondBrainMcp.exe', 1)])).toBe('SecondBrainMcp')
    expect(childLabel([proc(1, 0, 'bash.exe', 1), proc(2, 1, 'node.exe', 1)])).toBe('shell commands')
  })

  test('a sample groups processes by the direct child of claude.exe', async () => {
    const memory = memoryOf({ root: 100, procs }, 1000, null)
    expect(memory?.mb).toBe(700)
    expect(memory?.childMb).toBe(153)
    expect(memory?.children.map((c) => `${c.label} ${c.mb} ${c.procs}`)).toEqual(['@azure/mcp 114 3', 'shell commands 20 2', 'SecondBrainMcp 19 2'])
    expect(memory?.history).toEqual([[1000, 700]])
    expect(memoryOf({ root: 999, procs }, 1000, null)).toBe(null)
  })

  test('the history grows per sample, is capped, and restarts with a new PID', async () => {
    let memory = memoryOf({ root: 100, procs }, 0, null)
    for (let i = 1; i <= MEMORY_HISTORY + 5; i++) memory = memoryOf({ root: 100, procs }, i, memory)
    expect(memory?.history.length).toBe(MEMORY_HISTORY)
    expect(memory?.history.at(-1)).toEqual([MEMORY_HISTORY + 5, 700])
    const moved = memoryOf({ root: 500, procs: [proc(500, 1, 'claude.exe', 600)] }, 9, memory)
    expect(moved?.history).toEqual([[9, 600]])
  })

  test('probe output with one process, nothing found, or noise', async () => {
    expect(parseProbe('{"root":5,"procs":{"pid":5,"ppid":1,"name":"claude.exe","cmd":"","mb":1,"wsMb":1}}\r\n')?.procs.length).toBe(1)
    expect(parseProbe('{}')).toBe(null)
    expect(parseProbe('Get-CimInstance : access denied')).toBe(null)
  })

  test('machine totals come with or without a claude.exe', async () => {
    const machine = '"machine":{"ramTotalMb":32000,"ramFreeMb":8000,"commitLimitMb":40000,"commitFreeMb":10000}'
    const want = { at: 7, ramMb: 24000, ramTotalMb: 32000, commitMb: 30000, commitLimitMb: 40000 }
    expect(parseMachine(`{${machine}}`, 7)).toEqual(want)
    expect(parseMachine(`{"root":5,"procs":[],${machine}}\r\n`, 7)).toEqual(want)
    expect(parseProbe(`{${machine}}`)).toBe(null)
    expect(parseMachine('{}', 7)).toBe(null)
    expect(parseMachine('{"machine":{"ramTotalMb":0,"ramFreeMb":0,"commitLimitMb":1,"commitFreeMb":0}}', 7)).toBe(null)
    expect(parseMachine('{"machine":{"ramTotalMb":8,"ramFreeMb":9,"commitLimitMb":9,"commitFreeMb":0}}', 7)).toBe(null)
    expect(parseMachine('access denied', 7)).toBe(null)
  })
})

describe('scheduled jobs', () => {
  // Local time, as the scheduler reads cron expressions.
  const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 9, d, h, m, s).getTime()

  test('the next match of a cron expression', async () => {
    expect(nextCronMatch('7 7-19 23 10 *', at(23, 0, 32))).toBe(at(23, 7, 7))
    expect(nextCronMatch('7 7-19 23 10 *', at(23, 7, 7))).toBe(at(23, 8, 7))
    expect(nextCronMatch('7 7-19 23 10 *', at(23, 19, 7))).toBe(new Date(2027, 9, 23, 7, 7).getTime())
    expect(nextCronMatch('0 0 30 2 *', 0)).toBe(null) // never matches
    expect(nextCronMatch('*/15 * * * *', at(23, 10, 1))).toBe(at(23, 10, 15))
    expect(nextCronMatch('0 9 * * 1-5', at(23, 10, 0))).toBe(at(26, 9, 0)) // Fri 23 Oct -> Mon 26
    expect(nextCronMatch('30 14 28 2 *', at(23, 0, 0))).toBe(new Date(2027, 1, 28, 14, 30).getTime())
    expect(nextCronMatch('0 0 1 * 0', at(23, 0, 0))).toBe(at(25, 0, 0)) // day of month or Sunday
    expect(nextCronMatch('bad', 0)).toBe(null)
    expect(nextCronMatch('61 * * * *', 0)).toBe(null)
  })

  test('CronCreate, CronList and CronDelete keep the board in step', async () => {
    const board = freshBoard('s1', '/x', 0)
    const created = at(23, 0, 32)
    const line = cronToolDone(board, 'CronCreate', { cron: '7 7-19 23 10 *', prompt: '/drift-day hourly', recurring: true },
      { id: 'a4bc5d55', humanSchedule: 'at :07 from 7 to 19 on Oct 23', recurring: true, nextFireAt: at(23, 7, 7, 20) }, created)
    expect(line).toBe('scheduled at :07 from 7 to 19 on Oct 23')
    expect(board.crons?.[0]).toMatchObject({ id: 'a4bc5d55', nextAt: at(23, 7, 7, 20), offsetMs: 20_000, recurring: true, createdAt: created })

    cronToolDone(board, 'CronCreate', { cron: '13 20 23 10 *', prompt: '/drift-day summary', recurring: false },
      { id: 'b1', humanSchedule: 'Oct 23 20:13', recurring: false, nextFireAt: at(23, 20, 13) }, created)
    expect(board.crons?.length).toBe(2)

    // A listing replaces the jobs and keeps what only the board knew.
    cronToolDone(board, 'CronList', {}, { jobs: [{ id: 'a4bc5d55', cron: '7 7-19 23 10 *', humanSchedule: 'hourly', prompt: '/drift-day hourly', nextFireAt: at(23, 7, 7, 20) }] }, at(23, 1, 0))
    expect(board.crons?.map((c) => c.id)).toEqual(['a4bc5d55'])
    expect(board.crons?.[0]?.createdAt).toBe(created)

    expect(cronToolDone(board, 'CronDelete', { id: 'a4bc5d55' }, { id: 'a4bc5d55' }, at(23, 2, 0))).toBe('unscheduled a4bc5d55')
    expect(board.crons).toEqual([])
    expect(cronToolDone(board, 'Bash', {}, {}, 0)).toBe(null)
  })

  test('the offset is measured from the match it shifted, even past the next one', async () => {
    const board = freshBoard('s1', '/x', 0)
    // Created at 09:45 for 09:30 daily, shifted half an hour: today's match fires at 10:00.
    cronToolDone(board, 'CronCreate', { cron: '30 9 * * *', prompt: 'hello' }, { id: 'd', recurring: true, nextFireAt: at(23, 10, 0) }, at(23, 9, 45))
    expect(board.crons?.[0]).toMatchObject({ nextAt: at(23, 10, 0), offsetMs: 30 * 60_000 })
    cronFired(board, 'hello', at(23, 10, 0, 1))
    expect(board.crons?.[0]?.nextAt).toBe(at(24, 10, 0))
  })

  test('a firing moves a recurring job on and drops a one-shot', async () => {
    const board = freshBoard('s1', '/x', 0)
    cronToolDone(board, 'CronCreate', { cron: '7 7-19 23 10 *', prompt: '/drift-day hourly' }, { id: 'h', recurring: true, nextFireAt: at(23, 7, 7, 20) }, at(23, 0, 32))
    cronToolDone(board, 'CronCreate', { cron: '13 20 23 10 *', prompt: '/drift-day summary', recurring: false }, { id: 'o', recurring: false, nextFireAt: at(23, 20, 13) }, at(23, 0, 32))

    expect(cronFired(board, 'something else', at(23, 7, 7, 21))).toBe(null)
    expect(cronFired(board, '/drift-day hourly', at(23, 7, 7, 21))?.id).toBe('h')
    expect(board.crons?.find((c) => c.id === 'h')?.nextAt).toBe(at(23, 8, 7, 20))
    expect(cronFired(board, '/drift-day hourly', at(23, 19, 7, 21))?.id).toBe('h')
    expect(board.crons?.find((c) => c.id === 'h')?.nextAt).toBe(new Date(2027, 9, 23, 7, 7, 20).getTime())

    expect(cronFired(board, '/drift-day summary', at(23, 20, 13, 1))?.id).toBe('o')
    expect(board.crons?.map((c) => c.id)).toEqual(['h'])
  })

  test('a wakeup fires once, whatever its prompt', async () => {
    const board = freshBoard('s1', '/x', 0)
    cronToolDone(board, 'ScheduleWakeup', { delaySeconds: 1200, prompt: '<<autonomous-loop-dynamic>>' }, { scheduledFor: at(23, 10, 20) }, at(23, 10, 0))
    expect(board.crons?.[0]).toMatchObject({ id: WAKEUP_ID, prompt: '/loop (autonomous)', nextAt: at(23, 10, 20) })
    expect(cronFired(board, 'a prompt typed earlier', at(23, 10, 5))).toBe(null)
    expect(cronFired(board, 'the loop instructions', at(23, 10, 20, 1))?.id).toBe(WAKEUP_ID)
    expect(board.crons).toEqual([])

    cronToolDone(board, 'ScheduleWakeup', { delaySeconds: 60, prompt: 'x' }, { scheduledFor: at(23, 11, 0) }, at(23, 10, 59))
    cronToolDone(board, 'ScheduleWakeup', {}, { scheduledFor: 0, stopped: true }, at(23, 10, 59))
    expect(board.crons).toEqual([])
  })

  test('jobs the scheduler dropped leave the board', async () => {
    const board = freshBoard('s1', '/x', 0)
    const created = at(1, 9, 0)
    cronToolDone(board, 'CronCreate', { cron: '0 * * * *', prompt: 'hourly' }, { id: 'h', recurring: true, nextFireAt: at(1, 10, 0) }, created)
    cronToolDone(board, 'CronCreate', { cron: '0 12 1 10 *', prompt: 'once', recurring: false }, { id: 'o', recurring: false, nextFireAt: at(1, 12, 0) }, created)

    // A firing the board didn't see moves the job on.
    pruneCrons(board, at(1, 12, 30))
    expect(board.crons?.find((c) => c.id === 'h')?.nextAt).toBe(at(1, 13, 0))
    expect(board.crons?.length).toBe(2)
    pruneCrons(board, at(1, 13, 1))
    expect(board.crons?.map((c) => c.id)).toEqual(['h'])
    pruneCrons(board, created + CRON_EXPIRY_MS)
    expect(board.crons).toEqual([])
  })
})

describe('background tasks', () => {
  test('a background shell is kept until its notification names it', async () => {
    const board = freshBoard('s1', '/x', 0)
    expect(shellToolDone(board, 'Bash', { command: 'ado-watch.sh 123' }, { stdout: '', backgroundTaskId: 'b1' }, 'toolu_1', 10)).toBe('in background: ado-watch.sh 123')
    expect(shellToolDone(board, 'Bash', { command: 'ls' }, { stdout: 'a' }, 'toolu_2', 10)).toBe(null)
    expect(shellToolDone(board, 'Monitor', { description: 'watch' }, { taskId: 'm1', timeoutMs: 60_000 }, 'toolu_3', 10)).toBe('in background: watch')
    expect(board.shells?.map((s) => [s.id, s.until])).toEqual([['b1', 10 + SHELL_MAX_MS], ['m1', 60_010]])
    expect(shellReported(board, '<task-notification>\n<task-id>other</task-id>\n<tool-use-id>toolu_1</tool-use-id>')?.id).toBe('b1')
    expect(shellReported(board, '<task-notification>\n<task-id>nope</task-id>')).toBe(null)
    expect(shellToolDone(board, 'TaskStop', { task_id: 'm1' }, { message: '', task_id: 'm1', task_type: 'monitor' }, 'toolu_4', 20)).toBe('stopped m1')
    expect(board.shells).toEqual([])
  })

  test('a shell never heard from is dropped in the end', async () => {
    const board = freshBoard('s1', '/x', 0)
    shellToolDone(board, 'PowerShell', { command: 'sleep' }, { backgroundTaskId: 'p1' }, 't', 0)
    pruneShells(board, SHELL_MAX_MS - 1)
    expect(board.shells?.length).toBe(1)
    pruneShells(board, SHELL_MAX_MS)
    expect(board.shells?.length).toBe(0)
  })
})

describe('board_status', () => {
  test('done and working set and clear the flag', async () => {
    const board = freshBoard('s1', '/x', 0)
    boardStatus(board, { status: 'done', note: 'PR !12 merged' }, 5)
    expect(board.done).toEqual({ at: 5, note: 'PR !12 merged' })
    expect(boardStatus(board, { status: 'maybe' }, 6)).toMatch(/nothing recorded/)
    expect(board.done?.at).toBe(5)
    boardStatus(board, { status: 'working' }, 7)
    expect(board.done).toBe(null)
  })
})
