# Session board

One dashboard for every Claude Code session running on this machine: what each
one is doing, which subagents it has running, and which ones are waiting for you.

It has two parts:

- **A Claude Code mod** (`hooks/`) that loads in every session. Each session
  writes its own status file, `~/.claude/board/sessions/<session-id>.json`, as
  things happen, plus a heartbeat every 5 seconds.
- **An HTML dashboard** (`dashboard/index.html`) that reads those files every
  2 seconds. The mod copies it to `~/.claude/board/index.html` when a session
  starts, so the served page always matches this repo.

Nothing is sent anywhere. The files stay in `~/.claude/board/`.

## Install

Clone the repo and add the folder as a marketplace:

```
git clone https://github.com/lars-nystrom-mio/session-board.git
claude plugin marketplace add ./session-board
claude plugin install session-board@session-board --scope user
```

The marketplace is the cloned folder, so Claude Code reads the plugin from here, not
from a copy. After a `git pull` or an edit, run `/reload-plugins` in the
sessions you want to pick it up. Sessions started later load it on their own.

While developing, `claude --plugin-dir <path to session-board>` loads it in
one session and reloads it on every save.

## Run the dashboard

PowerShell:

```powershell
python -m http.server 8765 --bind 127.0.0.1 -d "$env:USERPROFILE\.claude\board"
```

macOS or Linux:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 -d ~/.claude/board
```

Open <http://127.0.0.1:8765/>. On Windows, don't use `~` in Git Bash: its home
can be a different drive than your profile, and the server then serves an empty
folder.

Serve only the board folder, never `.claude` itself: that holds your
credentials and every session's transcript.

`python -m http.server` answers any `Host`, so while it runs, a web page that
points its own name at 127.0.0.1 (DNS rebinding) can read your status files.
The bundled server below refuses every request not addressed to `127.0.0.1` or
`localhost`; prefer it when you can.

### Plans from orchestrating sessions

A session that runs several work items as separate sessions, such as one running
an orchestrate skill, can show its plan on the board through the
`board_plan` tool. The plan appears above that session's tile, in its group. It
has one row per work item, with lines on the left joining an item to the items
it waits for. Each row takes its state from the session working on that work
item: running, needs you, done or ended. Rows without a session show whether the
item starts on your go, waits for another item, is on hold or is skipped.
Clicking a row opens its session. A row finds its session by work item number: the
session's `#1234` in its prompt, or the issue URL or number its skill was started
with, such as `/deliver https://github.com/owner/repo/issues/12`.

While the plan waits for your go or your answers, the orchestrating session
counts as **needs you** and its questions show on the plan. Your next prompt in
that session clears this. The board only shows the plan; it starts nothing, and
it works under `python -m http.server` too. The tool is deferred, so sessions
that never plan get no extra context.

#### Writing an orchestrator skill for the board

The board draws what the plan says and fills in each row from the session on
that work item. A skill that keeps to these rules gets a plan that stays right
without being told about progress:

- **Send the whole plan each time.** Each call replaces the last one. Call it
  when the plan itself changes: when you show it, after the go, when items are
  added, held, released, reordered or skipped, and with `clear: true` when the
  run is over. Don't call it to report progress: a row reads running, needs
  you, done or ended from its session.
- **Name each item by its number alone**: `12`, not `owner/repo#12` or a URL,
  which are dropped. That number is how the row finds its session, so start
  each session with the number in its prompt (`#1234`) or its skill args (an
  issue URL, or a 4–7 digit number). Two repos' `#12` in one plan share a row.
- **Pick the start that says why an item waits.** `now`: nothing to wait for
  (it shows "starts on your go" while the plan waits for one). `later` with
  `after`: it waits for items in the plan, and the row clears once each of
  those sessions reports done. `hold` with a one-line `reason` (shown on
  hover): it waits for something the board can't see, such as an issue outside
  the plan, a cycle, the person, or a question (`question` is its 1-based
  number in `questions`). `skip` with a `reason`: it gets no session.
- **Mind what done means.** `after` clears when the blocker's session calls
  `board_status` with `done`, which a delivery may do once its PR is open for
  review. If your skill waits for the merge instead, put the items that wait on
  that blocker on `hold` ("waits for #12 to merge") until it merges.
- **One session for several issues:** give the issue the session is started
  with a row, and each other issue a `skip` row ("in #12's PR"), so the
  whole set shows.
