import { describe, expect, test } from 'claude-code/testing'
import { addPrs, adoOrgOf, adoPrLink, adoPrLookupOf, cacheTtlOf, childLabel, deriveState, freshBoard, memoryOf, parseProbe, prLinksOf, prsOfTool, pushEvent, projectDirName, scansForPrs, sessionTitleOf, slashCommand, summarize, toolLabel, trimAgents, workItemOf, MAX_AGENTS, MAX_EVENTS, MEMORY_HISTORY, type ProcRec } from './lib'

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
    board.waiting = { kind: 'permission', detail: 'Bash', since: 0 }
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
})
