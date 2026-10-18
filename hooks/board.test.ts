import { describe, expect, test } from 'claude-code/testing'
import { addPrs, adoPrOfCommand, cacheTtlOf, deriveState, freshBoard, prLinksOf, prsOfTool, pushEvent, projectDirName, scansForPrs, sessionTitleOf, slashCommand, summarize, toolLabel, trimAgents, workItemOf, MAX_AGENTS, MAX_EVENTS } from './lib'

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
  const pr36067 = { url: `${remote}/pullrequest/36067`, repo: 'Mio.M3.Sales', number: 36067, host: 'ado' }

  test('an az repos pr command names its PR by id', async () => {
    const command = 'wc -c .claude/pr-body.md && az repos pr update --organization https://dev.azure.com/mioit --id 36067 --description "$(cat .claude/pr-body.md)" --query pullRequestId -o tsv; rm -r .claude/pr-body.md'
    expect(adoPrOfCommand(command, '2696 .claude/pr-body.md\n36067', remote)).toEqual(pr36067)
    expect(adoPrOfCommand('az repos pr create --title x --query pullRequestId -o tsv', '36067', 'https://user@dev.azure.com/mioit/Mio.M3/_git/Mio.M3.Sales')).toEqual(pr36067)
    expect(adoPrOfCommand('az repos pr show --id 36067 -r Mio.M3.Sales', '{}', remote)).toEqual(pr36067)
  })

  test('nothing is built without an ADO remote, for another repo, or for a listing', async () => {
    expect(adoPrOfCommand('az repos pr update --id 1', '', null)).toBe(null)
    expect(adoPrOfCommand('az repos pr update --id 1', '', 'https://github.com/a/b.git')).toBe(null)
    expect(adoPrOfCommand('az repos pr show --id 1 --repository Other', '', remote)).toBe(null)
    expect(adoPrOfCommand('az repos pr list --status active', '36067', remote)).toBe(null)
    expect(adoPrOfCommand('git push', '36067', remote)).toBe(null)
  })

  test('JSON after other output still yields the link, once', async () => {
    const output = `2745 pr-body.md\n${JSON.stringify({ pullRequestId: 36067, repository: { webUrl: remote } }, null, 2)}`
    expect(prsOfTool('Bash', { command: 'az repos pr show --id 36067' }, output, remote)).toContainEqual(pr36067)
    const board = freshBoard('s1', '/x', 0)
    expect(addPrs(board, prsOfTool('Bash', { command: 'az repos pr show --id 36067' }, output, remote), 1).length).toBe(1)
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
