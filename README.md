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

## What a tile shows

| State | Meaning |
| --- | --- |
| **needs you** (pink, glowing, sorted first) | a permission prompt, a question, or a plan waiting for approval |
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
```

Status files of ended sessions are never deleted by the mod. The dashboard hides
them after 24 hours; delete `~/.claude/board/sessions/*.json` whenever you like.

## Licence

MIT. See [LICENSE](LICENSE).