- **Waiting for the go:** `waitingForGo: true` or any `questions` shows the
  orchestrator as **needs you** and lists the questions. The person's next
  prompt clears that; call again without `waitingForGo` once the plan goes
  ahead, and keep any question you ask again.
- `proposed: true` marks an order you suggested that the person hasn't
  approved yet. `type` is a short label (`Bug`, `User Story`, `Task`, …).

The tool is deferred: load it through tool search (`board_plan`), and skip
it when it isn't there, so the skill still runs without the board. A plan
waiting for the go, in which #13 waits for #12, #14 waits for an outside issue
and #15 ships in #12's PR:

```json
{
  "title": "Search improvements",
  "workItem": "10",
  "waitingForGo": true,
  "questions": ["Should #16 keep the old endpoint?"],
  "items": [
    { "workItem": "12", "title": "Index titles", "type": "Bug", "start": "now" },
    { "workItem": "13", "title": "Rank by recency", "start": "later", "after": ["12"] },
    { "workItem": "14", "title": "Search tags", "start": "hold", "reason": "waits on other/repo#9, outside the plan" },
    { "workItem": "16", "title": "New endpoint", "start": "hold", "question": 1 },
    { "workItem": "15", "title": "Index aliases", "start": "skip", "reason": "in #12's PR" }
  ]
}
```

### Queue work items from the board

On Windows, serve the page with the bundled server instead, from this repo:

```powershell
python server\serve.py
```

Stop `python -m http.server` first: both use port 8765. It serves the same
folder, except that the page itself comes from the repo, so an edit shows on the
next reload. It adds a **queue** form to the header: pick a project, type a work
item number, and the item joins the queue. When the project has a free slot, the
server opens `claude "deliver #1234"` in that folder in a new Windows Terminal
tab (a new console window without Windows Terminal). The session shows up as a
tile like any other, with the work item on it from the start.

A project runs one queued item at a time unless you raise its limit with the
select next to it. Raise it only for repos where parallel sessions don't trip
over each other: two sessions in one working copy share its checkout, its ports
and its build output. `--max-sessions` (4) caps queued sessions across all
projects. A session you start yourself counts too, once it is on a work item
(say you ran `/deliver 1234` in that repo): while it would hold a slot by the
rules below, a queued item for the same project waits for it. A session without
a work item, such as a plain chat in the repo, doesn't count, and neither does a
session started with **new session** until it picks up a work item, or an
orchestrating session with a plan. Against `--max-sessions` such a session
counts only while its project has items queued or running.

A slot frees when the session is finished:

- it called the board's `board_status` tool with `done` and its turn ended. The
  plugin offers the tool to every session, and its description asks the model
  to call it when the task it was started with is finished;
- or it has sat idle for `--idle-minutes` (15) with no background command,
  monitor or scheduled job pending. A session that **needs you** keeps its slot;
- or it ended, or stopped writing its status file.

The list above the tiles shows what runs, what waits (move an item to the front
or cancel it) and what just finished and why. **release** frees a running item's
slot by hand. The queue is kept in `queue.json` in the board folder, so it
survives a restart of the server.

Any session can read what is already planned through the board's `board_queue`
tool. It lists the work items that are queued or running from the queue, plus
those that other live sessions are on, by project, and takes an optional
`project` to show just one. It's read-only, it gives numbers without titles,
and it reads `queue.json` directly, so the server doesn't have to be running.
The tool is deferred, so a session finds it through tool search when it plans
work, and other sessions get no extra context.

Under memory pressure, from 90% RAM or 85% commit charge, the queue holds: no new
item starts until both drop below 85% and 80%. Queued items say so. Without a
fresh memory sample (one from the last 3 minutes) the queue never holds.

To start an empty session instead, click **+** on a project's group header (with
the board grouped by project) or **new session** next to the queue form. It opens
`claude` in that folder right away, in a new tab like a queued item, but it isn't
a queue item: it takes no slot and the queue's limits don't apply. Under memory
pressure the page asks before it opens one.

Change what a session is started with using `--prompt "/my-skill #{id}"` (keep
the `#` so the tile can read the number before the skill runs); `--port` and
`--dir` work as you'd expect. A new tab takes its icon from the Windows Terminal
profile named by `--wt-profile` (`PowerShell`); without one it gets the plain
console icon. Started from a Claude session, the server drops the `NO_COLOR=1`
that Claude's shell sets, so sessions it starts keep their colors.

