import { describe, expect, mock, test } from 'claude-code/testing'
import { STALE_BOARD_MS, removeScript, staleBoards, costDayOf, localDay, addMessage, crossSessionMessage, peerNotice, sendTarget, MAX_MESSAGES, boardStatus, progressOf, progressText, boardPlan, planWaiting, plannedWork, pruneShells, shellReported, shellToolDone, SHELL_MAX_MS, addPrs, adoOrgOf, cronFired, cronToolDone, nextCronMatch, pruneCrons, CRON_EXPIRY_MS, WAKEUP_ID, adoPrLink, adoPrLookupOf, adoPrShowArgv, adoRepoOf, cacheTtlOf, stepSeen, streamed, toolEndSeen, childLabel, deriveState, freshBoard, memoryOf, parseMachine, parseProbe, prLinksOf, prsOfTool, pushEvent, projectDirName, scansForPrs, sessionTitleOf, slashCommand, housekeepingCommand, summarize, toolLabel, trimAgents, workItemOf, skillTakesWorkItem, skillWorkItem, skillRulesOf, DEFAULT_SKILL_RULES, MAX_AGENTS, MAX_EVENTS, MEMORY_HISTORY, type ProcRec } from './lib'

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
    // Long args come back whole, so a work item past 200 characters is still read.
    const long = `10m /work-item-delivery ${'check the nightly export and list what is missing, '.repeat(5)}then 25229`
    expect(slashCommand(`/loop ${long}`)?.args).toBe(long)
    expect(slashCommand(`<command-name>/loop</command-name>\n<command-args>${long}</command-args>`)?.args).toBe(long)
    for (const name of ['reload-plugins', 'rename', '/model', 'Compact'])
      expect(housekeepingCommand(name)).toBe(true)
    for (const name of ['clear', 'resume', 'rewind', 'status', 'export', 'gh-issue-delivery', 'code-review', 'loop', 'init', ''])
      expect(housekeepingCommand(name)).toBe(false)
    expect(workItemOf('continue on #1234', false)).toBe('1234')
    expect(workItemOf('deliver 1234', false)).toBe(null)
    expect(workItemOf('1234, use autocomplete', true)).toBe('1234')
    // /deliver as orchestrate-delivery starts it: the issue URL wins over other digits.
    expect(workItemOf('https://github.com/o/r/issues/12 medium report-to=orch-2024 name=dlv-12', true)).toBe('12')
    expect(workItemOf('see https://github.com/o/r/issues/12', false)).toBe(null)
    // A "#" inside a URL or glued to a word names no item; Azure Boards' AB#1234 does.
    expect(workItemOf('see https://wiki/page#2345', false)).toBe(null)
    expect(workItemOf('see https://wiki/#2345', false)).toBe(null)
    expect(workItemOf('page#2345', true)).toBe(null)
    expect(workItemOf('fix (#1234)', false)).toBe('1234')
    expect(workItemOf('#1234', false)).toBe('1234')
    expect(workItemOf('fixes AB#1234', false)).toBe('1234')
    expect(workItemOf('AB#1234', false)).toBe('1234')
    expect(workItemOf('XAB#1234', false)).toBe(null)
    expect(workItemOf('page#2345 then #1234', false)).toBe('1234')
    expect(workItemOf('fixes ab#1234', false)).toBe('1234')
    expect(workItemOf('continue on WI#1234', false)).toBe(null)
    expect(workItemOf('see https://en.wikipedia.org/wiki/Foo_(bar)#1234', false)).toBe(null)
    expect(workItemOf('https://x/page-#1234', true)).toBe(null)
    expect(workItemOf('fix owner/repo#1234', false)).toBe('1234')
    expect(workItemOf('o/r#1234 medium', true)).toBe('1234')
    expect(workItemOf('see https://github.com/o/r#1234', false)).toBe(null)
    expect(workItemOf('Fixes (owner/repo#1234)', false)).toBe('1234')
    expect(workItemOf('"o/r#1234"', false)).toBe('1234')
    expect(workItemOf('wiki-page-#1234', false)).toBe(null)
    expect(workItemOf('see wiki.example.com/page#2345', false)).toBe(null)
    expect(workItemOf('a/b/c#1234', false)).toBe(null)
    expect(workItemOf('xab#1234', false)).toBe(null)
    // A long run without spaces before a "#" stays cheap.
    const run = 'x'.repeat(100_000)
    const start = Date.now()
    expect(workItemOf(`${run}#1234 ${run}`, false)).toBe(null)
    expect(Date.now() - start).toBeLessThan(500)
  })

  test('only delivery and orchestrate skills read a bare number as the work item', async () => {
    for (const name of ['deliver', 'deliver-story', 'gh-issue-delivery', 'work-item-delivery', 'orchestrate-delivery', 'gh-orchestrate-delivery', 'orchestrate', 'tools:deliver'])
      expect(skillTakesWorkItem(name)).toBe(true)
    for (const name of ['code-review', 'security-review', 'pr', 'loop', 'log-check', 'delivery-report', 'undelivered-orders', 'check-deliveries'])
      expect(skillTakesWorkItem(name)).toBe(false)
    expect(skillWorkItem('deliver', '1234, use autocomplete')).toBe('1234')
    expect(skillWorkItem('gh-issue-delivery', 'https://github.com/o/r/issues/49 medium')).toBe('49')
    expect(skillWorkItem('code-review', 'high 1234')).toBe(null)
    expect(skillWorkItem('code-review', 'medium #1234')).toBe(null)
    expect(skillWorkItem('delivery-report', '123456')).toBe(null)
    // A wrapper skill gives the work item of the command it runs.
    expect(skillWorkItem('loop', '5m /work-item-delivery 25229')).toBe('25229')
    expect(skillWorkItem('loop', '10m /gh-issue-delivery https://github.com/o/r/issues/49')).toBe('49')
    expect(skillWorkItem('loop', '5m /code-review high 1234')).toBe(null)
    expect(skillWorkItem('loop', '/deliver 1234')).toBe('1234')
    expect(skillWorkItem('loop', '10m check CI on #1234')).toBe('1234')
    expect(skillWorkItem('schedule', 'daily deliver #1234')).toBe('1234')
    // "#1234" counts for any skill but one that takes a PR; a bare number doesn't.
    expect(skillWorkItem('fix-issue', '#1234')).toBe('1234')
    expect(skillWorkItem('fix-issue', '1234')).toBe(null)
    expect(skillWorkItem('security-review', '#1234')).toBe(null)
    // Only a wrapper runs a command, and only one that opens its args.
    expect(skillWorkItem('code-review', 'explain why /deliver 1234 failed')).toBe(null)
    expect(skillWorkItem('fix-issue', 'see /deliver 1234')).toBe(null)
    expect(skillWorkItem('loop', '5m see /deliver 1234')).toBe(null)
  })

  test('skills.json replaces the lists of skill names it gives', async () => {
    // Out of the box a delivery skill by another name gets no work item from
    // a bare number, and a skill ending in -delivery does.
    expect(skillWorkItem('deliver-issue', '1234')).toBe(null)
    expect(skillWorkItem('implement-story', '1234')).toBe(null)
    expect(skillWorkItem('order-delivery', '1234')).toBe('1234')
    const rules = skillRulesOf({
      workItem: ['^(?:[\\w-]+:)?(?:deliver-issue|implement-story|gh-issue-delivery)$'],
      pr: ['review$'],
      wrapper: ['^every$'],
    })
    expect(skillWorkItem('deliver-issue', '1234', rules)).toBe('1234')
    expect(skillWorkItem('tools:implement-story', 'https://github.com/o/r/issues/49', rules)).toBe('49')
    expect(skillWorkItem('order-delivery', '1234', rules)).toBe(null)
    expect(skillWorkItem('order-delivery', '#1234', rules)).toBe('1234')
    expect(skillTakesWorkItem('DELIVER-ISSUE', rules)).toBe(true)
    expect(skillWorkItem('code-review', '#1234', rules)).toBe(null)
    // pr was replaced: "simplify" takes a work item again.
    expect(skillWorkItem('simplify', '#1234', rules)).toBe('1234')
    expect(skillWorkItem('every', '5m /deliver-issue 1234', rules)).toBe('1234')
    expect(skillWorkItem('loop', '5m /deliver-issue 1234', rules)).toBe(null)
  })

  test('skills.json keeps the default of a list it leaves out or gets wrong', async () => {
    for (const json of [null, 'x', 42, [], {}, { workItem: 'deliver$' }, { workItem: [1] }])
      expect(skillRulesOf(json)).toEqual(DEFAULT_SKILL_RULES)
    // A bad regex skips that entry only.
    const rules = skillRulesOf({ workItem: ['(', '^deliver-issue$'] })
    expect(skillTakesWorkItem('deliver-issue', rules)).toBe(true)
    expect(skillTakesWorkItem('deliver', rules)).toBe(false)
    expect(rules.pr).toBe(DEFAULT_SKILL_RULES.pr)
    // An empty list matches nothing, and so does one where nothing compiles.
    expect(skillWorkItem('loop', '5m /deliver 1234', skillRulesOf({ wrapper: [] }))).toBe(null)
    expect(skillWorkItem('order-delivery', '1234', skillRulesOf({ workItem: ['^(deliver-issue$'] }))).toBe(null)
  })

  test('skills.json says what it ignored', async () => {
    const ignoredOf = (json: unknown) => {
      const ignored: string[] = []
      skillRulesOf(json, ignored)
      return ignored
    }
    expect(ignoredOf({})).toEqual([])
    expect(ignoredOf({ workItem: ['^deliver-issue$'], pr: [], wrapper: ['^every$'] })).toEqual([])
    for (const json of [null, 'x', 42, []]) expect(ignoredOf(json)).toEqual(['not a JSON object, so every default applies'])
    // A misspelled key keeps the defaults, and says so.
    expect(ignoredOf({ workitem: ['^deliver-issue$'], PR: [] })).toEqual(['unknown key "workitem" ignored', 'unknown key "PR" ignored'])
    expect(skillRulesOf({ workitem: ['^deliver-issue$'] })).toEqual(DEFAULT_SKILL_RULES)
    expect(ignoredOf({ workItem: 'deliver$' })).toEqual(['"workItem" is not a list of strings, so its default applies'])
    expect(ignoredOf({ pr: [1], wrapper: null })).toEqual([
      '"pr" is not a list of strings, so its default applies',
      '"wrapper" is not a list of strings, so its default applies',
    ])
    expect(ignoredOf({ workItem: ['(', '^deliver-issue$', '[a'] })).toEqual([
      '"workItem" pattern "(" doesn\'t compile, skipped',
      '"workItem" pattern "[a" doesn\'t compile, skipped',
    ])
    // A long pattern is cut, so the reasons after it still fit in the event.
    for (const json of [{ pr: ['(' + 'x'.repeat(200)] }, { pr: ['(' + '\\d'.repeat(100)] }, { ['k'.repeat(300)]: [] }]) {
      const [long] = ignoredOf(json)
      expect(long!.length).toBeLessThan(90)
    }
    expect(ignoredOf({ 'a"b': [] })).toEqual(['unknown key "a\\"b" ignored'])
  })

  test('years and dates are not work items', async () => {
    expect(workItemOf('2026-10-31', true)).toBe(null)
    expect(workItemOf('since 2026/10, see 10/2026 or 31.10.2026', true)).toBe(null)
    expect(workItemOf('report for 2026', true)).toBe(null)
    expect(workItemOf('name=dlv-25229', true)).toBe(null)
    expect(workItemOf('2026-10-31 then 25229', true)).toBe('25229')
    expect(workItemOf('deliver 25229.', true)).toBe('25229')
    expect(workItemOf('logs from #2026-10-31', false)).toBe(null)
    expect(workItemOf('dates #2026-10-31 and #1234', false)).toBe('1234')
    expect(workItemOf('continue on #2026', false)).toBe('2026')
    expect(workItemOf('since #2026/10', false)).toBe(null)
    // A year-range number that opens the args is the item it names.
    expect(workItemOf('2045', true)).toBe('2045')
    expect(workItemOf('2045, use autocomplete', true)).toBe('2045')
    // Pairs and ranges of items are not dates.
    expect(workItemOf('25229/25230', true)).toBe('25229')
    expect(workItemOf('25229-25231', true)).toBe('25229')
    expect(workItemOf('#25229-25231', false)).toBe('25229')
    expect(workItemOf('https://dev.azure.com/org/proj/_workitems/edit/25229', true)).toBe('25229')
    expect(workItemOf('https://org.visualstudio.com/P/_workitems/edit/2026/ medium', true)).toBe('2026')
    expect(workItemOf('see https://example.com/a/25229', true)).toBe(null)
    expect(workItemOf('2045-2046', true)).toBe('2045')
    expect(workItemOf('2045/2046', true)).toBe('2045')
    expect(workItemOf('1500.50 then 25229', true)).toBe('25229')
    expect(workItemOf('build 1.2.12345', true)).toBe(null)
    expect(workItemOf('2026-1-12345', true)).toBe(null)
  })

  test('card and phone numbers are not work items', async () => {
    expect(workItemOf('1234-5678-9012', true)).toBe(null)
    expect(workItemOf('card 1234-5678-9012-3456 then 25229', true)).toBe('25229')
    expect(workItemOf('1234 5678 9012 3456', true)).toBe(null)
    expect(workItemOf('1234\u00a05678\u00a09012\u00a03456', true)).toBe(null)
    expect(workItemOf('1234 5678 9012 3456 25229', true)).toBe('25229')
    expect(workItemOf('call 555 123 4567', true)).toBe(null)
    expect(workItemOf('+46 8 1234 5678', true)).toBe(null)
    expect(workItemOf('08-1234 5678', true)).toBe(null)
    expect(workItemOf('1234-56789012', true)).toBe(null)
    expect(workItemOf('#1234-5678-9012', false)).toBe(null)
    expect(workItemOf('#1234 5678 9012 3456', false)).toBe(null)
    expect(workItemOf('#1234-56789012', false)).toBe(null)
    expect(workItemOf('#1234-5678-9012 and #25229', false)).toBe('25229')
    // Pairs and lists of items still count.
    expect(workItemOf('25229-25231', true)).toBe('25229')
    expect(workItemOf('25229 25230', true)).toBe('25229')
    expect(workItemOf('30395 30396 30397', true)).toBe('30395')
    expect(workItemOf('30395-30396-30397', true)).toBe('30395')
    expect(workItemOf('#30395-30396-30397', false)).toBe('30395')
    expect(workItemOf('4512 4513 4514', true)).toBe('4512')
    expect(workItemOf('1234 5678', true)).toBe('1234')
    expect(workItemOf('2026-10-31 25229', true)).toBe('25229')
    expect(workItemOf('25229 3 times', true)).toBe('25229')
    expect(workItemOf('25229 20261122', true)).toBe('25229')
    expect(workItemOf('4512 4513 4514 4515 4516', true)).toBe('4512')
    expect(workItemOf('/deliver 4512 2 3', true)).toBe('4512')
    expect(workItemOf('#4512 2 3', false)).toBe('4512')
    expect(workItemOf('2026-10-31 4512', true)).toBe('4512')
    expect(workItemOf('1234  5678  9012  3456', true)).toBe(null)
    expect(workItemOf('555 - 123 - 4567', true)).toBe(null)
    // Long runs stay cheap.
    for (const text of [`${'1 '.repeat(50_000)}x`, '1234 5678 9012 3456, '.repeat(10_000)]) {
      const start = Date.now()
      expect(workItemOf(text, true)).toBe(null)
      expect(Date.now() - start).toBeLessThan(2000)
    }
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

test('a subagent turn inside the main turn neither ends nor hides it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { SESSION_BOARD_DIR: '/board' })
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const status = async () => {
    await clock.advance(1_000)
    // The kit resolves the path, to C:\board\... on Windows.
    const [, text] = [...files].find(([path]) => /[\\/]sessions[\\/]s1\.json$/.test(path)) ?? []
    return JSON.parse(text ?? '{}')
  }

  await $.session.start({ cwd: '/x', surface: null, isInteractive: true })
  await $.turn.start({ text: 'deliver #29588', turnId: 'main' })
  // A foreground subagent: its prompt and turn arrive while the main turn runs.
  await $.turn.start({ text: 'Close story 29588', turnId: 'sub', agentId: 'a1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'a1', reason: 'answer' })
  await $.tool.call({ tool: 'mcp__session-board__board_status', status: 'done', note: 'delivered' })
  expect((await status()).state).toBe('running')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })

  const board = await status()
  expect(board.state).toBe('idle')
  expect(board.done?.note).toBe('delivered')
  expect(board.prompt).toBe('deliver #29588')
  expect(board.turns).toBe(1)
})

test('a skill that takes a PR number does not set the work item', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { SESSION_BOARD_DIR: '/board' })
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }))
  const status = async () => {
    await clock.advance(1_000)
    const [, text] = [...files].find(([path]) => /[\\/]sessions[\\/]s1\.json$/.test(path)) ?? []
    return JSON.parse(text ?? '{}')
  }
  const turn = async (text: string, turnId: string, skill?: { skill: string; args: string }) => {
    await $.turn.start({ text, turnId })
    if (skill) await $.tool.call({ tool: 'Skill', ...skill })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  }

  await $.session.start({ cwd: '/x', surface: null, isInteractive: true })
  await turn('/code-review high 1234', 't1')
  expect((await status()).workItem ?? null).toBe(null)
  await turn('/code-review medium #1234', 't1b')
  expect((await status()).workItem ?? null).toBe(null)

  await turn('/gh-issue-delivery https://github.com/o/r/issues/49 medium', 't2')
  expect((await status()).workItem).toBe('49')
  // The delivery runs code-review on its PR in a later turn: the work item stays.
  await turn('<agent-message from="a1">verified</agent-message>', 't3', { skill: 'code-review', args: 'medium 1234' })
  expect((await status()).workItem).toBe('49')
  await turn('/code-review high #1234', 't4')
  expect((await status()).workItem).toBe('49')
  await turn('/fix-issue #1301', 't4b')
  expect((await status()).workItem).toBe('1301')
  // A plain prompt still names a work item with "#".
  await turn('now continue on #1300', 't5')
  expect((await status()).workItem).toBe('1300')
  await turn('/loop 5m /work-item-delivery 25229', 't6')
  expect((await status()).workItem).toBe('25229')
})

