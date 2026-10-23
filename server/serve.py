"""Serves the session board and runs a queue of work items, a Claude Code session each.

    python server/serve.py [--port 8765] [--dir <board folder>] [--prompt "deliver #{id}"]
                           [--max-sessions 4] [--idle-minutes 15]

GET serves the board folder like `python -m http.server`, directory index
included, so the page reads `sessions/` the same way.

GET  api/queue -> {"prompt", "maxSessions", "projects": [{"path", "name", "max"}], "items": [...]}
POST api/queue {"action": "add", "workItem": "1234", "cwd": "<a path from projects>"}
               {"action": "cancel" | "first" | "release", "id": "<item id>"}
               {"action": "limit", "cwd": "<a path from projects>", "max": 2}

An item starts when its project has a free slot (one by default, as two
sessions in one working copy get in each other's way) and fewer than
--max-sessions items run in all. Starting one opens an interactive
`claude --session-id <id> "<prompt>"` in its folder, in a new Windows Terminal
tab (or a new console window without it). The session then writes its own
status file, which says when the slot is free again: the session called the
board's board_status tool with "done" and its turn ended; it sat idle for
--idle-minutes with nothing in the background or scheduled; it ended; or it
stopped writing. "release" frees a slot by hand. Only items count against the
limits, not sessions started some other way. The queue is kept in queue.json in
the board folder, so a restart picks it up.

Only a work item number and one of the projects that sessions have reported can
be sent: the server never runs text from a request.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WORK_ITEM = re.compile(r"^\d{1,9}$")
ITEM_ID = re.compile(r"^[0-9a-f]{12}$")
MAX_PER_PROJECT = 8
TICK_S = 5
GONE_MS = 60_000  # a status file this old belongs to a session that is gone
START_MS = 180_000  # a started item with no status file after this never came up
KEEP_ENDED = 20  # finished, failed and cancelled items kept for the page
# The page from this repo rather than the board folder's copy, which a session
# only refreshes when it starts.
PAGE = Path(__file__).resolve().parent.parent / "dashboard" / "index.html"


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server bind a port already in use and
    # never see a request; without it, a busy port fails at startup.
    allow_reuse_address = os.name != "nt"


def default_board_dir() -> Path:
    if os.environ.get("SESSION_BOARD_DIR"):
        return Path(os.environ["SESSION_BOARD_DIR"])
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(config) / "board" if config else Path.home() / ".claude" / "board"


def known_projects(board: Path) -> list[dict]:
    """The folders sessions have run in, newest first: a repo's root, else the cwd."""
    seen: dict[str, dict] = {}
    for f in (board / "sessions").glob("*.json"):
        try:
            s = json.loads(f.read_text(encoding="utf-8"))
            path = (s.get("repo") or {}).get("root") or s["cwd"]
            name = (s.get("repo") or {}).get("name") or s.get("project") or path
            at = s.get("updatedAt") or 0
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue  # mid-write or malformed
        if not isinstance(path, str) or not os.path.isabs(path):
            continue
        key = os.path.normcase(os.path.normpath(path))
        if key not in seen or at > seen[key]["at"]:
            seen[key] = {"path": os.path.normpath(path), "name": name, "at": at}
    return [{"path": p["path"], "name": p["name"]} for p in sorted(seen.values(), key=lambda p: -p["at"])]