To have the server run from logon, independent of any Claude session, register
it as a scheduled task for your user. It has to run only while you're logged on,
not as a service, so that it can open tabs on your desktop. `pythonw.exe` (next
to `python.exe`) runs it without a console window; it then logs errors and queue actions to
`board-server.log` beside the board folder (`%USERPROFILE%\.claude\board-server.log`),
not in it, so the server never serves it. The log keeps only the newest 1–2 MB, in it and
`board-server.log.1`.

```powershell
$py = Join-Path (Split-Path (python -c "import sys;print(sys.executable)")) pythonw.exe
$me = "$env:USERDOMAIN\$env:USERNAME"
Register-ScheduledTask -TaskName SessionBoard -Force `
  -Action (New-ScheduledTaskAction -Execute $py -Argument 'server\serve.py' -WorkingDirectory (Resolve-Path .)) `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) `
  -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
     -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew)
schtasks /Run /TN SessionBoard   # start it now; stop any other server on 8765 first
```

Run it from the repo folder. `schtasks /End /TN SessionBoard` stops it.
`-RestartCount` only retries a start that fails: if the server exits later,
Task Scheduler leaves it stopped until the next logon. Look in the log for why,
then `schtasks /Run /TN SessionBoard` starts it again.

The projects are the folders that sessions on the board have run in (the repo's
root when there is one). The form and the **+** appear once there is at least
one. The server takes only a work item number and one of those folders, and refuses requests
from any page but the board itself.

## What a tile shows

| State | Meaning |
| --- | --- |
| **needs you** (pink, glowing, sorted first) | a question or a plan waiting for approval (not a permission prompt: Claude Code skips the hooks that would see one) |
| **running** (cyan sweep) | the main loop is working on a prompt |
| **agents running** (purple sweep) | your turn is over, but background subagents are still working |
| **stalled** (yellow, the sweep stops) | still running and its heartbeat arrives, but a main-loop tool has run past its limit (Bash, PowerShell and REPL 20 min, Poll, Agent and Workflow 60 min, WebFetch and WebSearch 3 min, others 5 min), or nothing is in flight and the page has seen nothing new for 10 min. The limits are `TOOL_LIMIT_MS` and `STALL_MS` in `dashboard/index.html` |
| **idle** | done, your move |
| ended / no heartbeat | under "Ended or gone"; no heartbeat for 20 s means the session crashed or was closed |

Each tile also shows the project and branch, the name on the session's
terminal tab (the title Claude Code gives the session, or the one set with
`/rename`), the work item and skill (when a
skill such as `/deliver-story 1234` is running), the progress the session
reported or else a phase inferred from the running subagent, the tools in flight with live timers, the subagents with
their status, and context use, cost and turn count. Click a tile for the
prompt, the agent list, the full timeline and a `claude --resume` line to copy.

A strip above the tiles shows today's totals: what every session spent since
local midnight, ended ones included, how many sessions are active and how many
need you. Hover the cost for the split per project. A session counts only what
it spent today, from the cost it had when the day began. A status file written
by an older version of the hooks has no such baseline: it counts whole if the
session started today, and not at all otherwise. Sessions in a sandbox never
count, since their status files can claim anything. A `+` after the cost and
the hover text point out sessions left out.

### Desktop notifications

While you work in a terminal you won't see the tab's title or favicon change.
Click **turn on** beside **notify** in the header and allow notifications, and
the board raises a desktop notification when a session starts needing you: the
project, the terminal tab's name and the reason (a question or a plan to
approve, with its text). Clicking it brings the board forward with that
session's drawer open. It notifies once per wait (a plan's gate counts as one
wait however many short turns run while it's open), and not for sessions that
were already waiting when the page loaded. **long turns** adds one when a turn
that ran 3 minutes or longer ends. **mute** silences both. Both stay set in the
browser. A permission prompt still can't be seen (see the table above), and
the page has to be open in a tab, served from `127.0.0.1` or `localhost`
(browsers allow notifications only there or over HTTPS). A tab in the
background polls every 15 s, and browsers slow its timers further after a few
minutes, so a notification can come up to a minute late.

On Windows a tile also shows the session's memory: its `claude.exe` plus
everything it started (MCP servers, running shell commands), sampled once a
minute through PowerShell, with a two-hour trend line. It turns orange at 1 GB.
The drawer breaks it down per MCP server and shows how much `claude.exe` has
grown since the first sample.

The same sample reads the whole PC: a line under the counts shows RAM in use,
the share of it Claude's sessions take, and commit charge (what processes have
been promised, against RAM plus the page file). It turns orange from 90% RAM or
85% commit. Click it for every live session ranked by memory, biggest first, to
pick one to close.

A session that scheduled its own wakeups (`CronCreate`, `/loop`,
`ScheduleWakeup`) shows ⏱ and a countdown to the next one, with every job on
hover. The drawer lists each job's schedule, prompt and next firing. The board
sees jobs created while it was loaded, or all of them once the session calls
`CronList`; jobs that outlive the session (`durable`) aren't shown.

Sessions that message each other (`SendMessage` to a name from `ListAgents`)
get a ✉ badge with the count, and the header shows **✉ N messages**. Click
either for a graph of the live sessions with an arrow from sender to receiver:
thicker for more messages, blue for one in the last 10 minutes. Below it are
the messages themselves. Click an arrow or a session to see only its messages.
The other session's name (`session-board-57`) says nothing about which session
it is. The board learns it by pairing a message one session sent with the same
message arriving in another. Messages sent before this version have no record
of the send. Their sender is guessed from the name's project when one session
of that project was up at the time, and their arrow is dotted. A sender the
board can't place shows as a hollow node. Sessions in a sandbox are left out
of the graph.

A skill can report where it is through the board's `board_status` tool, by
calling it without a `status` and with `phase` (free text, such as
"Reviewing"), `step` and `of` (story 3 of 7) and `workItem` (the item it is on
now). The tile then shows **Reviewing · 3/7 · #25229** in place of the inferred
phase while the session is at work (running, waiting or in the background; an
idle tile drops it), and the drawer shows it with when it was reported. Each call replaces the last
report, and only the main conversation's reports count, not a subagent's. A
progress report never marks the task done. `done`, a slash command other than
the running skill or `/clear` clears it. The skill has to be told to call it; nothing
here makes it.

Without a report, phases come from the newest running subagent's type, then
from the running skill. Out of the box:

| Running | Phase |
| --- | --- |
| a subagent with `review` in its type | Reviewing |
| `Explore`, `Plan` | Exploring |
| `general-purpose` | Working |
| a skill with `review` in its name | Reviewing |
| any other subagent | its type |

To add your own, put a `phases.json` in the board folder
(`~/.claude/board/phases.json`, next to `index.html`). Its rules are tried
before the defaults, top to bottom. `agent` and `skill` are case-insensitive
regular expressions:

```json
[
  { "agent": "^code-writer$", "phase": "Implementing" },
  { "agent": "^ci-watcher$", "phase": "Waiting on pipeline" },
  { "skill": "^deploy", "phase": "Deploying" }
]
```

The dashboard reads it once when the page loads; reload the page after editing.
A missing or broken file leaves the defaults.

The work item is taken from the arguments of a delivery or orchestrate skill
(`/deliver 1234` → `#1234`) or a `#1234` in the prompt. Another skill's bare
number is not a work item, and neither is any number given to a review or PR
skill, such as the PR in `/code-review high 1234` or `/code-review #1234`.