test('skills.json in the board folder decides which skills take a work item', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { SESSION_BOARD_DIR: '/board' })
  const files = new Map<string, string>()
  // The engine resolves the board folder to an absolute path.
  const skillsJson = (path: string) => /[\\/]board[\\/]skills\.json$/.test(path)
  // Saved with a byte-order mark, as Windows PowerShell 5.1 does.
  let rules = '\u{FEFF}' + JSON.stringify({ workItem: ['^deliver-issue$'] })
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_$, e) => ({ value: skillsJson(e.path) || files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: skillsJson(e.path) ? rules : files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const status = async () => {
    await clock.advance(1_000)
    const [, text] = [...files].find(([path]) => /[\\/]sessions[\\/]s1\.json$/.test(path)) ?? []
    return JSON.parse(text ?? '{}')
  }
  const turn = async (text: string, turnId: string) => {
    await $.turn.start({ text, turnId })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  }

  await $.session.start({ cwd: '/x', surface: null, isInteractive: true })
  await turn('/order-delivery 1234', 't1')
  expect((await status()).workItem ?? null).toBe(null)
  await turn('/deliver-issue 4321', 't2')
  expect((await status()).workItem).toBe('4321')

  // A broken file leaves the defaults and says so in the events.
  rules = '{ workItem: '
  await $.session.start({ cwd: '/x', surface: null, isInteractive: true })
  const after = await status()
  expect(after.events.some((e: { text: string }) => e.text.startsWith('skills.json unreadable'))).toBe(true)
  await turn('/order-delivery 1234', 't3')
  expect((await status()).workItem).toBe('1234')
})

