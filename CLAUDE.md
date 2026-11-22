# Session board

A Claude Code mod plus an HTML dashboard. The README covers what it does, how to
install it and how to serve the page. This file is for working on it.

## Layout

- `hooks/register.ts`: the hooks. Every session writes
  `%USERPROFILE%\.claude\board\sessions\<session-id>.json` on each change and a
  heartbeat every 5 s. On session start it copies `dashboard/index.html` to
  `.claude\board\index.html`, and deletes status files in `sessions/` whose
  `updatedAt` is over a week old (`staleBoards` in `lib.ts`), except each
  project's newest (`known_projects` needs it) and each work item's (a plan
  strip reads it). It deletes through `powershell.exe`, since `$.fs` has no
  delete, rechecking each file's age first, with no fallback, so a sandbox's
  mount of `sandboxed/` is left alone.
  Once a minute it runs `PROBE` in `powershell.exe` to sample memory: the
  nearest `claude.exe` above the probe is the session's, found once per load.
  The probe also reads the PC's RAM and commit charge into `machine`; the page
  and the queue use the newest sample any session wrote.
  It runs `powershell.exe` a second time for `az repos pr show`, to look up
  which repo a PR named only by number is in.
  It also registers `board_queue` (deferred, read-only) for planning sessions.
  It reads `queue.json` and the status files through `$.fs`, not through the
  server, and `plannedWork` in `lib.ts` formats the answer. A session counts
  as live on the same 60 s rule as `GONE_MS` in `serve.py`.
  `board_plan` (deferred too) lets an orchestrating session put its plan of
  work items into its status file (`plan`, cleaned by `boardPlan` in `lib.ts`).
  The `gh-orchestrate-delivery` skill calls it when it shows its plan, after
  the go, and whenever the plan changes.
  While the plan has a `gate`, each main turn's end leaves the session waiting
  (`planWaiting`), and the person's next prompt clears the gate.
- `hooks/lib.ts`: the status file's shape (`Board`) and pure helpers. Keep
  anything without `$` here so the tests can call it.
- `hooks/board.test.ts`: tests, run by `claude plugin test .`.
- `dashboard/index.html`: one self-contained page. It lists `sessions/` through
  the directory index that `python -m http.server` serves, polls every 2 s, and
  keys tiles by session id, and group sections (project or work item) by
  group, so CSS animations survive polls. View choices live in `localStorage`.
  The strip above the tiles (`renderToday`) sums today's cost: `costUsd` is a
  running total, so each session counts `costUsd - costDay.usd` when `costDay`
  (set by `costDayOf` in `lib.ts` at the first cost refresh of each local day)
  is today's; a file without `costDay` counts whole only if it started today.
  Sandboxed files never count. A board made fresh after `/clear` or a resume
  keeps the ended board's `costUsd` and `costDay`, and a total that drops
  counts as a reset. It shows the
  **queue** form and list only when `GET api/queue` answers, so it still works
  under `python -m http.server`. It also lists `sandboxed/`, status files that
  sessions in a sandbox write through a mount. Those are untrusted: `defang()`
  cleans each one before anything renders it, because the page puts some
  fields into HTML unescaped. The server never reads `sandboxed/`.
  After each poll `noteTransitions` compares with the previous one and raises
  a desktop notification (`notify`) for a wait it saw begin (once per
  `waiting.since`, which a plan gate keeps through short turns), never for one
  there at the first poll, and, when **long turns** is on, for a turn
  (`noteTurn`, one value of `turns`) that worked 3 min or more: running and
  background count, a wait for you doesn't. Sandboxed files never notify.
  Permission is asked from the header's **turn on**, and only in a secure context.
  A session's `plan` draws as a strip above the tiles of its group (`planOf`
  checks its shape, `planHtml` draws it). Each item's state comes from the
  newest session reporting that work item, one outside a sandbox first.
  A session's work item is `workItemOf` its skill args or prompt: `#1234`, a
  GitHub issue URL in skill args (so `/deliver https://github.com/o/r/issues/12`
  is `12`), an Azure DevOps `_workitems/edit/<id>` URL or a bare 4–7 digit
  number in skill args. Only a delivery or orchestrate skill
  (`skillTakesWorkItem`, by name) reads a URL or bare number from its args,
  a `#1234` counts for any skill but a PR-taking one (`/code-review #1234`
  names no work item), and `/loop 5m /deliver 1234` gives its inner
  command's (`skillWorkItem`). A number inside a date or a word (`2026-10-31`,
  `orch-2024`) never counts, nor a bare 1900–2099 (a year) unless it opens
  the args. Plan items name work items by number alone, so two repos' `#12` in one plan are the same row. The
  board starts nothing from a plan.
