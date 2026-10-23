import json
import os
import tempfile
import unittest
from pathlib import Path

from serve import check_launch, known_projects, launch_command, same_origin


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
        cmd = launch_command("claude", "C:\\r", "do 1; then", "wt")
        self.assertEqual(cmd, ["wt", "-w", "0", "new-tab", "-d", "C:\\r", "claude", "do 1\\; then"])

    def test_console_without_wt(self):
        self.assertEqual(launch_command("claude", "C:\\r", "deliver 1", None), ["claude", "deliver 1"])


if __name__ == "__main__":
    unittest.main()