test('a housekeeping command keeps the skill and its progress report', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { SESSION_BOARD_DIR: '/board' })
  const files = new Map<string, string>()
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const status = async () => {
    await clock.advance(1_000)
    const [, text] = [...files].find(([path]) => /[\\/]sessions[\\/]s1\.json$/.test(path)) ?? []
    return JSON.parse(text ?? '{}')
  }
  const turn = async (text: string, turnId: string) => {
    await $.turn.start({ text, turnId })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  }

  await $.session.start({ cwd: '/x', surface: null, isInteractive: true })
  await $.turn.start({ text: '/gh-issue-delivery https://github.com/o/r/issues/58 medium', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__session-board__board_status', phase: 'Implementing', workItem: '58' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await status()).progress?.phase).toBe('Implementing')

  await turn('<command-message>reload-plugins</command-message>\n<command-name>/reload-plugins</command-name>\n<command-args></command-args>', 't2')
  await turn('/rename delivery 58', 't3')
  let board = await status()
  expect(board.progress?.phase).toBe('Implementing')
  expect(board.skill?.name).toBe('gh-issue-delivery')
  expect(board.activeSkill).toBe('gh-issue-delivery')
  expect(board.workItem).toBe('58')
  expect(board.prompt).toBe('/gh-issue-delivery https://github.com/o/r/issues/58 medium')
  expect(board.turns).toBe(1)
  // Logged, but not as a prompt: a done tile doesn't count it as "+N prompts".
  expect(board.events.find((e: { text: string }) => e.text === '/rename delivery 58')?.kind).toBe('session')

  // Another skill is still a new task.
  await turn('/code-review high 70', 't4')
  board = await status()
  expect(board.progress ?? null).toBe(null)
  expect(board.skill?.name).toBe('code-review')

  // A skill the model loads is recorded even if a built-in shares its name.
  await $.turn.start({ text: 'check the status', turnId: 't5' })
  await $.tool.call({ tool: 'Skill', skill: 'status', args: '' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't5', reason: 'answer' })
  expect((await status()).activeSkill).toBe('status')
})

