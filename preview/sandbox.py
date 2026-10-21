"""Keep the preview offline: HTTP goes to the simulated upstream and nothing else leaves the host."""

import ipaddress
import socket

import httpx

import app.acp_client
import app.updates
from preview.upstream import acp_turn


def _local(host) -> bool:
    if host in (None, "", b"", "localhost", b"localhost"):
        return True
    try:
        ipaddress.ip_address(host.decode() if isinstance(host, bytes) else host)
    except ValueError:
        return False
    return True


def install(upstream):
    """Route every httpx client through ``upstream`` and refuse any other outbound connection.

    Returns a function that undoes the patches; the preview process itself never calls it.
    """
    saved = []

    def patch(owner, name, value):
        saved.append((owner, name, getattr(owner, name)))
        setattr(owner, name, value)

    async def handle_async(self, request):
        return await upstream.handle_async(request)

    def refuse(method):
        def guarded(self, address):
            if self.family in (socket.AF_INET, socket.AF_INET6):
                raise ConnectionRefusedError("预览环境不允许对外连接")
            return method(self, address)
        return guarded

    resolve = socket.getaddrinfo

    def getaddrinfo(host, *args, **kwargs):
        if not _local(host):
            raise socket.gaierror(socket.EAI_NONAME, "预览环境不解析外部域名")
        return resolve(host, *args, **kwargs)

    patch(httpx.HTTPTransport, "handle_request", lambda self, request: upstream.handle(request))
    patch(httpx.AsyncHTTPTransport, "handle_async_request", handle_async)
    # Anything that bypasses httpx (raw sockets, http.client) stops here instead of reaching out.
    patch(socket.socket, "connect", refuse(socket.socket.connect))
    patch(socket.socket, "connect_ex", refuse(socket.socket.connect_ex))
    patch(socket, "getaddrinfo", getaddrinfo)
    patch(app.acp_client, "run_turn", acp_turn)
    # The preview runs from a working tree; an update must never replace those files.
    patch(app.updates.Updater, "self_update_block", lambda self: "预览环境不支持安装更新")

    def restore():
        for owner, name, value in reversed(saved):
            setattr(owner, name, value)
    return restore