- `server/serve.py`: optional stdlib server for the board folder, but `/`
  comes from `dashboard/index.html` in the repo. It turns off `SO_REUSEADDR` on
  Windows, where it would let it bind a port another server holds. It adds
  `api/queue`, a queue of work items in `<board>/queue.json`. A thread starts an
  item as an interactive `claude --session-id <uuid> "<prompt>"` when its
  project (a folder that some status file reports) has a free slot, one by
  default, and frees the slot from that session's status file (`slot_free`).
  Live sessions outside the queue that are on a work item take slots too, by
  the same `slot_free` rules (`outside_sessions`, `busy` per project), but
  not ones with a `plan`, nor ones of items `trim` dropped (`started` in
  `queue.json`). They count against `--max-sessions` only in projects with
  items queued or running.
  The `open` action starts an empty `claude --session-id <uuid>` in a project at
  once, outside the queue: no slot, no memory hold (the page confirms instead).
  The page offers it as **+** on a project group and **new session** by the
  form, matching a group to a project by its sessions' repo root or cwd. It
  takes no free text, checks `Host`, `Origin` and the JSON content type, and
  never answers CORS preflights. GET and HEAD check `Host` too (`local_host`),
  against DNS rebinding; a session's `curl 127.0.0.1:<port>` still passes. Memory pressure in the newest `machine`
  sample holds new starts (`memory_hold`, with hysteresis); the page's strip
  turns orange at the same marks, kept in step by hand (`RAM_HIGH_PCT`).
  Under `pythonw.exe` (the `SessionBoard` scheduled task in the README) it has
  no stdout/stderr, so `log_to_file` sends them to `log_path`, `board-server.log`
  beside the board folder so it isn't served, which `CappedLog` keeps under
  2 MB with its `.1`. It finds that log before parsing the rest of the
  arguments, so their errors land there too, and falls back to the temp folder
  or nothing if it can't open it. Successful requests aren't logged, nor the page's polls of
  a missing `sandboxed/`. Tests in `server/test_serve.py`.

## How the queue knows a session is finished

The hooks register a `board_status` tool (`mcp__session-board__board_status`,
not deferred) whose description tells the model to call it with `done` when the
task it was started with is finished. That sets `done` in the status file, and
the slot frees once the main turn has ended. Otherwise the slot frees after
`--idle-minutes` idle with no scheduled job and no background shell or Monitor
(`shells`, removed by the `<task-notification>` turn that names it, by TaskStop,
when the subagent that started it ends, or after 2 h, since a notification
delivered into a running turn, or to a subagent, never reaches a hook). **Needs you** never frees a slot.

The status file keeps two axes apart: `state` is the activity the hooks
observe, `done` is the task status only the model sets. A prompt after `done`
leaves it standing; only `board_status working` clears it. The tile shows a
**✓ Done** badge (with `+N` prompts since) beside the activity.

`board_status` also takes progress: `phase`, `step` and `of`, `workItem`.
A call without `status` only sets `progress` (`boardStatus` and `progressOf`
in `lib.ts`) and never touches `done`; the tool's description keeps the two
uses apart so a step doesn't get called `done`. A subagent's progress call is
ignored. `done`, a slash command other than `skill.name` (not a job firing)
and `/clear` clear `progress`. A built-in housekeeping command
(`housekeepingCommand` in `lib.ts`: `/reload-plugins`, `/rename`, …) neither
clears it nor replaces `skill`. The tile shows it in place of `phaseOf` while
the session is running, waiting or in the background (an idle one may have stopped),
formatted by `progressText`, which the page and `lib.ts` each keep in step by hand.

The plugin is installed at user scope from a local marketplace (this folder), so
every session runs this working copy. After an edit, run `/reload-plugins` in a
session to pick it up there.

## Checks before committing

```
claude plugin validate .
claude plugin test .
cd server && python -m unittest
cd dashboard && python -m unittest
```

`dashboard/test_dashboard.py` drives the page with Playwright (`pip install
playwright`) in the installed Edge or Chrome, against made-up status files in a
temp folder. Without Playwright or a browser it skips. An SVG arc's box centre
is off the line, so it clicks a point on the path, and it waits for the drawer
to stop sliding before clicking inside it.

Test the server against a scratch board with `--dir <scratch> --port 8799`. Run
it with `claude` off `PATH` to exercise the queue without opening a session: the
item goes `failed` with "claude is not on PATH".

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
- The tab title reaches the tile when a main turn ends: `readTranscript` reads
  it from the transcript then and at session start. Claude Code writes the
  `ai-title` during the first turn, so the tile shows it once that turn ends.
  A `/rename` writes a `custom-title` at once, but runs no turn, so the tile
  changes when the next turn ends. Claude Code keeps appending `ai-title`
  records after a rename; `sessionTitleOf` prefers the newest `custom-title`
  over any of them. Headless sessions get no `ai-title`.
- Scheduled jobs come from `CronCreate`/`CronList`/`CronDelete`/`ScheduleWakeup`
  results. `nextFireAt` includes a per-job offset of up to half the period, so
  later firings are computed from the cron expression plus that offset. A
  firing is a `turn.start` whose text is the job's prompt (`turn.start` has no
  origin; `prompt.submit` does). `$` has no API to list a session's jobs.
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

- Whether a resumed session's `costUsd` restarts at 0 or carries the earlier
  cost. `costDayOf` handles either, as long as the ended status file is there.
  That needs `/clear` and a resume to keep the session id; with a new id the
  old and new files would both count the carried cost.
- An actual start from the queue: the Windows Terminal tab, that
  `--session-id` gives the status file the name the queue waits for, and that
  a delivery run calls `board_status` at its end without being told to.

- Another session's message arrives through `session.receive` (also inside a
  running turn) and, when it starts a turn, as a `turn.start` whose text begins
  `<cross-session-message from="uds:…" from-name="x-57" …>`. Both record it in
  `messages`, kept once by `addMessage`; it is not a prompt. A harness notice
  (`[Cross-session idle notice] "x-57" …`) is not a prompt either.
  `session.send` records what this session sent, once delivered, unless it
  went to `main`, a subagent's id or a `name@team` teammate.
- A session's name in `ListAgents` (`session-board-f4`) can't be derived from
  its session id, and no API gives it. The page learns it by pairing a sent
  message with its receipt in another file (`buildFlows`).

## Not verified yet (messages)

- That `session.receive`'s `text` carries the `<cross-session-message>`
  envelope. If it doesn't, a message that arrives during a running turn is
  missed. One that starts a turn is still caught by `turn.start`.

## Ideas not built

Open ideas and follow-ups are GitHub issues, not lines here.
