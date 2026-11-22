import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid
from functools import partial
from pathlib import Path

from serve import GONE_MS, KEEP_ENDED, MACHINE_STALE_MS, START_MS, Handler, Queue, Server, advance, check_launch, child_env, known_projects, launch_command, memory_hold, newest_machine, outside_sessions, same_origin, slot_free, trim


def write_session(board: Path, sid: str, **fields) -> None:
    (board / "sessions").mkdir(parents=True, exist_ok=True)
    (board / "sessions" / f"{sid}.json").write_text(json.dumps(fields), encoding="utf-8")


class KnownProjects(unittest.TestCase):
    def test_repo_root_over_cwd_newest_first_deduped(self):
        with tempfile.TemporaryDirectory() as d:
            board = Path(d)
            write_session(board, "a", cwd=d + "/repo/sub", repo={"root": d + "/repo", "name": "repo"}, updatedAt=1)
            write_session(board, "b", cwd=d + "/repo", repo={"root": d + "/repo", "name": "repo"}, updatedAt=5)
            write_session(board, "c", cwd=d + "/loose", repo=None, project="loose", updatedAt=3)
            (board / "sessions" / "broken.json").write_text("{", encoding="utf-8")
            write_session(board, "d", cwd="", repo=None, updatedAt=9)
            write_session(board, "e", cwd="relative", repo=None, updatedAt=9)
            got = known_projects(board)
            self.assertEqual([p["name"] for p in got], ["repo", "loose"])
            self.assertEqual(got[0]["path"], os.path.normpath(d + "/repo"))

    def test_no_sessions_folder(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(known_projects(Path(d)), [])

    def test_sandboxed_sessions_are_never_projects(self):
        with tempfile.TemporaryDirectory() as d:
            board = Path(d)
            (board / "sandboxed").mkdir()
            (board / "sandboxed" / "x.json").write_text(json.dumps(
                {"cwd": d, "repo": {"root": d, "name": "host"}, "updatedAt": 9,
                 "machine": {"at": int(time.time() * 1000), "ramMb": 99, "ramTotalMb": 100, "commitMb": 99, "commitLimitMb": 100}}),
                encoding="utf-8")
            self.assertEqual(known_projects(board), [])
            self.assertIsNone(newest_machine(board, int(time.time() * 1000)))


class CheckLaunch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = [{"path": os.path.normpath(self.tmp.name), "name": "x"}]

    def tearDown(self):
        self.tmp.cleanup()

    def test_accepts_number_and_known_folder(self):
        item, cwd = check_launch({"workItem": "#1234", "cwd": self.tmp.name + "/"}, self.projects)
        self.assertEqual((item, cwd), ("1234", self.projects[0]["path"]))

    def test_refuses_text_in_work_item(self):
        for bad in ["12 & calc", "", "abc", "1" * 10, None]:
            with self.assertRaises(ValueError):
                check_launch({"workItem": bad, "cwd": self.tmp.name}, self.projects)

    def test_refuses_unknown_folder(self):
        with self.assertRaises(ValueError):
            check_launch({"workItem": "1", "cwd": "C:\\Windows"}, self.projects)
        with self.assertRaises(ValueError):
            check_launch({"workItem": "1", "cwd": 7}, self.projects)
        with self.assertRaises(ValueError):
            check_launch(["1"], self.projects)


class SameOrigin(unittest.TestCase):
    ok = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765", "Content-Type": "application/json"}

    def test_board_page(self):
        self.assertIsNone(same_origin(self.ok, 8765))
        self.assertIsNone(same_origin({**self.ok, "Host": "localhost:8765", "Origin": "http://localhost:8765"}, 8765))

    def test_refuses_other_sites(self):
        self.assertIsNotNone(same_origin({**self.ok, "Host": "evil.example:8765"}, 8765))
        self.assertIsNotNone(same_origin({**self.ok, "Origin": "https://evil.example"}, 8765))
        self.assertIsNotNone(same_origin({**self.ok, "Content-Type": "text/plain"}, 8765))


class HostCheckOverHttp(unittest.TestCase):
    """Reads need a loopback Host too, so a DNS-rebound page can't read the board,
    while a session querying it with curl or a script still can."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        board = Path(self.tmp.name)
        write_session(board, "s1", cwd=self.tmp.name, updatedAt=1)
        queue = Queue(board, "deliver #{id}", IDLE, 4, start=lambda *a: None)
        handler = type("H", (Handler,), {"board": board, "port": 0, "queue": queue,
                                         "log_message": lambda *a: None})
        self.server = Server(("127.0.0.1", 0), partial(handler, directory=str(board)))
        self.port = handler.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method, path, host):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path, skip_host=True)
            conn.putheader("Host", host)
            conn.endheaders()
            res = conn.getresponse()
            return res.status, res.read()
        finally:
            conn.close()

    def test_sessions_can_read_by_loopback_name(self):
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            status, body = self.request("GET", "/api/queue", host)
            self.assertEqual(status, 200)
            self.assertIn("items", json.loads(body))
            self.assertEqual(self.request("GET", "/sessions/s1.json", host)[0], 200)
            self.assertEqual(self.request("HEAD", "/sessions/s1.json", host)[0], 200)

    def test_other_names_are_refused(self):
        for host in (f"evil.example:{self.port}", "127.0.0.1", f"127.0.0.1:{self.port + 1}", ""):
            for method, path in (("GET", "/api/queue"), ("GET", "/sessions/"), ("GET", "/sessions/s1.json"),
                                 ("GET", "/"), ("HEAD", "/sessions/s1.json")):
                with self.subTest(host=host, method=method, path=path):
                    status, body = self.request(method, path, host)
                    self.assertEqual(status, 403)
                    self.assertNotIn(b"cwd", body)


class LaunchCommand(unittest.TestCase):
    def test_windows_terminal_escapes_separator(self):
        cmd = launch_command("claude", "C:\\r", "do 1; then", "sid", "wt")
        self.assertEqual(cmd, ["wt", "-w", "0", "new-tab", "-d", "C:\\r", "claude", "--session-id", "sid", "do 1\\; then"])

    def test_windows_terminal_profile(self):
        self.assertEqual(launch_command("claude", "C:\\r", "", "sid", "wt", "PowerShell"),
                         ["wt", "-w", "0", "new-tab", "-p", "PowerShell", "-d", "C:\\r", "claude", "--session-id", "sid"])
        self.assertEqual(launch_command("claude", "C:\\r", "", "sid", None, "PowerShell"), ["claude", "--session-id", "sid"])

    def test_console_without_wt(self):
        self.assertEqual(launch_command("claude", "C:\\r", "deliver 1", "sid", None), ["claude", "--session-id", "sid", "deliver 1"])

    def test_child_env_drops_what_a_session_set(self):
        env = {"PATH": "p", "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "NO_COLOR": "1"}
        self.assertEqual(child_env(env), {"PATH": "p"})
        # NO_COLOR set by the user, with the server started outside a session, stays.
        self.assertEqual(child_env({"PATH": "p", "NO_COLOR": "1"}), {"PATH": "p", "NO_COLOR": "1"})

    def test_empty_prompt_passes_no_argument(self):
        self.assertEqual(launch_command("claude", "C:\\r", "", "sid", None), ["claude", "--session-id", "sid"])
        self.assertEqual(launch_command("claude", "C:\\r", "", "sid", "wt"),
                         ["wt", "-w", "0", "new-tab", "-d", "C:\\r", "claude", "--session-id", "sid"])


IDLE = 15 * 60_000


def board(**fields) -> dict:
    return {"state": "idle", "updatedAt": 1_000_000, "stateSince": 1_000_000, "crons": [], "shells": [], "done": None, **fields}


class SlotFree(unittest.TestCase):
    now = 1_000_000

    def test_held_while_working_or_waiting_on_you(self):
        for state in ("running", "waiting", "background"):
            self.assertIsNone(slot_free(board(state=state, stateSince=0), 0, self.now, IDLE))

    def test_done_frees_once_the_turn_ends(self):
        self.assertIsNone(slot_free(board(state="running", done={"at": 1}), 0, self.now, IDLE))
        self.assertEqual(slot_free(board(done={"at": 1}), 0, self.now, IDLE), "done")

    def test_idle_long_enough_with_nothing_pending(self):
        self.assertIsNone(slot_free(board(stateSince=self.now - IDLE + 1), 0, self.now, IDLE))
        self.assertEqual(slot_free(board(stateSince=self.now - IDLE), 0, self.now, IDLE), "idle")
        long_idle = self.now - 10 * IDLE
        self.assertIsNone(slot_free(board(stateSince=long_idle, shells=[{"id": "b1"}]), 0, self.now, IDLE))
        self.assertIsNone(slot_free(board(stateSince=long_idle, crons=[{"nextAt": self.now + 5}]), 0, self.now, IDLE))
        self.assertEqual(slot_free(board(stateSince=long_idle, crons=[{"nextAt": None}]), 0, self.now, IDLE), "idle")

    def test_ended_gone_or_never_started(self):
        self.assertEqual(slot_free(board(state="ended"), 0, self.now, IDLE), "ended")
        self.assertEqual(slot_free(board(state="running", updatedAt=self.now - GONE_MS - 1), 0, self.now, IDLE), "gone")
        self.assertIsNone(slot_free(None, self.now - START_MS, self.now, IDLE))
        self.assertEqual(slot_free(None, self.now - START_MS - 1, self.now, IDLE), "never started")


def item(n: int, cwd: str, state="queued", **fields) -> dict:
    return {"id": f"{n:012x}", "workItem": str(n), "cwd": cwd, "name": cwd, "state": state, "queuedAt": n, **fields}


class Advance(unittest.TestCase):
    def test_one_per_project_by_default_in_order(self):
        q = {"limits": {}, "items": [item(1, "/a"), item(2, "/a"), item(3, "/b")]}
        started = advance(q, {}, 10, IDLE, 4)
        self.assertEqual([i["workItem"] for i in started], ["1", "3"])
        self.assertEqual([i["state"] for i in q["items"]], ["running", "queued", "running"])
        self.assertEqual(advance(q, {}, 11, IDLE, 4), [])

    def test_project_limit_and_global_cap(self):
        q = {"limits": {os.path.normcase(os.path.normpath("/a")): 3}, "items": [item(n, "/a") for n in range(1, 5)]}
        self.assertEqual(len(advance(q, {}, 10, IDLE, 4)), 3)
        q = {"limits": {os.path.normcase(os.path.normpath("/a")): 3}, "items": [item(n, "/a") for n in range(1, 5)]}
        self.assertEqual(len(advance(q, {}, 10, IDLE, 2)), 2)

    def test_a_finished_session_lets_the_next_start(self):
        q = {"limits": {}, "items": [item(1, "/a", "running", sessionId="s1", startedAt=0), item(2, "/a")]}
        self.assertEqual(advance(q, {"s1": board(state="running", updatedAt=100)}, 100, IDLE, 4), [])
        started = advance(q, {"s1": board(done={"at": 1}, updatedAt=200)}, 200, IDLE, 4)
        self.assertEqual([i["workItem"] for i in started], ["2"])
        self.assertEqual((q["items"][0]["state"], q["items"][0]["endedBy"]), ("finished", "done"))
        self.assertTrue(started[0]["sessionId"])

    def test_hold_starts_nothing_but_still_frees_slots(self):
        q = {"limits": {}, "items": [item(1, "/a", "running", sessionId="s1", startedAt=0), item(2, "/a")]}
        self.assertEqual(advance(q, {"s1": board(state="ended", updatedAt=100)}, 100, IDLE, 4, hold=True), [])
        self.assertEqual([i["state"] for i in q["items"]], ["finished", "queued"])


    def test_sessions_outside_the_queue_take_slots(self):
        a = os.path.normcase(os.path.normpath("/a"))
        q = {"limits": {}, "items": [item(1, "/a"), item(2, "/b")]}
        started = advance(q, {}, 10, IDLE, 4, outside={a: 1})
        self.assertEqual([i["workItem"] for i in started], ["2"])
        q = {"limits": {a: 2}, "items": [item(1, "/a")]}
        self.assertEqual(len(advance(q, {}, 10, IDLE, 4, outside={a: 1})), 1)
        x, y = (os.path.normcase(os.path.normpath(p)) for p in ("/x", "/y"))
        q = {"limits": {}, "items": [item(1, "/a"), item(2, "/x", "running", sessionId="s2", startedAt=10)]}
        self.assertEqual(advance(q, {}, 10, IDLE, 2, outside={x: 1, y: 1}), [])  # the global cap

    def test_sessions_in_repos_the_queue_does_not_touch_leave_the_global_cap_alone(self):
        others = {os.path.normcase(os.path.normpath(f"/r{n}")): 1 for n in range(4)}
        q = {"limits": {}, "items": [item(1, "/a")]}
        self.assertEqual([i["workItem"] for i in advance(q, {}, 10, IDLE, 4, outside=others)], ["1"])


class Trim(unittest.TestCase):
    def test_keeps_the_session_ids_of_dropped_items(self):
        q = {"limits": {}, "items": [item(n, "/a", "finished", sessionId=f"s{n}", endedAt=n)
                                     for n in range(KEEP_ENDED + 2)]}
        trim(q)
        self.assertEqual(len(q["items"]), KEEP_ENDED)
        self.assertEqual(q["started"], ["s0", "s1"])
        trim(q)
        self.assertEqual(q["started"], ["s0", "s1"])


class OutsideSessions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.board = Path(self.tmp.name)
        self.repo = os.path.normpath(self.tmp.name + "/repo")
        self.now = int(time.time() * 1000)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, sid, **fields):
        fields = {"sessionId": sid, "cwd": self.repo + "/sub", "repo": {"root": self.repo, "name": "repo"},
                  "workItem": "7", "state": "running", "updatedAt": self.now, "stateSince": self.now, **fields}
        write_session(self.board, sid, **fields)

    def test_counts_live_work_item_sessions_by_repo_root(self):
        self.write("a")
        self.write("b", repo=None, cwd=self.repo + os.sep)  # no repo: its cwd, normalized
        self.write("c", state="waiting", cwd=self.tmp.name + "/other", repo=None)
        got = outside_sessions(self.board, [], self.now, IDLE)
        self.assertEqual(got, {os.path.normcase(self.repo): 2,
                               os.path.normcase(os.path.normpath(self.tmp.name + "/other")): 1})

    def test_ignores_idle_chats_ended_stale_finished_and_queue_items(self):
        self.write("chat", workItem=None)
        self.write("ended", state="ended")
        self.write("gone", updatedAt=self.now - GONE_MS - 1)
        self.write("done", state="idle", done={"at": 1})
        self.write("idle", state="idle", stateSince=self.now - IDLE)
        self.write("queued", state="running")
        self.write("relative", cwd="relative", repo=None)
        (self.board / "sessions" / "broken.json").write_text("{", encoding="utf-8")
        (self.board / "sandboxed").mkdir()
        (self.board / "sandboxed" / "x.json").write_text(json.dumps(
            {"sessionId": "x", "cwd": self.repo, "workItem": "7", "state": "running", "updatedAt": self.now}), encoding="utf-8")
        self.write("trimmed", state="running")
        self.write("orchestrator", state="waiting", plan={"items": [{"workItem": "7"}], "gate": "go?"})
        items = [item(1, self.repo, "finished", sessionId="queued")]
        self.assertEqual(outside_sessions(self.board, items, self.now, IDLE, ["trimmed"]), {})
        self.write("idle", state="idle", stateSince=self.now - IDLE + 60_000)  # not idle long enough yet
        self.assertEqual(outside_sessions(self.board, items, self.now, IDLE, ["trimmed"]), {os.path.normcase(self.repo): 1})


class MemoryHold(unittest.TestCase):
    def test_thresholds_and_release(self):
        m = lambda ram, commit: {"ramMb": ram, "ramTotalMb": 100, "commitMb": commit, "commitLimitMb": 100}
        self.assertIsNone(memory_hold(m(89, 84), held=False))
        self.assertEqual(memory_hold(m(90, 85), held=False), "memory RAM 90%, commit 85%")
        self.assertEqual(memory_hold(m(70, 82), held=True), "memory commit 82%")
        self.assertIsNone(memory_hold(m(84, 79), held=True))
        self.assertIsNone(memory_hold(None, held=True))
        self.assertIsNone(memory_hold({"ramMb": 1}, held=False))


class QueueActions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.board = Path(self.tmp.name)
        self.repo = os.path.normpath(self.tmp.name)
        self.projects = [{"path": self.repo, "name": "repo"}]
        self.started = []
        self.queue = Queue(self.board, "deliver #{id}", IDLE, 4, start=lambda *a: self.started.append(a))

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, n):
        return self.queue.act({"action": "add", "workItem": str(n), "cwd": self.repo}, self.projects)

    def test_save_retries_a_refused_rename_and_cleans_up_when_it_gives_up(self):
        real = os.replace
        calls = []
        def flaky(src, dst):
            calls.append(src)
            if len(calls) < 3:
                raise PermissionError(5, "Access is denied")
            real(src, dst)
        with mock.patch("serve.os.replace", flaky), mock.patch("serve.time.sleep"):
            self.queue.save({"limits": {}, "items": []})
        self.assertEqual(len(calls), 3)
        self.assertTrue((self.board / "queue.json").exists())
        with mock.patch("serve.os.replace", side_effect=PermissionError(5, "Access is denied")), \
                mock.patch("serve.time.sleep"), self.assertRaises(PermissionError):
            self.queue.save({"limits": {}, "items": []})
        self.assertFalse((self.board / "queue.tmp").exists())

    def test_add_starts_the_first_and_queues_the_rest(self):
        first = self.add(1)
        second = self.add(2)
        self.assertEqual((first["state"], second["state"]), ("running", "queued"))
        self.assertEqual(self.started, [(self.repo, "deliver #1", first["sessionId"])])
        with self.assertRaises(ValueError):
            self.add(2)
        saved = json.loads((self.board / "queue.json").read_text(encoding="utf-8"))
        self.assertEqual([i["workItem"] for i in saved["items"]], ["1", "2"])

    def test_release_starts_the_next_and_first_reorders(self):
        first = self.add(1)
        self.add(2)
        third = self.add(3)
        self.queue.act({"action": "first", "id": third["id"]}, self.projects)
        self.queue.act({"action": "release", "id": first["id"]}, self.projects)
        self.assertEqual([a[1] for a in self.started], ["deliver #1", "deliver #3"])

    def test_cancel_limit_and_bad_requests(self):
        self.add(1)
        second = self.add(2)
        self.queue.act({"action": "cancel", "id": second["id"]}, self.projects)
        self.queue.act({"action": "limit", "cwd": self.repo, "max": 2}, self.projects)
        self.assertEqual(self.queue.view(self.projects)["projects"][0]["max"], 2)
        self.add(3)
        self.assertEqual(len(self.started), 2)
        for bad in [{"action": "cancel", "id": second["id"]}, {"action": "release", "id": "x; rm"},
                    {"action": "limit", "cwd": self.repo, "max": 99}, {"action": "limit", "cwd": self.repo, "max": True},
                    {"action": "run"}, ["add"]]:
            with self.assertRaises(ValueError):
                self.queue.act(bad, self.projects)

    def write_machine(self, ram_pct, commit_pct, at=None):
        at = int(time.time() * 1000) if at is None else at
        sessions = self.board / "sessions"
        sessions.mkdir(exist_ok=True)
        m = {"at": at, "ramMb": ram_pct, "ramTotalMb": 100, "commitMb": commit_pct, "commitLimitMb": 100}
        (sessions / "x.json").write_text(json.dumps({"machine": m}), encoding="utf-8")

    def test_memory_pressure_holds_new_starts(self):
        self.write_machine(95, 50)
        self.assertEqual(self.add(1)["state"], "queued")
        self.assertEqual(self.queue.view(self.projects)["held"], "memory RAM 95%")
        self.write_machine(86, 50)  # under the hold mark, not yet under the release mark
        self.queue.tick()
        self.assertEqual(self.started, [])
        self.write_machine(60, 50)
        self.queue.tick()
        self.assertEqual(len(self.started), 1)
        self.assertIsNone(self.queue.view(self.projects)["held"])

    def test_a_stale_sample_never_holds(self):
        self.write_machine(99, 99, at=int(time.time() * 1000) - MACHINE_STALE_MS - 1000)
        self.assertEqual(self.add(1)["state"], "running")

    def test_open_starts_an_empty_session_outside_the_queue(self):
        self.write_machine(95, 95)  # memory pressure holds the queue, not this
        self.add(1)
        opened = self.queue.act({"action": "open", "cwd": self.repo + os.sep}, self.projects)
        self.assertEqual(self.started, [(self.repo, "", opened["sessionId"])])
        self.assertEqual(str(uuid.UUID(opened["sessionId"])), opened["sessionId"])
        self.assertEqual((opened["cwd"], opened["name"]), (self.repo, "repo"))
        saved = json.loads((self.board / "queue.json").read_text(encoding="utf-8"))
        self.assertEqual([i["state"] for i in saved["items"]], ["queued"])

    def test_open_refuses_unknown_folders_and_reports_a_failed_start(self):
        for bad in [{"action": "open"}, {"action": "open", "cwd": "C:\\Windows"}, {"action": "open", "cwd": 1}]:
            with self.assertRaises(ValueError):
                self.queue.act(bad, self.projects)
        def fail(*a):
            raise FileNotFoundError("claude is not on PATH")
        self.queue.start = fail
        with self.assertRaisesRegex(ValueError, "not on PATH"):
            self.queue.act({"action": "open", "cwd": self.repo}, self.projects)
        self.assertEqual(self.started, [])

    def test_a_session_started_by_hand_holds_the_slot(self):
        write_session(self.board, "manual", sessionId="manual", cwd=self.repo, repo=None, workItem="9",
                      state="running", updatedAt=int(time.time() * 1000))
        self.queue.tick()
        self.assertEqual(self.queue.view(self.projects)["projects"][0]["busy"], 1)
        self.assertEqual(self.add(1)["state"], "queued")
        write_session(self.board, "manual", sessionId="manual", cwd=self.repo, repo=None, workItem="9",
                      state="ended", updatedAt=int(time.time() * 1000))
        self.queue.tick()
        self.assertEqual(len(self.started), 1)
        self.assertEqual(self.queue.view(self.projects)["projects"][0]["busy"], 0)
        # The item's own session, once it writes, is a queue item, not an outside one.
        sid = self.started[0][2]
        write_session(self.board, sid, sessionId=sid, cwd=self.repo, repo=None, workItem="1",
                      state="running", updatedAt=int(time.time() * 1000))
        self.assertEqual(self.queue.view(self.projects)["projects"][0]["busy"], 0)
        self.add(2)
        self.queue.tick()
        self.assertEqual(len(self.started), 1)

    def test_a_failed_start_is_marked_and_frees_the_slot(self):
        def fail(*a):
            raise FileNotFoundError("claude is not on PATH")
        self.queue.start = fail
        self.assertEqual(self.add(1)["state"], "failed")
        self.queue.start = lambda *a: self.started.append(a)
        self.assertEqual(self.add(2)["state"], "running")


if __name__ == "__main__":
    unittest.main()
