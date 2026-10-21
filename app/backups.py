"""Configuration backups in the data directory's ``backups/``.

A backup is a gzip tarball with an online snapshot of ``control.sqlite3`` (settings, model rules,
the gateway key and runtime state) and ``manifest.json``, which records when it was taken and by
which gateway version. Credentials (``*.info``), program files and the log database never go in:
updates leave the credentials alone, and any version's program can be installed again from its
release.

Backups are taken before every one-click update, on demand from the WebUI and on a schedule. Only
scheduled ones are pruned, down to ``backup_keep``.
"""
from __future__ import annotations

import calendar
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tarfile
import tempfile
import threading
import time

NAME = re.compile(r"(?:update-(?P<source>\d+\.\d+\.\d+)-to-(?P<target>\d+\.\d+\.\d+)"
                  r"|(?P<kind>manual|auto)-(?P<version>\d+\.\d+\.\d+))-(?P<stamp>\d{8}-\d{6})\.tar\.gz")
STAMP = "%Y%m%d-%H%M%S"
POLL_SECONDS = 60


class BackupError(Exception):
    """A user-facing backup failure; the message is shown in the WebUI as is."""


class Backups:
    def __init__(self, config, *, data_dir, version):
        self.config = config
        self.data_dir = Path(data_dir).resolve()
        self.directory = self.data_dir / "backups"
        self.version = version
        self._lock = threading.Lock()

    def create(self, kind, target=None):
        """Write one backup and return its file name; ``target`` is the version an update installs."""
        now = time.time()
        stamp = time.strftime(STAMP, time.gmtime(now))
        name = (f"update-{self.version}-to-{target}-{stamp}.tar.gz" if kind == "update"
                else f"{kind}-{self.version}-{stamp}.tar.gz")
        try:
            with self._lock:
                self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                if (self.directory / name).exists():
                    raise BackupError("刚刚已创建过备份，请稍后再试")
                with tempfile.TemporaryDirectory(dir=self.directory, prefix=".tmp-") as scratch:
                    snapshot = Path(scratch) / "control.sqlite3"
                    control = self.data_dir / "control.sqlite3"
                    if control.exists():
                        source, copy = sqlite3.connect(control, timeout=5), sqlite3.connect(snapshot)
                        try:
                            source.backup(copy)   # Online backup: consistent while the gateway keeps writing.
                        finally:
                            copy.close()
                            source.close()
                    manifest = Path(scratch) / "manifest.json"
                    manifest.write_text(json.dumps({
                        "kind": kind,
                        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                        "version": self.version,
                        **({"target_version": target} if kind == "update" else {}),
                        "files": ["data/control.sqlite3"] if snapshot.exists() else [],
                    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    partial = Path(scratch) / name
                    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, "wb") as raw, tarfile.open(fileobj=raw, mode="w:gz") as tar:
                        tar.add(manifest, arcname="manifest.json")
                        if snapshot.exists():
                            tar.add(snapshot, arcname="data/control.sqlite3")
                    os.replace(partial, self.directory / name)
        except (OSError, sqlite3.Error, tarfile.TarError) as error:
            raise BackupError(f"备份失败：{type(error).__name__}，请检查数据目录的空间与权限") from error
        return name

    def list(self):
        try:
            entries = list(self.directory.iterdir())
        except OSError:
            return []
        items = []
        for entry in entries:
            match = NAME.fullmatch(entry.name)
            if not match or not entry.is_file():
                continue
            item = {"name": entry.name, "kind": match["kind"] or "update",
                    "version": match["version"] or match["source"],
                    "created_at": calendar.timegm(time.strptime(match["stamp"], STAMP)),
                    "size": entry.stat().st_size}
            if match["target"]:
                item.update({"from": match["source"], "to": match["target"]})
            items.append(item)
        return sorted(items, key=lambda item: (item["created_at"], item["name"]), reverse=True)

    def path(self, name):
        path = self.directory / name
        if not NAME.fullmatch(name) or not path.is_file():
            raise BackupError("备份不存在")
        return path

    def delete(self, name):
        self.path(name).unlink()

    # ---------------------------------------------------------------- schedule

    def schedule(self):
        """The automatic backup settings, the newest scheduled backup and when the next is due."""
        enabled = bool(self.config.get("backup_auto"))
        hours = self.config.get("backup_interval_hours") or 24
        last = next((item["created_at"] for item in self.list() if item["kind"] == "auto"), None)
        return {"enabled": enabled, "interval_hours": hours, "keep": self.config.get("backup_keep") or 7,
                "last_at": last,
                "next_at": (max(last + hours * 3600, time.time()) if last else time.time()) if enabled else None}

    def run_due(self):
        """Take a scheduled backup when one is due, then prune scheduled ones beyond the limit."""
        schedule = self.schedule()
        if not schedule["enabled"]:
            return None
        name = self.create("auto") if schedule["next_at"] <= time.time() else None
        for item in [item for item in self.list() if item["kind"] == "auto"][schedule["keep"]:]:
            (self.directory / item["name"]).unlink(missing_ok=True)
        return name

    def loop(self):
        while True:
            try:
                self.run_due()
            except Exception as error:   # A failed run is retried on the next poll.
                print(f"[backup] 自动备份失败：{type(error).__name__}", file=sys.stderr)
            time.sleep(POLL_SECONDS)
