"""Capability tokens re-minted when the data plane rejects them.

A capability token expires on its own schedule and dies with its epoch,
so a 401 from the data plane is routine. The handle owns the control-plane
credential that can mint a replacement, so it does — once, then reissues
the call. The mock transport lets the token the second request carries be
read straight off the wire.
"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator, Callable, Iterator, Sequence

import httpx
import pytest
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response as HandshakeResponse

from fissionplane import AsyncFissionPlane, AuthenticationError, FissionPlane

BASE_URL = "http://control-plane.test"
MINT_PATH = "/v1/sandboxes/abc123/token"


def sandbox_body() -> dict:
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


def token_body(token: str) -> dict:
    return {"token": token, "expires_at": "2026-07-28T12:30:00Z", "epoch": 1}


def unauthorized() -> httpx.Response:
    return httpx.Response(401, json={"code": "invalid_token", "message": "expired"})


def result_body() -> dict:
    return {"exit_code": 0, "stdout": "ok", "stderr": "", "truncated": False}


class FakeSyncConnection:
    def __init__(self) -> None:
        self.subprotocol: str | None = "fissionplane.v1"
        self.closed = False

    def __iter__(self) -> Iterator[str | bytes]:
        return iter([])

    def send(self, message: str) -> None:
        raise AssertionError("unexpected send")

    def close(self) -> None:
        self.closed = True


class FakeAsyncConnection:
    def __init__(self) -> None:
        self.subprotocol: str | None = "fissionplane.v1"
        self.closed = False

    async def _empty(self) -> AsyncIterator[str | bytes]:
        for message in ():
            yield message

    def __aiter__(self) -> AsyncIterator[str | bytes]:
        return self._empty()

    async def send(self, message: str) -> None:
        raise AssertionError("unexpected send")

    async def close(self) -> None:
        self.closed = True


def handshake_401() -> InvalidStatus:
    return InvalidStatus(HandshakeResponse(401, "Unauthorized", Headers()))


def encoded(token: str) -> str:
    return "fissionplane.token." + base64.urlsafe_b64encode(token.encode()).decode().rstrip("=")


def make_handler(
    tokens: list[str | None], dataplane: list[httpx.Response]
) -> Callable[[httpx.Request], httpx.Response]:
    """A transport that mints ``cap-fresh`` and serves canned data-plane replies."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/sandboxes":
            return httpx.Response(
                201, json={"sandbox": sandbox_body(), "token": token_body("cap-stale")}
            )
        if request.url.path == MINT_PATH:
            return httpx.Response(201, json=token_body("cap-fresh"))
        tokens.append(request.headers.get("X-Sandbox-Token"))
        return dataplane.pop(0)

    return handler


