from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator, Sequence

import httpx
import pytest

from fissionplane import (
    AsyncFissionPlane,
    FileMoveEvent,
    FissionPlane,
    ProcessAttachment,
    ProcessOutputEvent,
    PtySize,
)
from fissionplane.streaming import StreamingProtocolError

BASE_URL = "http://control-plane.test"


def sandbox_body() -> dict[str, object]:
    return {
        "sandbox_id": "abc123",
        "state": "running",
        "template_artifact_id": "art1",
        "epoch": 1,
        "domain": "sandboxes.example.com",
        "created_at": "2026-07-28T12:00:00Z",
        "deadline": "2026-07-28T13:00:00Z",
        "resources": {"vcpus": 2, "mem_mib": 1024},
        "metadata": {},
    }


def token_body() -> dict[str, object]:
    return {
        "token": "token+/ value",
        "expires_at": "2026-07-28T12:30:00Z",
        "epoch": 1,
    }


def process_body() -> dict[str, object]:
    return {
        "pid": 42,
        "command": "python",
        "started_at": "2026-07-28T12:01:00Z",
        "running": True,
        "pty": True,
    }


def create_response() -> httpx.Response:
    return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})


class FakeSyncConnection:
    def __init__(self, messages: list[str]) -> None:
        self.subprotocol: str | None = "fissionplane.v1"
        self.messages = messages
        self.sent: list[str] = []
        self.closed = False

    def __iter__(self) -> Iterator[str | bytes]:
        return iter(self.messages)

    def send(self, message: str) -> None:
        self.sent.append(message)

    def close(self) -> None:
        self.closed = True


class FakeAsyncConnection:
    def __init__(self, messages: list[str]) -> None:
        self.subprotocol: str | None = "fissionplane.v1"
        self.messages = messages
        self.sent: list[str] = []
        self.closed = False

    async def _iterate(self) -> AsyncIterator[str | bytes]:
        for message in self.messages:
            yield message

    def __aiter__(self) -> AsyncIterator[str | bytes]:
        return self._iterate()

    async def send(self, message: str) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True


