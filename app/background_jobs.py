"""Server-side jobs that outlive the request and the drawer that started them.

A job runs a fixed list of items on a few worker threads and publishes, while it runs,
which items are in flight and what each one is doing, so the WebUI can show a progress
banner and pick the job back up after a reload. One job per key at a time: starting a
key that is still running returns the running job instead of queuing a duplicate.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import threading
import time

FINISHED_KEEP = 32   # Finished jobs kept for the banner's "done" summary, oldest dropped first.


class JobBoard:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs = {}

    def start(self, key, items, run, *, workers=1, meta=None, label=lambda item: item, on_done=None):
        """Run ``run(item, progress)`` for every item; ``progress(text)`` names the current step."""
        items = list(items)
        with self._lock:
            current = self._jobs.get(key)
            if current is not None and current["status"] == "running":
                return self._view(current)
            job = {"key": key, "status": "running", "total": len(items), "completed": 0,
                   "current": {}, "results": [], "started_at": time.time(), "finished_at": None,
                   **(meta or {})}
            self._jobs[key] = job
            self._trim()

        def one(index_item):
            index, item = index_item
            self._set(job, index, {"item": label(item), "step": None})
            try:
                result = run(item, lambda step: self._set(job, index, {"item": label(item), "step": step}))
            except Exception as error:   # One failed item never stops the rest of the job.
                result = {"item": label(item), "ok": False, "message": f"执行失败：{error}"}
            with self._lock:
                job["current"].pop(index, None)
                job["completed"] += 1
                job["results"].append(result)

        def body():
            try:
                with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
                    list(pool.map(one, enumerate(items)))
                if on_done is not None:
                    on_done(job)
            finally:
                with self._lock:
                    job.update(status="completed", finished_at=time.time(), current={})

        threading.Thread(target=body, daemon=True, name=f"job-{key}").start()
        with self._lock:
            return self._view(job)

    def _set(self, job, index, value):
        with self._lock:
            if job["status"] == "running":
                job["current"][index] = value

    def _trim(self):
        finished = sorted((job for job in self._jobs.values() if job["status"] != "running"),
                          key=lambda job: job["finished_at"] or 0)
        for job in finished[:max(0, len(finished) - FINISHED_KEEP)]:
            self._jobs.pop(job["key"], None)

    @staticmethod
    def _view(job):
        view = {key: value for key, value in job.items() if key not in ("current", "results")}
        view["current"] = [job["current"][index] for index in sorted(job["current"])]
        view["results"] = list(job["results"])
        return view

    def view(self, key):
        with self._lock:
            job = self._jobs.get(key)
            return self._view(job) if job is not None else None

    def views(self, prefix=""):
        with self._lock:
            return [self._view(job) for key, job in self._jobs.items() if key.startswith(prefix)]