class TestHttpRefresh:
    def test_command_run_remints_and_retries_once(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [unauthorized(), httpx.Response(200, json=result_body())])

        sandbox = FissionPlane(
            api_key="key123",
            base_url=BASE_URL,
            httpx_args={"transport": httpx.MockTransport(handler)},
        ).sandboxes.create("base")
        result = sandbox.commands.run("true")

        assert result.stdout == "ok"
        assert tokens == ["cap-stale", "cap-fresh"]
        assert sandbox.token is not None
        assert sandbox.token.token == "cap-fresh"

    def test_file_read_remints_and_retries_once(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [unauthorized(), httpx.Response(200, content=b"abc")])

        sandbox = FissionPlane(
            api_key="key123",
            base_url=BASE_URL,
            httpx_args={"transport": httpx.MockTransport(handler)},
        ).sandboxes.create("base")

        assert sandbox.files.read("/workspace/a.txt") == b"abc"
        assert tokens == ["cap-stale", "cap-fresh"]

    def test_a_still_unauthorized_retry_surfaces_the_error(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [unauthorized(), unauthorized()])

        sandbox = FissionPlane(
            api_key="key123",
            base_url=BASE_URL,
            httpx_args={"transport": httpx.MockTransport(handler)},
        ).sandboxes.create("base")

        with pytest.raises(AuthenticationError):
            sandbox.commands.run("true")
        assert tokens == ["cap-stale", "cap-fresh"]

    def test_async_command_run_remints_and_retries_once(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [unauthorized(), httpx.Response(200, json=result_body())])

        async def scenario() -> str:
            sandbox = await AsyncFissionPlane(
                api_key="key123",
                base_url=BASE_URL,
                httpx_args={"transport": httpx.MockTransport(handler)},
            ).sandboxes.create("base")
            return (await sandbox.commands.run("true")).stdout

        assert asyncio.run(scenario()) == "ok"
        assert tokens == ["cap-stale", "cap-fresh"]

    def test_async_file_read_remints_and_retries_once(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [unauthorized(), httpx.Response(200, content=b"abc")])

        async def scenario() -> bytes:
            sandbox = await AsyncFissionPlane(
                api_key="key123",
                base_url=BASE_URL,
                httpx_args={"transport": httpx.MockTransport(handler)},
            ).sandboxes.create("base")
            return await sandbox.files.read("/workspace/a.txt")

        assert asyncio.run(scenario()) == b"abc"
        assert tokens == ["cap-stale", "cap-fresh"]


class TestStreamRefresh:
    def test_attach_remints_after_an_unauthorized_handshake(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [])
        attempts: list[Sequence[str] | None] = []

        def connect(uri: str, *, subprotocols: Sequence[str] | None = None) -> FakeSyncConnection:
            del uri
            attempts.append(subprotocols)
            if len(attempts) == 1:
                raise handshake_401()
            return FakeSyncConnection()

        sandbox = FissionPlane(
            api_key="key123",
            base_url=BASE_URL,
            httpx_args={"transport": httpx.MockTransport(handler)},
            websocket_connect=connect,
        ).sandboxes.create("base")
        attachment = sandbox.commands.attach(42)
        attachment.close()

        assert attempts[0] is not None
        assert attempts[1] is not None
        assert attempts[0][1] == encoded("cap-stale")
        assert attempts[1][1] == encoded("cap-fresh")

    def test_watch_reraises_a_handshake_failure_the_remint_cannot_fix(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [])
        attempts: list[Sequence[str] | None] = []

        def connect(uri: str, *, subprotocols: Sequence[str] | None = None) -> FakeSyncConnection:
            del uri
            attempts.append(subprotocols)
            raise handshake_401()

        sandbox = FissionPlane(
            api_key="key123",
            base_url=BASE_URL,
            httpx_args={"transport": httpx.MockTransport(handler)},
            websocket_connect=connect,
        ).sandboxes.create("base")

        with pytest.raises(InvalidStatus):
            sandbox.files.watch("/workspace")
        assert len(attempts) == 2

    def test_async_attach_remints_after_an_unauthorized_handshake(self) -> None:
        tokens: list[str | None] = []
        handler = make_handler(tokens, [])
        attempts: list[Sequence[str] | None] = []

        async def connect(
            uri: str, *, subprotocols: Sequence[str] | None = None
        ) -> FakeAsyncConnection:
            del uri
            attempts.append(subprotocols)
            if len(attempts) == 1:
                raise handshake_401()
            return FakeAsyncConnection()

        async def scenario() -> None:
            sandbox = await AsyncFissionPlane(
                api_key="key123",
                base_url=BASE_URL,
                httpx_args={"transport": httpx.MockTransport(handler)},
                websocket_connect=connect,
            ).sandboxes.create("base")
            watch = await sandbox.files.watch("/workspace")
            await watch.close()

        asyncio.run(scenario())

        assert attempts[0] is not None
        assert attempts[1] is not None
        assert attempts[0][1] == encoded("cap-stale")
        assert attempts[1][1] == encoded("cap-fresh")
