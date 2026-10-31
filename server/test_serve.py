import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from serve import GONE_MS, MACHINE_STALE_MS, START_MS, Queue, advance, check_launch, known_projects, launch_command, memory_hold, same_origin, slot_free


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


class LaunchCommand(unittest.TestCase):
    def test_windows_terminal_escapes_separator(self):
        cmd = launch_command("claude", "C:\\r", "do 1; then", "sid", "wt")
        self.assertEqual(cmd, ["wt", "-w", "0", "new-tab", "-d", "C:\\r", "claude", "--session-id", "sid", "do 1\\; then"])

    def test_console_without_wt(self):
        self.assertEqual(launch_command("claude", "C:\\r", "deliver 1", "sid", None), ["claude", "--session-id", "sid", "deliver 1"])


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

    def test_a_failed_start_is_marked_and_frees_the_slot(self):
        def fail(*a):
            raise FileNotFoundError("claude is not on PATH")
        self.queue.start = fail
        self.assertEqual(self.add(1)["state"], "failed")
        self.queue.start = lambda *a: self.started.append(a)
        self.assertEqual(self.add(2)["state"], "running")


if __name__ == "__main__":
    unittest.main()