test('a long command keeps its work item and stores clipped args', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { SESSION_BOARD_DIR: '/board' })
  const files = new Map<string, string>()
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const status = async () => {
    await clock.advance(1_000)
    const [, text] = [...files].find(([path]) => /[\\/]sessions[\\/]s1\.json$/.test(path)) ?? []
    return JSON.parse(text ?? '{}')
  }

  const args = `10m /work-item-delivery ${'check the nightly export and list what is missing, '.repeat(5)}then 25229`
  expect(args.length).toBeGreaterThan(200)
  await $.session.start({ cwd: '/x', surface: null, isInteractive: true })
  await $.turn.start({ text: `<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>${args}</command-args>`, turnId: 't1' })
  const board = await status()
  expect(board.workItem).toBe('25229')
  expect(board.skill?.name).toBe('loop')
  expect(board.skill?.args.length).toBe(200)
  expect(board.skill?.args.endsWith('…')).toBe(true)

  // Args the model passes to the Skill tool are stored clipped too, and the
  // work item is still read from them whole, not from the clipped copy.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'deliver the next one', turnId: 't2' })
  await $.tool.call({ tool: 'Skill', skill: 'work-item-delivery', args: `${'use low review and keep the diff small, '.repeat(6)}then 25230` })
  const next = await status()
  expect(next.workItem).toBe('25230')
  expect(next.skill?.name).toBe('work-item-delivery')
  expect(next.skill?.args.length).toBe(200)
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

