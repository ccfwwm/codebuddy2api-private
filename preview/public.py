"""Limits for a preview exposed to the public: no credentials in or out, and nothing that spoils it for others."""

import re
import threading

from starlette.responses import JSONResponse

MESSAGE = "公开预览中不可用此操作"
# Imports would let a visitor leave real credentials that the next visitor could export; the
# rest would change or empty the shared demo until its next reset.
BLOCKED = tuple((method, re.compile(path)) for method, path in (
    ("POST", r"/admin/credentials(/upload|/refresh-import|/export)?"),
    ("DELETE", r"/admin/credentials/[^/]+"),
    ("PATCH", r"/admin/settings"),
    ("POST", r"/admin/logs/clear"),
    ("POST", r"/admin/storage/archive"),
    ("POST", r"/admin/storage/backups"),
    ("DELETE", r"/admin/storage/backups/[^/]+"),
    ("POST", r"/admin/update/(install|mirror)"),
))


def blocked(method: str, path: str) -> bool:
    return any(method == m and pattern.fullmatch(path) for m, pattern in BLOCKED)


class Guard:
    """ASGI middleware that refuses the blocked management requests."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and blocked(scope["method"], scope["path"]):
            response = JSONResponse({"error": {"message": MESSAGE, "type": "admin_error"}}, status_code=403)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def schedule_reset(config, hours: float, *, timer=threading.Timer):
    """Stop the server after ``hours`` so the supervisor starts it again with fresh data."""
    def stop():
        server = config.get("server")
        if server is not None:
            server.should_exit = True
    reset = timer(hours * 3600, stop)
    reset.daemon = True
    reset.start()
    return reset
