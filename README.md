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
projects. Only queued items count against these limits, not sessions you start
yourself.

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
`--dir` work as you'd expect.

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
| **idle** | done, your move |
| ended / no heartbeat | under "Ended or gone"; no heartbeat for 20 s means the session crashed or was closed |

Each tile also shows the project and branch, the name on the session's
terminal tab (the title Claude Code gives the session, or the one set with
`/rename`), the work item and skill (when a
skill such as `/deliver-story 1234` is running), a phase inferred from the
running subagent, the tools in flight with live timers, the subagents with
their status, and context use, cost and turn count. Click a tile for the
prompt, the agent list, the full timeline and a `claude --resume` line to copy.

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

Phases come from the newest running subagent's type, then from the running
skill. Out of the box:

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

The work item is taken from the skill's arguments (`deliver 1234` →
`#1234`) or a `#1234` in the prompt.

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

Status files of ended sessions are never deleted by the mod. The dashboard hides
them after 24 hours; delete `~/.claude/board/sessions/*.json` whenever you like.

## Licence

MIT. See [LICENSE](LICENSE).
