"""Serves the session board and starts a Claude Code session per work item.

    python server/serve.py [--port 8765] [--dir <board folder>] [--prompt "deliver #{id}"]

GET serves the board folder like `python -m http.server`, directory index
included, so the page reads `sessions/` the same way.

GET  api/launch  -> {"prompt": "...", "projects": [{"path", "name"}]}
POST api/launch  {"workItem": "1234", "cwd": "<a path from projects>"}

The POST opens an interactive `claude "<prompt>"` in `cwd`, in a new Windows
Terminal tab (or a new console window without it). The session then writes its
own status file and shows up as a tile. Only a work item number and one of the
projects that sessions have reported can be sent: the endpoint never runs text
from the request.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WORK_ITEM = re.compile(r"^\d{1,9}$")
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


def check_launch(body, projects: list[dict]) -> tuple[str, str]:
    """The work item and folder of a launch request; raises ValueError otherwise."""
    if not isinstance(body, dict):
        raise ValueError("expected a JSON object")
    item = str(body.get("workItem", "")).strip().lstrip("#")
    if not WORK_ITEM.match(item):
        raise ValueError("workItem must be a work item number")
    cwd = body.get("cwd")
    match = [p["path"] for p in projects if isinstance(cwd, str)
             and os.path.normcase(os.path.normpath(cwd)) == os.path.normcase(p["path"])]
    if not match:
        raise ValueError("cwd is not a folder any session has run in")
    if not os.path.isdir(match[0]):
        raise ValueError(f"{match[0]} no longer exists")
    return item, match[0]


def child_env() -> dict:
    """This environment minus what marks a process as running inside Claude Code,
    for when the server itself was started from a session."""
    return {k: v for k, v in os.environ.items()
            if not (k == "CLAUDECODE" or k.startswith("CLAUDE_CODE_"))}


def launch_command(claude: str, cwd: str, prompt: str, wt: str | None) -> list[str]:
    if wt:
        # wt splits its command line on ';' into several commands.
        return [wt, "-w", "0", "new-tab", "-d", cwd, claude, prompt.replace(";", "\\;")]
    return [claude, prompt]


def launch(cwd: str, prompt: str) -> None:
    if os.name != "nt":
        raise NotImplementedError("starting a session is only implemented on Windows")
    claude = shutil.which("claude")
    if not claude:
        raise FileNotFoundError("claude is not on PATH")
    cmd = launch_command(claude, cwd, prompt, shutil.which("wt"))
    flags = subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(cmd, cwd=cwd, env=child_env(), creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Handler(SimpleHTTPRequestHandler):
    board: Path
    prompt: str
    port: int

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
        if path == "/api/launch":
            return self.send_json(200, {"prompt": self.prompt, "projects": known_projects(self.board)})
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
        if self.path.split("?")[0] != "/api/launch":
            return self.send_json(404, {"error": "not found"})
        refused = same_origin(self.headers, self.port)
        if refused:
            return self.send_json(403, {"error": refused})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 4096)) or b"null")
            item, cwd = check_launch(body, known_projects(self.board))
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        prompt = self.prompt.replace("{id}", item)
        try:
            launch(cwd, prompt)
        except (OSError, NotImplementedError) as e:
            return self.send_json(500, {"error": str(e)})
        self.log_message("launched %r in %s", prompt, cwd)
        self.send_json(200, {"workItem": item, "cwd": cwd, "prompt": prompt})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dir", type=Path, default=default_board_dir(), help="the board folder")
    # The '#' lets the tile show the work item from the first prompt, before a skill runs.
    ap.add_argument("--prompt", default="deliver #{id}",
                    help="what a new session is started with; {id} is the work item number")
    args = ap.parse_args()
    if "{id}" not in args.prompt:
        sys.exit("--prompt must contain {id}")
    board = args.dir.resolve()
    board.mkdir(parents=True, exist_ok=True)
    handler = type("BoardHandler", (Handler,), {"board": board, "prompt": args.prompt, "port": args.port})
    try:
        server = Server(("127.0.0.1", args.port), partial(handler, directory=str(board)))
    except OSError as e:
        sys.exit(f"Can't listen on 127.0.0.1:{args.port} ({e.strerror}). Is another server, "
                 f"such as python -m http.server, still running on it?")
    print(f"Serving {board} at http://127.0.0.1:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
