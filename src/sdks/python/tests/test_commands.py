"""The data-plane command surface, driven against a mock transport.

The same ``httpx.MockTransport`` serves both planes: the control plane
at ``BASE_URL`` and the data plane at the sandbox's own hostname, which
is how the SDK is wired in production (one ``httpx_args`` for both).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from fissionplane import AsyncFissionPlane, CommandTimeoutError, FissionPlane, FissionPlaneError

BASE_URL = "http://control-plane.test"
DATAPLANE_ORIGIN = "https://50000-abc123.sandboxes.example.com"


def sandbox_body(epoch: int = 1) -> dict:
    return {
        "sandbox_id": "abc123",
        "state": "running",
        "template_artifact_id": "art1",
        "epoch": epoch,
        "domain": "sandboxes.example.com",
        "created_at": "2026-07-28T12:00:00Z",
        "deadline": "2026-07-28T13:00:00Z",
        "resources": {"vcpus": 2, "mem_mib": 1024},
        "metadata": {},
    }


def token_body(epoch: int = 1) -> dict:
    return {
        "token": f"cap-epoch-{epoch}",
        "expires_at": "2026-07-28T12:30:00Z",
        "epoch": epoch,
    }


def result_body(**overrides: Any) -> dict:
    body = {"exit_code": 0, "stdout": "", "stderr": "", "truncated": False}
    body.update(overrides)
    return body


def make_client(handler) -> FissionPlane:
    return FissionPlane(
        api_key="key123",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
    )


class TestRun:
    def test_run_hits_dataplane_with_token_and_body(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})
            seen["url"] = str(request.url)
            seen["token"] = request.headers.get("X-Sandbox-Token")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=result_body(stdout="Python 3.12.0\n"))

        sandbox = make_client(handler).sandboxes.create("base")
        result = sandbox.commands.run(
            "python",
            args=["-V"],
            cwd="/srv",
            env={"DEBUG": "1"},
            stdin="quit()\n",
            timeout_seconds=30,
        )

        assert seen["url"] == f"{DATAPLANE_ORIGIN}/commands"
        assert seen["token"] == "cap-epoch-1"
        assert seen["body"] == {
            "command": "python",
            "args": ["-V"],
            "cwd": "/srv",
            "env": {"DEBUG": "1"},
            "stdin": "quit()\n",
            "timeout_seconds": 30,
        }
        assert result.exit_code == 0
        assert result.stdout == "Python 3.12.0\n"

    def test_timeout_maps_to_command_timeout_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})
            return httpx.Response(
                408,
                json={"code": "command_timeout", "message": "did not exit within 30s"},
            )

        sandbox = make_client(handler).sandboxes.create("base")

        with pytest.raises(CommandTimeoutError) as excinfo:
            sandbox.commands.run("sleep", args=["60"], timeout_seconds=30)
        assert excinfo.value.status == 408
        assert excinfo.value.code == "command_timeout"

    def test_missing_token_raises_with_helpful_message(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/sandboxes/abc123"
            return httpx.Response(200, json=sandbox_body())

        # A plain get mints nothing, so the handle has no data-plane credential.
        sandbox = make_client(handler).sandboxes.get("abc123")

        with pytest.raises(FissionPlaneError, match="mint_token"):
            sandbox.commands.run("ls")

    def test_run_after_resume_sends_new_token(self) -> None:
        tokens_seen: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return httpx.Response(
                    201, json={"sandbox": sandbox_body(), "token": token_body(epoch=1)}
                )
            if request.url.path == "/v1/sandboxes/abc123/resume":
                return httpx.Response(
                    200,
                    json={"sandbox": sandbox_body(epoch=2), "token": token_body(epoch=2)},
                )
            tokens_seen.append(request.headers.get("X-Sandbox-Token"))
            return httpx.Response(200, json=result_body())

        sandbox = make_client(handler).sandboxes.create("base")
        sandbox.commands.run("true")
        sandbox.resume()
        sandbox.commands.run("true")

        assert tokens_seen == ["cap-epoch-1", "cap-epoch-2"]


class TestProcesses:
    def test_kill_sends_signal_query_param(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})
            seen["method"] = request.method
            seen["path"] = request.url.path
            seen["signal"] = request.url.params.get("signal")
            return httpx.Response(204)

        sandbox = make_client(handler).sandboxes.create("base")
        assert sandbox.commands.kill(4242, signal="SIGKILL") is None

        assert seen["method"] == "DELETE"
        assert seen["path"] == "/processes/4242"
        assert seen["signal"] == "SIGKILL"

    def test_list_processes_unwraps_items(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})
            assert str(request.url) == f"{DATAPLANE_ORIGIN}/processes"
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "pid": 1,
                            "command": "init",
                            "started_at": "2026-07-28T12:00:00Z",
                            "running": True,
                            "pty": False,
                        },
                        {
                            "pid": 42,
                            "command": "python",
                            "started_at": "2026-07-28T12:01:00Z",
                            "running": True,
                            "pty": False,
                        },
                    ]
                },
            )

        processes = make_client(handler).sandboxes.create("base").commands.list_processes()
        assert [p.pid for p in processes] == [1, 42]


class TestAsyncCommands:
    def test_async_run_sends_token(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})
            seen["url"] = str(request.url)
            seen["token"] = request.headers.get("X-Sandbox-Token")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=result_body(stdout="hello\n"))

        async def scenario() -> None:
            client = AsyncFissionPlane(
                api_key="key123",
                base_url=BASE_URL,
                httpx_args={"transport": httpx.MockTransport(handler)},
            )
            sandbox = await client.sandboxes.create("base")
            result = await sandbox.commands.run("echo", args=["hello"])
            assert result.stdout == "hello\n"

        asyncio.run(scenario())

        assert seen["url"] == f"{DATAPLANE_ORIGIN}/commands"
        assert seen["token"] == "cap-epoch-1"
        assert seen["body"] == {"command": "echo", "args": ["hello"]}
