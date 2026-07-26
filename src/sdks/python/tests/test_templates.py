"""Template builds, driven against a mock control plane.

``wait`` is tested with an injected no-op sleep, so the polling loop
runs without slowing the suite down.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from fissionplane import (
    AsyncFissionPlane,
    BuildStep,
    FissionPlane,
    Resources,
    TemplateBuildError,
    TemplateBuildStatus,
)

BASE_URL = "http://control-plane.test"


def build_body(status: str = "queued", **overrides: Any) -> dict:
    body = {
        "build_id": "b1",
        "status": status,
        "image": "python:3.12",
        "created_at": "2026-07-28T12:00:00Z",
    }
    body.update(overrides)
    return body


def make_client(handler) -> FissionPlane:
    return FissionPlane(
        api_key="key123",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
    )


class TestBuild:
    def test_build_passes_request_body_through(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["method"] = request.method
            seen["path"] = request.url.path
            seen["body"] = json.loads(request.content)
            return httpx.Response(201, json=build_body())

        build = make_client(handler).templates.build(
            "python:3.12",
            alias="py",
            steps=[BuildStep(command="pip install flask")],
            start_command="python app.py",
            ready_command="curl -sf localhost:8000",
            resources=Resources(vcpus=2, mem_mib=1024),
        )

        assert seen["method"] == "POST"
        assert seen["path"] == "/v1/templates/builds"
        assert seen["body"] == {
            "image": "python:3.12",
            "alias": "py",
            "steps": [{"command": "pip install flask"}],
            "start_command": "python app.py",
            "ready_command": "curl -sf localhost:8000",
            "resources": {"vcpus": 2, "mem_mib": 1024},
        }
        assert build.build_id == "b1"
        assert build.info.status == TemplateBuildStatus.QUEUED

    def test_wait_polls_to_succeeded(self) -> None:
        statuses = iter(["queued", "building", "succeeded"])
        sleeps: list[float] = []

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/templates/builds/b1"
            return httpx.Response(200, json=build_body(next(statuses)))

        build = make_client(handler).templates.get_build("b1")
        info = build.wait(poll_interval=0.5, _sleep=sleeps.append)

        assert info.status == TemplateBuildStatus.SUCCEEDED
        assert build.info is info
        # One sleep per poll: queued -> building -> succeeded.
        assert sleeps == [0.5, 0.5]

    def test_wait_on_failed_raises_with_build_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=build_body("failed", error="step 3 exited with code 1"))

        build = make_client(handler).templates.get_build("b1")

        with pytest.raises(TemplateBuildError, match="step 3 exited with code 1"):
            build.wait(_sleep=lambda _: None)

    def test_logs_passes_offset_and_returns_next(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/templates/builds/b1":
                return httpx.Response(200, json=build_body("building"))
            assert request.url.path == "/v1/templates/builds/b1/logs"
            seen["offset"] = request.url.params.get("offset")
            return httpx.Response(
                200,
                json={
                    "entries": [
                        {"timestamp": "2026-07-28T12:00:01Z", "message": "step 1"},
                        {"timestamp": "2026-07-28T12:00:02Z", "message": "step 2"},
                    ],
                    "next_offset": 9,
                },
            )

        build = make_client(handler).templates.get_build("b1")
        entries, next_offset = build.logs(offset=7)

        assert seen["offset"] == "7"
        assert [e.message for e in entries] == ["step 1", "step 2"]
        assert next_offset == 9

    def test_delete_returns_none_on_204(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "DELETE"
            assert request.url.path == "/v1/templates/py"
            return httpx.Response(204)

        assert make_client(handler).templates.delete("py") is None


class TestAsyncBuild:
    def test_async_build_and_wait(self) -> None:
        statuses = iter(["building", "succeeded"])
        sleeps: list[float] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST":
                assert request.url.path == "/v1/templates/builds"
                return httpx.Response(201, json=build_body())
            assert request.url.path == "/v1/templates/builds/b1"
            return httpx.Response(200, json=build_body(next(statuses)))

        async def no_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        async def scenario() -> None:
            client = AsyncFissionPlane(
                api_key="key123",
                base_url=BASE_URL,
                httpx_args={"transport": httpx.MockTransport(handler)},
            )
            build = await client.templates.build("python:3.12")
            info = await build.wait(_sleep=no_sleep)
            assert info.status == TemplateBuildStatus.SUCCEEDED

        asyncio.run(scenario())

        # One sleep per poll: queued -> building -> succeeded.
        assert sleeps == [2.0, 2.0]