## Sessions in a sandbox

A session in a Docker sandbox (`sbx`) can show up on the board on your PC too.
Install the plugin in the sandbox, mount the board's `sandboxed/` folder (create
it first) at `<dir>/sessions` inside the sandbox, and set `SESSION_BOARD_DIR` to
`<dir>` there. Mount only `sandboxed/`, never the board folder or `sessions/`.

The board treats `sandboxed/` as untrusted, since the sandbox can write anything
there. The page strips every string of the characters that could inject markup,
keeps only `https` PR links, drops memory samples and ignores a file that takes
the id of a session on this PC. Its tiles carry a **sandbox** badge and offer no
`claude --resume` line. The server never reads `sandboxed/`, so a sandbox can't
add a project, free a slot or hold the queue.

## Settings

| Environment variable | Effect |
| --- | --- |
| `SESSION_BOARD_DIR` | write the board somewhere other than `~/.claude/board` |
| `CLAUDE_CONFIG_DIR` | honoured: the board goes in `<config dir>/board` |

## Develop

```
claude plugin validate .
claude plugin test .
cd server && python -m unittest
```

The dashboard hides status files of ended sessions after 24 hours, and each
session start deletes the ones in `sessions/` that no session has written for a
week. Each project's newest file stays, so the queue still knows the project,
and so does each work item's, so a plan strip still shows it done. Deleting
goes through `powershell.exe`, so it happens on Windows only; `sandboxed/` is
never cleaned.

## Licence

MIT. See [LICENSE](LICENSE).