def same_origin(headers, port: int) -> str | None:
    """Why a request didn't come from the board page itself, or None if it did.

    The Host check stops DNS rebinding. The JSON content type makes a browser
    send a preflight first, which this server never answers with CORS headers.
    """
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    host = headers.get("Host", "")
    if host not in hosts:
        return f"unexpected Host {host!r}"
    origin = headers.get("Origin")
    if origin is not None and origin != f"http://{host}":
        return f"unexpected Origin {origin!r}"
    if (headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
        return "Content-Type must be application/json"
    return None


def key(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def check_project(body, projects: list[dict]) -> dict:
    """The project a request names by its `cwd`; raises ValueError otherwise."""
    if not isinstance(body, dict):
        raise ValueError("expected a JSON object")
    cwd = body.get("cwd")
    match = [p for p in projects if isinstance(cwd, str) and key(cwd) == key(p["path"])]
    if not match:
        raise ValueError("cwd is not a folder any session has run in")
    return match[0]


def check_launch(body, projects: list[dict]) -> tuple[str, str]:
    """The work item and folder of a request to queue one; raises ValueError otherwise."""
    project = check_project(body, projects)
    item = str(body.get("workItem", "")).strip().lstrip("#")
    if not WORK_ITEM.match(item):
        raise ValueError("workItem must be a work item number")
    if not os.path.isdir(project["path"]):
        raise ValueError(f"{project['path']} no longer exists")
    return item, project["path"]


def check_id(body) -> str:
    item_id = body.get("id") if isinstance(body, dict) else None
    if not isinstance(item_id, str) or not ITEM_ID.match(item_id):
        raise ValueError("id must be a queue item id")
    return item_id


def check_max(body) -> int:
    n = body.get("max")
    if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= MAX_PER_PROJECT:
        raise ValueError(f"max must be a number from 1 to {MAX_PER_PROJECT}")
    return n


def slot_free(board: dict | None, started_at: int, now: int, idle_ms: int) -> str | None:
    """Why a running item's session no longer holds its slot, or None while it does.

    `board` is the session's status file, None until it writes one.
    """
    if board is None:
        return "never started" if now - started_at > START_MS else None
    state = board.get("state")
    if state == "ended":
        return "ended"
    if now - (board.get("updatedAt") or 0) > GONE_MS:
        return "gone"
    if state != "idle":
        return None  # running, needs you, or agents running
    if board.get("done"):
        return "done"
    busy = any(c.get("nextAt") for c in board.get("crons") or []) or board.get("shells")
    if not busy and now - (board.get("stateSince") or now) >= idle_ms:
        return "idle"
    return None


def advance(queue: dict, boards: dict, now: int, idle_ms: int, max_sessions: int) -> list[dict]:
    """Frees the slots of running items whose sessions are finished, then marks
    queued items running, in order, while there's room. Returns the items to
    start; the caller starts them, and marks one failed if that fails.

    `boards` maps a session id to its status file, for the running items' sessions.
    """
    for item in queue["items"]:
        if item["state"] != "running":
            continue
        reason = slot_free(boards.get(item["sessionId"]), item["startedAt"], now, idle_ms)
        if reason:
            item.update(state="finished", endedAt=now, endedBy=reason)
    running = [i for i in queue["items"] if i["state"] == "running"]
    starting = []
    for item in queue["items"]:
        if item["state"] != "queued" or len(running) >= max_sessions:
            continue
        here = sum(1 for i in running if key(i["cwd"]) == key(item["cwd"]))
        if here >= queue["limits"].get(key(item["cwd"]), 1):
            continue
        item.update(state="running", startedAt=now, sessionId=str(uuid.uuid4()))
        running.append(item)
        starting.append(item)
    return starting


def trim(queue: dict) -> None:
    """Keeps every open item and the newest of the rest."""
    ended = sorted((i for i in queue["items"] if i["state"] not in ("queued", "running")),
                   key=lambda i: i.get("endedAt") or 0)
    drop = {id(i) for i in ended[:max(0, len(ended) - KEEP_ENDED)]}
    queue["items"] = [i for i in queue["items"] if id(i) not in drop]


def child_env() -> dict:
    """This environment minus what marks a process as running inside Claude Code,
    for when the server itself was started from a session."""
    return {k: v for k, v in os.environ.items()
            if not (k == "CLAUDECODE" or k.startswith("CLAUDE_CODE_"))}


def launch_command(claude: str, cwd: str, prompt: str, session_id: str, wt: str | None) -> list[str]:
    args = [claude, "--session-id", session_id, prompt]
    if wt:
        # wt splits its command line on ';' into several commands.
        return [wt, "-w", "0", "new-tab", "-d", cwd, *args[:-1], prompt.replace(";", "\\;")]
    return args


def launch(cwd: str, prompt: str, session_id: str) -> None:
    if os.name != "nt":
        raise NotImplementedError("starting a session is only implemented on Windows")
    claude = shutil.which("claude")
    if not claude:
        raise FileNotFoundError("claude is not on PATH")
    cmd = launch_command(claude, cwd, prompt, session_id, shutil.which("wt"))
    flags = subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(cmd, cwd=cwd, env=child_env(), creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Queue:
    """The queue in <board>/queue.json, changed under one lock."""

    def __init__(self, board: Path, prompt: str, idle_ms: int, max_sessions: int, start=launch):
        self.board = board
        self.path = board / "queue.json"
        self.prompt = prompt
        self.idle_ms = idle_ms
        self.max_sessions = max_sessions
        self.start = start
        self.lock = threading.Lock()

    def load(self) -> dict:
        try:
            q = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(q, dict) and isinstance(q.get("items"), list) and isinstance(q.get("limits"), dict):
                return q
        except (OSError, ValueError):
            pass
        return {"limits": {}, "items": []}

    def save(self, q: dict) -> None:
        trim(q)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(q, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    def read_board(self, session_id: str) -> dict | None:
        try:
            board = json.loads((self.board / "sessions" / f"{session_id}.json").read_text(encoding="utf-8"))
            return board if isinstance(board, dict) else None
        except (OSError, ValueError):
            return None  # not written yet, or mid-write

    def step(self, q: dict) -> None:
        """Advances `q` and starts what may start; call it with the lock held."""
        boards = {i["sessionId"]: self.read_board(i["sessionId"]) for i in q["items"] if i["state"] == "running"}
        now = int(time.time() * 1000)
        for item in advance(q, {k: v for k, v in boards.items() if v is not None}, now, self.idle_ms, self.max_sessions):
            prompt = self.prompt.replace("{id}", item["workItem"])
            try:
                self.start(item["cwd"], prompt, item["sessionId"])
            except (OSError, NotImplementedError) as e:
                item.update(state="failed", endedAt=now, error=str(e))

    def tick(self) -> None:
        with self.lock:
            q = self.load()
            before = json.dumps(q)
            self.step(q)
            if json.dumps(q) != before:
                self.save(q)

    def view(self, projects: list[dict]) -> dict:
        with self.lock:
            q = self.load()
        return {
            "prompt": self.prompt,
            "maxSessions": self.max_sessions,
            "projects": [{**p, "max": q["limits"].get(key(p["path"]), 1)} for p in projects],
            "items": q["items"],
        }

    def act(self, body, projects: list[dict]) -> dict:
        """Applies one POST and returns the item it touched; raises ValueError
        for a bad or impossible request."""
        action = body.get("action") if isinstance(body, dict) else None
        now = int(time.time() * 1000)
        with self.lock:
            q = self.load()
            item = {}
            if action == "add":
                work_item, cwd = check_launch(body, projects)
                if any(i["workItem"] == work_item and key(i["cwd"]) == key(cwd) and i["state"] in ("queued", "running")
                       for i in q["items"]):
                    raise ValueError(f"#{work_item} is already queued or running there")
                name = next(p["name"] for p in projects if p["path"] == cwd)
                item = {"id": uuid.uuid4().hex[:12], "workItem": work_item, "cwd": cwd, "name": name,
                        "state": "queued", "queuedAt": now}
                q["items"].append(item)
            elif action == "limit":
                project = check_project(body, projects)
                q["limits"][key(project["path"])] = check_max(body)
            elif action in ("cancel", "first", "release"):
                item_id = check_id(body)
                found = next((i for i in q["items"] if i["id"] == item_id), None)
                wanted = "running" if action == "release" else "queued"
                if not found or found["state"] != wanted:
                    raise ValueError(f"no {wanted} item {item_id}")
                item = found
                if action == "cancel":
                    item.update(state="cancelled", endedAt=now)
                elif action == "release":
                    item.update(state="finished", endedAt=now, endedBy="released")
                else:
                    q["items"].remove(item)
                    q["items"].insert(0, item)
            else:
                raise ValueError("action must be add, cancel, first, release or limit")
            self.step(q)
            self.save(q)
            return item


class Handler(SimpleHTTPRequestHandler):
    board: Path
    port: int
    queue: Queue

    def send_json(self, status: int, data) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/queue":
            return self.send_json(200, self.queue.view(known_projects(self.board)))
        if path in ("/", "/index.html") and PAGE.is_file():
            body = PAGE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(body)
        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/queue":
            return self.send_json(404, {"error": "not found"})
        refused = same_origin(self.headers, self.port)
        if refused:
            return self.send_json(403, {"error": refused})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 4096)) or b"null")
            item = self.queue.act(body, known_projects(self.board))
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        self.log_message("queue %s %s", body.get("action"), json.dumps(item))
        self.send_json(200, item)


def run_queue(queue: Queue) -> None:
    while True:
        try:
            queue.tick()
        except Exception as e:  # keep the queue going: the next tick tries again
            print(f"queue: {e!r}", file=sys.stderr, flush=True)
        time.sleep(TICK_S)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dir", type=Path, default=default_board_dir(), help="the board folder")
    # The '#' lets the tile show the work item from the first prompt, before a skill runs.
    ap.add_argument("--prompt", default="deliver #{id}",
                    help="what a new session is started with; {id} is the work item number")
    ap.add_argument("--max-sessions", type=int, default=4, help="queued work items running at once, all projects together")
    ap.add_argument("--idle-minutes", type=float, default=15,
                    help="a queued session idle this long, with nothing in the background, frees its slot")
    args = ap.parse_args()
    if "{id}" not in args.prompt:
        sys.exit("--prompt must contain {id}")
    board = args.dir.resolve()
    board.mkdir(parents=True, exist_ok=True)
    queue = Queue(board, args.prompt, int(args.idle_minutes * 60_000), args.max_sessions)
    handler = type("BoardHandler", (Handler,), {"board": board, "port": args.port, "queue": queue})
    try:
        server = Server(("127.0.0.1", args.port), partial(handler, directory=str(board)))
    except OSError as e:
        sys.exit(f"Can't listen on 127.0.0.1:{args.port} ({e.strerror}). Is another server, "
                 f"such as python -m http.server, still running on it?")
    print(f"Serving {board} at http://127.0.0.1:{args.port}/", flush=True)
    threading.Thread(target=run_queue, args=(queue,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