def test_sync_files_http_methods() -> None:
    seen: list[tuple[str, str, dict[str, str], bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/sandboxes":
            return create_response()
        seen.append((request.method, request.url.path, dict(request.url.params), request.content))
        if request.url.path == "/files":
            if request.method == "GET":
                return httpx.Response(
                    200,
                    json={
                        "items": [
                            {
                                "path": "/workspace/a.txt",
                                "name": "a.txt",
                                "kind": "file",
                                "size": 3,
                                "mode": "0644",
                                "modified_at": "2026-07-28T12:00:00Z",
                            }
                        ]
                    },
                )
            return httpx.Response(204)
        if request.url.path == "/files/stat":
            return httpx.Response(
                200,
                json={
                    "path": "/workspace/a.txt",
                    "name": "a.txt",
                    "kind": "file",
                    "size": 3,
                    "mode": "0644",
                    "modified_at": "2026-07-28T12:00:00Z",
                },
            )
        if request.url.path == "/files/content" and request.method == "GET":
            return httpx.Response(200, content=b"abc")
        return httpx.Response(204)

    sandbox = FissionPlane(
        api_key="key",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
    ).sandboxes.create("base")

    assert sandbox.files.list("/workspace")[0].name == "a.txt"
    assert sandbox.files.stat("/workspace/a.txt").size == 3
    sandbox.files.make_dir("/workspace/sub", mode="0755")
    sandbox.files.move("/workspace/a", "/workspace/b", overwrite=True)
    sandbox.files.remove("/workspace/sub", recursive=True)
    assert sandbox.files.read("/workspace/a.txt") == b"abc"
    sandbox.files.write("/workspace/b.txt", b"xyz", mode="0600")

    assert ("GET", "/files", {"path": "/workspace"}, b"") in seen
    assert any(item[:2] == ("POST", "/files/directories") for item in seen)
    assert any(item[:2] == ("POST", "/files/move") for item in seen)
    assert ("DELETE", "/files", {"path": "/workspace/sub", "recursive": "true"}, b"") in seen
    assert (
        "PUT",
        "/files/content",
        {"path": "/workspace/b.txt", "mode": "0600"},
        b"xyz",
    ) in seen


def test_process_http_handle_and_pty_attach() -> None:
    requests: list[httpx.Request] = []
    connection = FakeSyncConnection(
        [
            '{"type":"future","value":1}',
            '{"type":"stdout","sequence":1,"data":"hello\\n"}',
        ]
    )
    websocket: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/sandboxes":
            return create_response()
        requests.append(request)
        if request.url.path == "/processes" and request.method == "POST":
            return httpx.Response(201, json=process_body())
        if request.url.path == "/processes/42":
            return httpx.Response(200, json=process_body())
        if request.url.path == "/processes/42/logs":
            return httpx.Response(
                200,
                json={
                    "chunks": [{"sequence": 1, "stream": "stdout", "data": "hello\n"}],
                    "next_sequence": 2,
                    "running": True,
                },
            )
        return httpx.Response(204)

    def connect(uri: str, *, subprotocols: Sequence[str] | None = None) -> FakeSyncConnection:
        websocket["uri"] = uri
        websocket["subprotocols"] = subprotocols
        return connection

    sandbox = FissionPlane(
        api_key="key",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
        websocket_connect=connect,
    ).sandboxes.create("base")
    handle = sandbox.commands.start("python", args=["-i"], pty=PtySize(cols=80, rows=24))

    assert handle.pid == 42
    assert handle.refresh().pty is True
    assert handle.logs(after=0).next_sequence == 2
    attachment = handle.attach()
    assert next(attachment) == ProcessOutputEvent(type="stdout", sequence=1, data="hello\n")
    attachment.send_input("print(1)\n")
    attachment.close_stdin()
    attachment.resize(120, 40)
    attachment.signal("SIGINT")
    attachment.close()

    start_body = json.loads(requests[0].content)
    assert start_body["pty"] == {"cols": 80, "rows": 24}
    assert (
        websocket["uri"] == "wss://50000-abc123.sandboxes.example.com/processes/42/stream?after=0"
    )
    assert websocket["subprotocols"] == [
        "fissionplane.v1",
        "fissionplane.token.dG9rZW4rLyB2YWx1ZQ",
    ]
    assert json.loads(connection.sent[2]) == {"type": "resize", "cols": 120, "rows": 40}
    assert connection.closed is True


def test_malformed_known_process_frame_raises() -> None:
    connection = FakeSyncConnection(['{"type":"stdout","sequence":"one","data":"x"}'])
    attachment = ProcessAttachment(connection)
    with pytest.raises(StreamingProtocolError, match="sequence"):
        next(attachment)


def test_process_attachment_requires_streaming_subprotocol() -> None:
    connection = FakeSyncConnection([])
    connection.subprotocol = None
    with pytest.raises(StreamingProtocolError, match="server did not select"):
        ProcessAttachment(connection)


def test_async_file_watch_auth_url_and_parsing() -> None:
    connection = FakeAsyncConnection(
        [
            '{"type":"newer"}',
            ('{"type":"moved","sequence":3,"path":"/b","old_path":"/a","kind":"file"}'),
        ]
    )
    websocket: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/sandboxes":
            return create_response()
        raise AssertionError(f"unexpected HTTP request: {request.url}")

    async def connect(
        uri: str, *, subprotocols: Sequence[str] | None = None
    ) -> FakeAsyncConnection:
        websocket["uri"] = uri
        websocket["subprotocols"] = subprotocols
        return connection

    async def scenario() -> None:
        sandbox = await AsyncFissionPlane(
            api_key="key",
            base_url=BASE_URL,
            httpx_args={"transport": httpx.MockTransport(handler)},
            websocket_connect=connect,
        ).sandboxes.create("base")
        watch = await sandbox.files.watch("/workspace a", recursive=True, after=2)
        event = await anext(watch)
        assert isinstance(event, FileMoveEvent)
        assert event.old_path == "/a"
        await watch.close()

    asyncio.run(scenario())

    assert websocket["uri"] == (
        "wss://50000-abc123.sandboxes.example.com/files/watch"
        "?path=%2Fworkspace+a&recursive=true&after=2"
    )
    assert websocket["subprotocols"] == [
        "fissionplane.v1",
        "fissionplane.token.dG9rZW4rLyB2YWx1ZQ",
    ]
    assert connection.closed is True
