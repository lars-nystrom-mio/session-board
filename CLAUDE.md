# Session board

A Claude Code mod plus an HTML dashboard. The README covers what it does, how to
install it and how to serve the page. This file is for working on it.

## Layout

- `hooks/register.ts`: the hooks. Every session writes
  `%USERPROFILE%\.claude\board\sessions\<session-id>.json` on each change and a
  heartbeat every 5 s. On session start it copies `dashboard/index.html` to
  `.claude\board\index.html`.
  Once a minute it runs `PROBE` in `powershell.exe` to sample memory: the
  nearest `claude.exe` above the probe is the session's, found once per load.
  It runs `powershell.exe` a second time for `az repos pr show`, to look up
  which repo a PR named only by number is in.
- `hooks/lib.ts`: the status file's shape (`Board`) and pure helpers. Keep
  anything without `$` here so the tests can call it.
- `hooks/board.test.ts`: tests, run by `claude plugin test .`.
- `dashboard/index.html`: one self-contained page. It lists `sessions/` through
  the directory index that `python -m http.server` serves, polls every 2 s, and
  keys tiles by session id so CSS animations survive polls.

The plugin is installed at user scope from a local marketplace (this folder), so
every session runs this working copy. After an edit, run `/reload-plugins` in a
session to pick it up there.

## Checks before committing

```
claude plugin validate .
claude plugin test .
```

Type-check against the engine's API types. When a session loads the mod with
`claude --plugin-dir .`, the engine writes them to `.claude-plugin/types/`
(gitignored); the plugin-authoring skill also prints a path to them. Use a
tsconfig with `strict` and `noUncheckedIndexedAccess`, and
`npx -y -p typescript@5.6.3 tsc -p <tsconfig>`.

To smoke-test without touching your real board, run a headless session that
writes to a scratch folder:

```
SESSION_BOARD_DIR=<scratch dir> claude -p --plugin-dir . --model haiku "<prompt that uses a tool or an Agent>"
```

## Rules the validator and engine enforce

- Pass `$` only to functions declared at the top level of the file, and always
  call it as `$.noun.method(...)`. Don't store it in a variable or alias it.
  `claude plugin validate` refuses anything else.
- Every hook only observes. Gating hooks (`tool.call`, `agent.spawn`, classic
  events) end with `.catch(($, e, next) => next(e))`, so a bug in the board can
  never block a tool call.
- In tests, a hook that answers `tool.call` returns `{ result }`.
- `turn.step` streams: its hook and its `.catch` handler are both
  `async function*`, and forward the stream with `yield* next(e)`.

## What the events look like in practice

- A subagent's report back to the main loop arrives as a `turn.start` whose text
  begins with `<agent-message from="…">`. It's not a user prompt, and
  `turnStarted` records it as an agent event.
- A slash command arrives as `<command-message>…</command-message>`,
  `<command-name>/x</command-name>` and `<command-args>…</command-args>` markup.
  `slashCommand()` in `lib.ts` parses both that and plain `/x args`.
- `turn.complete` with an `agentId` is a subagent finishing. The heartbeat also
  syncs from `$.agent.list()` while any agent is running.
- `SubagentHandback` is an internal tool; it's in `QUIET_TOOLS`.
- A plugin's classic hooks don't run. `cc-plugin-sec-default`, a plugin built
  into Claude Code, takes `classic.SessionStart`, `classic.UserPromptSubmit`,
  `classic.Notification` and `classic.PermissionRequest` first and sends them
  on past every user plugin, and the session shows "its classic.… hook was
  skipped". So the transcript path is computed from the session id, and the
  **needs you** state covers only `AskUserQuestion` and `ExitPlanMode`, which
  arrive through `tool.call`. A tile doesn't turn pink on a permission prompt.

## Windows gotchas

- In Git Bash `~` can be `H:\`, not the profile folder. Use `$USERPROFILE` or
  the full `C:/Users/...` path for anything under `.claude`.
- Git Bash rewrites a prompt like `"/rename x"` into a Windows path. Set
  `MSYS_NO_PATHCONV=1` for that, and then pass Windows-style paths
  (`C:\...`) in `SESSION_BOARD_DIR`, or the board lands in `C:\c\...`.
- Writing regexes through a bash heredoc into Python mangled `\b` into a
  backspace character. Edit TypeScript with the Edit tool instead.

## Not verified yet

- The tab title on a live interactive tile. `readTitle` reads the newest
  `custom-title` or `ai-title` record from the transcript at session start and
  when a main turn ends. A headless `/rename` showed up on the tile; headless
  sessions get no `ai-title`.

## Ideas not built

- Delete status files of long-ended sessions. `$.fs` has no delete, so this
  would need `$.process.run`, or the dashboard keeps hiding them after 24 h.
- A `board_status` tool that skills call to report exact phases, instead of
  phases inferred from subagent types (`DEFAULT_PHASES` and `phases.json`).
- Run the server outside a Claude session, for example as a scheduled task at
  logon.