describe('model steps', () => {
  test('the main thread streaming moves lastStepAt on, a subagent does not', () => {
    const b = freshBoard('s1', '/x', 0)
    expect(b.lastStepAt ?? null).toBe(null)
    stepSeen(b, undefined, 100)
    expect(b.lastStepAt).toBe(100)
    stepSeen(b, 'agent-1', 200)
    expect(b.lastStepAt).toBe(100)
    stepSeen(b, undefined, 50) // never goes back
    expect(b.lastStepAt).toBe(100)
    stepSeen(b, undefined, 300)
    expect(b.lastStepAt).toBe(300)
  })

  test('a main-thread tool ending moves lastToolEnd on, a subagent one does not', () => {
    const b = freshBoard('s1', '/x', 0)
    expect(b.lastToolEnd).toBe(null) // present, so the page knows these hooks write it
    toolEndSeen(b, undefined, 100)
    expect(b.lastToolEnd).toBe(100)
    toolEndSeen(b, 'agent-1', 200)
    expect(b.lastToolEnd).toBe(100)
    toolEndSeen(b, undefined, 50) // never goes back
    expect(b.lastToolEnd).toBe(100)
    toolEndSeen(b, undefined, 300)
    expect(b.lastToolEnd).toBe(300)
  })

  test('streamed forwards a stream as yield* would and notes each chunk', async () => {
    const got: unknown[] = []
    async function* source() {
      try {
        got.push(yield 1)
        got.push(yield 2)
        return 'end'
      } catch (err) {
        got.push(`caught ${String(err)}`)
        yield 9
        return 'recovered'
      } finally {
        got.push('closed')
      }
    }
    let n = 0
    const all = streamed(source(), () => n++)
    expect(await all.next()).toEqual({ value: 1, done: false })
    expect(await all.next('a')).toEqual({ value: 2, done: false })
    expect(await all.next('b')).toEqual({ value: 'end', done: true })
    expect(got).toEqual(['a', 'b', 'closed'])
    expect(n).toBe(2)

    got.length = 0
    const thrown = streamed(source(), () => { throw new Error('a bad note') })
    await thrown.next()
    expect(await thrown.throw('abort')).toEqual({ value: 9, done: false })
    expect(await thrown.next()).toEqual({ value: 'recovered', done: true })
    expect(got).toEqual(['caught abort', 'closed'])

    got.length = 0
    const closed = streamed(source(), () => {})
    await closed.next()
    await closed.return(undefined as never)
    expect(got).toEqual(['closed'])

    async function* failing() {
      yield 1
      throw new Error('network')
    }
    const failed = streamed(failing(), () => {})
    expect(await failed.next()).toEqual({ value: 1, done: false })
    await expect(failed.next()).rejects.toThrow('network')
    expect(await failed.next()).toEqual({ value: undefined, done: true })
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

  test("a subagent's shell goes when the subagent ends", async () => {
    const board = freshBoard('s1', '/x', 0)
    board.agents.push({ key: 'a1', agentId: 'a1', type: 'wi-contract-review', description: '', status: 'running', since: 0 })
    shellToolDone(board, 'Bash', { command: 'dotnet test' }, { backgroundTaskId: 'b1' }, 't1', 0, 'a1')
    shellToolDone(board, 'Bash', { command: 'ado-watch.sh' }, { backgroundTaskId: 'b2' }, 't2', 0)
    pruneShells(board, 1)
    expect(board.shells?.map((s) => s.id)).toEqual(['b1', 'b2'])
    board.agents[0]!.status = 'done'
    pruneShells(board, 2)
    expect(board.shells?.map((s) => s.id)).toEqual(['b2'])
  })
})

describe('board_status', () => {
  test('done and working set and clear the flag', async () => {
    const board = freshBoard('s1', '/x', 0)
    expect(boardStatus(board, { status: 'done', note: 'PR !12 merged' }, 5)).toMatch(/Follow-ups do not undo it/)
    expect(board.done).toEqual({ at: 5, note: 'PR !12 merged' })
    expect(boardStatus(board, { status: 'maybe' }, 6)).toMatch(/nothing recorded/)
    expect(board.done?.at).toBe(5)
    boardStatus(board, { status: 'working' }, 7)
    expect(board.done).toBe(null)
  })

  test('a progress report leaves done alone and replaces the last report', () => {
    const board = freshBoard('s1', '/x', 0)
    expect(boardStatus(board, { phase: 'Reviewing', step: 3, of: 7, workItem: '#25229' }, 5)).toMatch(/does not mark the task done/)
    expect(board.progress).toEqual({ at: 5, phase: 'Reviewing', step: 3, of: 7, workItem: '25229' })
    expect(board.done ?? null).toBe(null)
    boardStatus(board, { status: 'done', note: 'merged' }, 6)
    expect(board.done?.at).toBe(6)
    expect(board.progress).toBe(null) // done ends the report
    // A progress report after done doesn't reopen the task.
    boardStatus(board, { phase: 'Answering a question' }, 7)
    expect(board.done?.at).toBe(6)
    expect(board.progress?.phase).toBe('Answering a question')
    expect(board.progress?.step).toBe(null)
    // "working" with progress reopens and reports in one call.
    boardStatus(board, { status: 'working', phase: 'Fixing review findings' }, 8)
    expect(board.done).toBe(null)
    expect(board.progress).toEqual({ at: 8, phase: 'Fixing review findings', step: null, of: null, workItem: null })
  })

  test('no status and nothing usable records nothing', () => {
    const board = freshBoard('s1', '/x', 0)
    expect(boardStatus(board, {}, 1)).toMatch(/nothing recorded/)
    expect(boardStatus(board, { phase: '   ', step: 0 }, 1)).toMatch(/nothing recorded/)
    expect(boardStatus(board, { status: 'later', phase: 'x' }, 1)).toMatch(/nothing recorded/)
    expect(board.progress ?? null).toBe(null)
  })

  test('the reply says what it did not keep', () => {
    const board = freshBoard('s1', '/x', 0)
    expect(boardStatus(board, { status: 'done', phase: 'Merged' }, 1)).toMatch(/report is cleared/)
    expect(boardStatus(board, { phase: 'Reviewing', note: 'x' }, 2)).toMatch(/note is only kept with a status/)
    expect(boardStatus(board, { status: 'working', phase: ' ' }, 3)).toMatch(/no progress recorded/)
  })

  test('a subagent cannot replace the main loop\'s report', () => {
    const board = freshBoard('s1', '/x', 0)
    boardStatus(board, { phase: 'Implementing', step: 3, of: 7 }, 1)
    expect(boardStatus(board, { phase: 'Writing tests', agentId: 'a1' }, 2)).toMatch(/main session only/)
    expect(board.progress?.phase).toBe('Implementing')
  })

  test('progressOf cleans what the model sends', () => {
    expect(progressOf({ step: '2', of: 1, phase: 'a\n  b' }, 1)).toEqual({ at: 1, phase: 'a b', step: 2, of: null, workItem: null })
    expect(progressOf({ of: 7 }, 1)).toBe(null) // a total alone says nothing
    expect(progressOf({ step: 1.5, workItem: 1.5 }, 1)).toBe(null)
    expect(progressOf({ workItem: 25229 }, 1)?.workItem).toBe('25229')
    expect(progressOf({ phase: 'x'.repeat(100) }, 1)?.phase.length).toBeLessThanOrEqual(60)
  })

  test('progressText reads like the tile', () => {
    expect(progressText({ at: 0, phase: 'Reviewing', step: 3, of: 7, workItem: '25229' })).toBe('Reviewing · 3/7 · #25229')
    expect(progressText({ at: 0, phase: '', step: 2, of: null, workItem: null })).toBe('step 2')
  })
})

describe('board_plan', () => {
  const plan = {
    workItem: '#24190', title: 'Completeness view',
    questions: ['Is the log feed in place?'],
    items: [
      { workItem: '26099', title: 'Bug one', type: 'Bug', start: 'now' },
      { workItem: 26098, title: 'Bug two', type: 'Bug', start: 'now' },
      { workItem: '26219', title: 'Overlap', start: 'later', after: ['26098', '26219', 'bad id!'], proposed: true },
      { workItem: '29581', title: 'SFTP row', start: 'hold', question: 1 },
      { workItem: '26100', title: 'Docs', start: 'skip', reason: 'tasks get no session' },
      { workItem: '26099', title: 'repeated', start: 'now' },
      { title: 'no id', start: 'now' },
    ],
  }

  test('records the plan, cleaned, and a gate while it waits for the go', () => {
    const board = freshBoard('s1', '/x', 0)
    expect(boardPlan(board, plan, 5)).toMatch(/5 items, 4 to deliver.*waiting for the user.*left out/)
    expect(board.plan?.workItem).toBe('24190')
    expect(board.plan?.items.map((i) => i.workItem)).toEqual(['26099', '26098', '26219', '29581', '26100'])
    expect(board.plan?.items[2]?.after).toEqual(['26098'])
    expect(board.plan?.items[2]?.proposed).toBe(true)
    expect(board.plan?.items[3]?.question).toBe(1)
    expect(board.plan?.gate).toEqual({ since: 5, questions: ['Is the log feed in place?'] })
    expect(planWaiting(board)).toEqual({ kind: 'plan', detail: 'Go-ahead for the plan for #24190, and 1 answer', since: 5 })
  })

  test('a new call replaces the plan and keeps the gate time', () => {
    const board = freshBoard('s1', '/x', 0)
    boardPlan(board, { ...plan, questions: [], waitingForGo: true }, 5)
    boardPlan(board, { ...plan, questions: [], waitingForGo: true, items: [{ workItem: '1', title: 'a', start: 'bogus', question: 3 }] }, 9)
    expect(board.plan?.items).toEqual([{ workItem: '1', title: 'a', type: '', start: 'now', after: [], proposed: false, question: null, reason: '' }])
    expect(board.plan?.gate?.since).toBe(5)
    boardPlan(board, { ...plan, questions: [] }, 12)
    expect(board.plan?.gate).toBe(null)
    expect(planWaiting(board)).toBe(null)
  })

  test('refuses an empty plan and clears on request', () => {
    const board = freshBoard('s1', '/x', 0)
    expect(boardPlan(board, { items: [] }, 1)).toMatch(/Nothing recorded/)
    expect(board.plan).toBe(undefined)
    boardPlan(board, plan, 2)
    expect(boardPlan(board, { clear: true }, 3)).toMatch(/Removed/)
    expect(board.plan).toBe(null)
  })
})

test('a plan waiting for the go keeps the session waiting until the person replies', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, { SESSION_BOARD_DIR: '/board' })
  const files = new Map<string, string>()
  on('session.id', () => ({ value: 's1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const status = async () => {
    await clock.advance(1_000)
    const [, text] = [...files].find(([path]) => /[\\/]sessions[\\/]s1\.json$/.test(path)) ?? []
    return JSON.parse(text ?? '{}')
  }

  await $.session.start({ cwd: '/x', surface: null, isInteractive: true })
  await $.turn.start({ text: 'orchestrate feature 24190', turnId: 't1' })
  const result = await $.tool.call({
    tool: 'mcp__session-board__board_plan', workItem: '24190', waitingForGo: true,
    items: [{ workItem: '26099', title: 'Bug one', start: 'now' }],
  })
  expect(String(result.result)).toMatch(/Plan on the board/)
  expect((await status()).state).toBe('running')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const waiting = await status()
  expect(waiting.state).toBe('waiting')
  expect(waiting.waiting?.kind).toBe('plan')
  expect(waiting.plan?.items?.[0]?.workItem).toBe('26099')

  // A housekeeping command is no go: the plan still waits, even if no turn end follows.
  await $.turn.start({ text: '/rename orchestrator', turnId: 't1b' })
  expect((await status()).waiting?.kind).toBe('plan')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1b', reason: 'answer' })
  expect((await status()).waiting?.kind).toBe('plan')

  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  const after = await status()
  expect(after.state).toBe('idle')
  expect(after.plan?.gate).toBe(null)
})

describe('planned work', () => {
  const t = 10 * 3600_000
  const live = (id: string, workItem: string | null, extra: Record<string, unknown> = {}) =>
    ({ ...freshBoard(id, 'C:\\Workspace\\Kanban', t), workItem, updatedAt: t - 5_000, state: 'running', ...extra })

  test('queued and running items come first by project, live sessions on work items join them', async () => {
    const queue = {
      limits: {},
      items: [
        { id: 'a', workItem: '101', cwd: 'C:\\Workspace\\Kanban', name: 'Kanban', state: 'queued', queuedAt: t - 30 * 60_000 },
        { id: 'b', workItem: '102', cwd: 'C:\\Workspace\\Kanban', name: 'Kanban', state: 'running', startedAt: t - 2 * 3600_000, sessionId: 's1' },
        { id: 'c', workItem: '103', cwd: 'C:\\Workspace\\Edi', name: 'Edi', state: 'done' },
      ],
    }
    const boards = [
      live('s1', '102'), // the queue's own session: listed once
      live('s2', '200', { tabTitle: 'Fix capture' }),
      live('s3', '201', { updatedAt: t - 120_000 }), // gone
      live('s4', '202', { state: 'ended' }),
      live('s5', null),
      live('me', '203', { done: { at: t, note: '' } }),
      null,
    ]
    const text = plannedWork(queue, boards, 'me', t)
    expect(text).toBe([
      'Kanban (C:\\Workspace\\Kanban)',
      '  #102  running from the queue, started 2 h ago',
      '  #200  in progress in session "Fix capture"',
      '  #203  finished, not closed yet in this session',
      '  #101  queued, added 30 min ago',
    ].join('\n'))
  })

  test('a project filter matches name or path, and says when nothing matches', async () => {
    const queue = { items: [{ workItem: '101', cwd: 'C:\\Workspace\\Kanban', name: 'Kanban', state: 'queued' }] }
    expect(plannedWork(queue, [], '', t, 'kanban')).toContain('#101')
    expect(plannedWork(queue, [], '', t, 'C:/Workspace/Kanban/')).toContain('#101')
    expect(plannedWork(queue, [], '', t, 'Edi')).toBe('Nothing queued or in progress on the board for Edi.')
    expect(plannedWork(null, [], '', t)).toMatch(/^Nothing planned on the board: there is no queue yet/)
    expect(plannedWork('garbage', [{}], '', t)).toBe('Nothing queued or in progress on the board.')
  })
})

test('the board answers its own board_queue tool', async ($) => {
  const result = await $.tool.call({ tool: 'mcp__session-board__board_queue' })
  expect(result.deny).toBe(undefined)
  // The kit has no env to find the board folder in; the tool still answers.
  expect(String(result.result)).toMatch(/Nothing|#\d+|not available/)
})

describe('messages between sessions', () => {
  const envelope = '<cross-session-message from="uds:\\.\pipe\LOCAL\cc-msg-3aee0de9" from-name="session-board-57" from-mode="prompting">\nProbe reply: all good.\n</cross-session-message>\n\nThis came from another Claude session.'

  test('a message from another session is parsed, wherever its attributes are', async () => {
    expect(crossSessionMessage(envelope)).toEqual({ fromName: 'session-board-57', address: 'uds:\\.\pipe\LOCAL\cc-msg-3aee0de9', body: 'Probe reply: all good.' })
    expect(crossSessionMessage('<cross-session-message from-name="a-1" from="bridge:s">cut off')).toEqual({ fromName: 'a-1', address: 'bridge:s', body: 'cut off' })
    expect(crossSessionMessage('<cross-session-message from="uds:x">hi</cross-session-message>')?.fromName).toBe('uds:x')
    expect(crossSessionMessage('please look at <cross-session-message from="x">')).toBe(null)
    expect(crossSessionMessage('<agent-message from="a1">done</agent-message>')).toBe(null)
  })

  test('notices about another session are recognised', async () => {
    expect(peerNotice('[Cross-session idle notice] "session-board-57", which you asked to be notified about, is idle now')).toEqual({ kind: 'idle', peer: 'session-board-57' })
    expect(peerNotice('[Cross-session delivery notice] held for approval')).toEqual({ kind: 'delivery', peer: '' })
    expect(peerNotice('what is a [Cross-session idle notice]?')).toBe(null)
  })

  test('a send names another session, not a subagent or teammate of this one', async () => {
    const board = freshBoard('s1', '/x', 0)
    board.agents.push({ key: 'a1b2', agentId: 'a1b2', type: 'Explore', description: '', status: 'running', since: 0 })
    expect(sendTarget(board, 'session-board-57')).toEqual({ peer: 'session-board-57' })
    expect(sendTarget(board, 'main')).toBe(null)
    expect(sendTarget(board, 'a1b2')).toBe(null)
    expect(sendTarget(board, 'researcher@team')).toBe(null)
    // A reply to a from address is named after the session that wrote from it.
    addMessage(board, { t: 1, dir: 'in', peer: 'session-board-57', address: 'uds:pipe-57', text: 'hi' })
    expect(sendTarget(board, 'uds:pipe-57')).toEqual({ peer: 'session-board-57', address: 'uds:pipe-57' })
    expect(sendTarget(board, 'uds:other')).toEqual({ peer: 'uds:other', address: 'uds:other' })
  })

  test('one delivery seen twice is kept once, and the list is capped', async () => {
    const board = freshBoard('s1', '/x', 0)
    expect(addMessage(board, { t: 1000, dir: 'in', peer: 'x-57', text: 'hello' })).toBe(true)
    expect(addMessage(board, { t: 3000, dir: 'in', peer: 'x-57', text: 'hello' })).toBe(false)
    expect(addMessage(board, { t: 3000, dir: 'out', peer: 'x-57', text: 'hello' })).toBe(true)
    expect(addMessage(board, { t: 3000 + 11 * 60_000, dir: 'in', peer: 'x-57', text: 'hello' })).toBe(true)
    for (let i = 0; i < MAX_MESSAGES + 5; i++) addMessage(board, { t: i, dir: 'out', peer: 'y', text: String(i) })
    expect(board.messages?.length).toBe(MAX_MESSAGES)
    expect(board.messages?.at(-1)?.text).toBe(String(MAX_MESSAGES + 4))
  })

  test('SendMessage reads as a line naming its recipient', async () => {
    expect(summarize('SendMessage', { to: 'session-board-57', summary: 'probe', message: 'long text' })).toBe('→ session-board-57: probe')
  })
})

test('the board never gets in the way of a message to another session', async ($, on) => {
  on('session.send', () => ({ isDelivered: true }))
  const result = await $.session.send({ to: 'session-board-57', text: 'hello' })
  expect(result.isDelivered).toBe(true)
})

describe('cost per day', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()

  test('the local day is a date string', async () => {
    expect(localDay(at(22, 0, 5))).toBe('2026-11-22')
    expect(localDay(at(21, 23, 59))).toBe('2026-11-21')
  })

  test('a fresh session counts from 0, one from older hooks from now', async () => {
    expect(costDayOf(null, null, 0.4, at(22, 9), at(22, 9, 1))).toEqual({ day: '2026-11-22', usd: 0 })
    expect(costDayOf(undefined, 3, 3.5, at(21, 9), at(22, 9))).toEqual({ day: '2026-11-22', usd: 3.5 })
  })

  test('the baseline holds through the day and moves at midnight', async () => {
    const today = { day: '2026-11-22', usd: 2 }
    expect(costDayOf(today, 4, 5, at(21, 9), at(22, 18))).toBe(today)
    // The first refresh after midnight: yesterday ended where the last one left it.
    expect(costDayOf({ day: '2026-11-21', usd: 0 }, 6, 6.2, at(21, 9), at(22, 0, 0))).toEqual({ day: '2026-11-22', usd: 6 })
  })

  test('an unknown cost keeps the baseline, a total that went down was reset', async () => {
    const today = { day: '2026-11-22', usd: 2 }
    expect(costDayOf(today, 4, null, at(21, 9), at(22, 18))).toBe(today)
    expect(costDayOf(null, null, null, at(22, 9), at(22, 18))).toBe(null)
    // $2 spent today before the reset still counts: 1 - (-2) = 3.
    expect(costDayOf(today, 4, 1, at(21, 9), at(22, 18))).toEqual({ day: '2026-11-22', usd: -2 })
    expect(costDayOf(today, null, 1, at(21, 9), at(22, 18))).toEqual({ day: '2026-11-22', usd: 0 })
    // Reset across midnight: everything since counts.
    expect(costDayOf({ day: '2026-11-21', usd: 0 }, 8, 0.5, at(21, 9), at(22, 0, 1))).toEqual({ day: '2026-11-22', usd: 0 })
  })
})

describe('old status files', () => {
  const now = 1_800_000_000_000
  const at = (updatedAt: unknown) => JSON.stringify({ updatedAt })

  test('only files more than a week old are deleted, never this session\'s own', async () => {
    const files = [
      { name: 'old.json', text: at(now - STALE_BOARD_MS - 1) },
      { name: 'recent.json', text: at(now - STALE_BOARD_MS + 60_000) },
      { name: 'self.json', text: at(now - STALE_BOARD_MS - 1) },
    ]
    expect(staleBoards(files, 'self', now)).toEqual(['old.json'])
  })

  test('each project keeps its newest file, so the queue still lists it', async () => {
    const week = now - STALE_BOARD_MS
    const of = (updatedAt: number, cwd: string, root?: string) => JSON.stringify({ updatedAt, cwd, repo: root ? { root } : null })
    const files = [
      { name: 'a-old.json', text: of(week - 9_000, 'C:\\repo\\a\\sub', 'C:\\repo\\a') },
      { name: 'a-newer.json', text: of(week - 5_000, 'c:/Repo/A/') },
      { name: 'b-only.json', text: of(week - 9_000, 'C:\\scratch\\b') },
      { name: 'c-old.json', text: of(week - 9_000, 'C:\\c') },
      { name: 'c-live.json', text: of(now - 1_000, 'C:\\c') },
    ]
    expect(staleBoards(files, 'self', now).sort()).toEqual(['a-old.json', 'c-old.json'])
  })

  test('each work item keeps its newest file, so a plan strip still shows it', async () => {
    const week = now - STALE_BOARD_MS
    const of = (updatedAt: number, workItem: string | null) => JSON.stringify({ updatedAt, cwd: 'C:\\p', workItem })
    const files = [
      { name: 'live.json', text: of(now - 1_000, null) },
      { name: 'w12-old.json', text: of(week - 9_000, '12') },
      { name: 'w12-new.json', text: of(week - 5_000, '12') },
      { name: 'none.json', text: of(week - 9_000, null) },
    ]
    expect(staleBoards(files, 'self', now).sort()).toEqual(['none.json', 'w12-old.json'])
  })

  test('projects are told apart as the server does, and relative paths have none', async () => {
    const week = now - STALE_BOARD_MS
    const of = (updatedAt: number, cwd: string) => JSON.stringify({ updatedAt, cwd })
    const files = [
      { name: 'root.json', text: of(week - 9_000, 'C:\\') },
      { name: 'rel.json', text: of(week - 5_000, 'C:') },
      { name: 'dots-old.json', text: of(week - 9_000, 'C:\\r\\x\\..\\.\\a') },
      { name: 'dots-new.json', text: of(week - 5_000, 'c://r//a') },
    ]
    expect(staleBoards(files, 'self', now).sort()).toEqual(['dots-old.json', 'rel.json'])
  })

  test('unreadable, unparsable and foreign files are left alone', async () => {
    const old = at(now - STALE_BOARD_MS - 1)
    const files = [
      { name: 'unread.json', text: null },
      { name: 'torn.json', text: '{"updatedAt": 1' },
      { name: 'no-date.json', text: '{}' },
      { name: 'string-date.json', text: at('2020-01-01') },
      { name: 'null.json', text: 'null' },
      { name: 'notes.txt', text: old },
      { name: "a'b.json", text: old },
      { name: 'x;rm.json', text: old },
    ]
    expect(staleBoards(files, 'self', now)).toEqual([])
  })

  test('the delete command quotes every path and checks the age again', async () => {
    const curly = String.fromCodePoint(0x2019)
    const script = removeScript(['C:/b/sessions/a.json', "C:/O'Neil/s/b.json", `C:/x${curly}y/c.json`])
    expect(script.startsWith(`Get-Item -LiteralPath 'C:/b/sessions/a.json','C:/O''Neil/s/b.json','C:/x${curly}${curly}y/c.json' `)).toBe(true)
    expect(script).toContain(`LastWriteTime -lt (Get-Date).AddMilliseconds(-${STALE_BOARD_MS})`)
    expect(script.endsWith('; exit 0')).toBe(true)
  })
})

// #73: a model stream that fails after some chunks reaches the turn.step
// hook's .catch, whose next(e) would send the request a second time.
describe('turn.step failures', () => {
  const step = (agentId?: string) => ({ turnId: 't1', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })

  async function drain(s: AsyncIterable<unknown>): Promise<{ chunks: unknown[]; failed: boolean }> {
    const chunks: unknown[] = []
    let failed = false
    try {
      for await (const c of s) chunks.push(c)
    } catch {
      failed = true
    }
    return { chunks, failed }
  }

  for (const agentId of [undefined, 'a1']) {
    test(`a stream that fails mid-stream is not requested again (${agentId ? 'subagent' : 'main'})`, async ($, on) => {
      let requests = 0
      on('turn.step', async function* () {
        requests++
        yield { kind: 'text' as const, index: 0, text: 'part ' + requests }
        throw new Error('stream broke')
      })
      const { chunks, failed } = await drain($.turn.step(step(agentId)))
      expect(requests).toBe(1)
      expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'part 1' }])
      expect(failed).toBe(true)
    })
  }

  test('a request that fails before any chunk is not sent again', async ($, on) => {
    let requests = 0
    on('turn.step', async function* () {
      requests++
      throw new Error('request failed')
    })
    const { chunks, failed } = await drain($.turn.step(step()))
    expect(requests).toBe(1)
    expect(chunks).toEqual([])
    expect(failed).toBe(true)
  })

  test('a stream that ends normally passes through once', async ($, on) => {
    let requests = 0
    on('turn.step', async function* () {
      requests++
      yield { kind: 'text' as const, index: 0, text: 'hi' }
      return { turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    const { chunks, failed } = await drain($.turn.step(step()))
    expect(requests).toBe(1)
    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'hi' }])
    expect(failed).toBe(false)
  })
})
