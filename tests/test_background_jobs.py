#!/usr/bin/env python3
"""Test the background job board: progress, isolation of failures and one job per key."""
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # Allow direct execution.

from app.background_jobs import FINISHED_KEEP, JobBoard


def wait(board, key):
    for _ in range(300):
        view = board.view(key)
        if view["status"] == "completed":
            return view
        time.sleep(0.01)
    raise AssertionError("job did not finish")


class JobBoardTests(unittest.TestCase):
    def test_runs_every_item_and_a_failure_never_stops_the_rest(self):
        board = JobBoard()

        def run(item, progress):
            progress("step " + item)
            if item == "b":
                raise RuntimeError("boom")
            return {"item": item, "ok": True}
        board.start("k", ["a", "b", "c"], run, meta={"kind": "all"})
        view = wait(board, "k")
        self.assertEqual((view["total"], view["completed"], view["kind"]), (3, 3, "all"))
        self.assertEqual(sorted(row["item"] for row in view["results"]), ["a", "b", "c"])
        self.assertIn("boom", next(row for row in view["results"] if row["item"] == "b")["message"])
        self.assertEqual(view["current"], [])

    def test_current_shows_the_item_and_its_step_while_running(self):
        board, gate, seen = JobBoard(), threading.Event(), threading.Event()

        def run(item, progress):
            progress("halfway")
            seen.set()
            gate.wait(2)
            return {"ok": True}
        board.start("k", ["only"], run, label=lambda item: {"name": item})
        seen.wait(2)
        self.assertEqual(board.view("k")["current"], [{"item": {"name": "only"}, "step": "halfway"}])
        gate.set()
        wait(board, "k")

    def test_starting_a_running_key_returns_the_running_job(self):
        board, gate = JobBoard(), threading.Event()
        first = board.start("k", [1], lambda item, progress: gate.wait(2) or {"ok": True})
        second = board.start("k", [2, 3], lambda item, progress: {"ok": True})
        self.assertEqual((second["total"], second["started_at"]), (1, first["started_at"]))
        gate.set()
        wait(board, "k")
        third = board.start("k", [2, 3], lambda item, progress: {"ok": True})
        self.assertEqual(third["total"], 2)
        wait(board, "k")

    def test_finished_jobs_are_bounded_and_listed_by_prefix(self):
        board = JobBoard()
        for index in range(FINISHED_KEEP + 5):
            board.start(f"growth:{index}", [], lambda item, progress: {})
            wait(board, f"growth:{index}")
        board.start("other", [], lambda item, progress: {})
        wait(board, "other")
        self.assertLessEqual(len(board.views("growth:")), FINISHED_KEEP)


if __name__ == "__main__":
    unittest.main(verbosity=2)
