"""The handwritten wrapper, driven against a mock control plane.

These tests cover the layer the generator does not: credential wiring,
error mapping, token re-arming across resume, pagination, and hostname
construction. The generated core itself is covered by the drift check —
it is exactly what the specification says it is.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from fissionplane import (
    AsyncFissionPlane,
    ConflictError,
    FissionPlane,
    NotFoundError,
    RateLimitError,
    SandboxState,
)

BASE_URL = "http://control-plane.test"


def sandbox_body(sandbox_id: str = "abc123", epoch: int = 1, **overrides: Any) -> dict:
    body = {
        "sandbox_id": sandbox_id,
        "state": "running",
        "template_artifact_id": "art1",
        "epoch": epoch,
        "domain": "sandboxes.example.com",
        "created_at": "2026-07-28T12:00:00Z",
        "deadline": "2026-07-28T13:00:00Z",
        "resources": {"vcpus": 2, "mem_mib": 1024},
        "metadata": {},
    }
    body.update(overrides)
    return body


def token_body(epoch: int = 1) -> dict:
    return {
        "token": f"cap-epoch-{epoch}",
        "expires_at": "2026-07-28T12:30:00Z",
        "epoch": epoch,
    }


def make_client(handler) -> FissionPlane:
    return FissionPlane(
        api_key="key123",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
    )


def make_async_client(handler) -> AsyncFissionPlane:
    return AsyncFissionPlane(
        api_key="key123",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
    )


class TestCreate:
    def test_returns_handle_with_token_and_sends_credentials(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["method"] = request.method
            seen["path"] = request.url.path
            seen["api_key"] = request.headers.get("X-API-Key")
            seen["idempotency"] = request.headers.get("Idempotency-Key")
            seen["body"] = json.loads(request.content)
            return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})

        sandbox = make_client(handler).sandboxes.create(
            "base",
            name="job42",
            metadata={"run": "42"},
            idempotency_key="idem-1",
        )

        assert seen["method"] == "POST"
        assert seen["path"] == "/v1/sandboxes"
        assert seen["api_key"] == "key123"
        assert seen["idempotency"] == "idem-1"
        assert seen["body"] == {
            "template": "base",
            "name": "job42",
            "metadata": {"run": "42"},
        }
        assert sandbox.sandbox_id == "abc123"
        assert sandbox.token is not None
        assert sandbox.token.token == "cap-epoch-1"
        assert sandbox.hostname(3000) == "3000-abc123.sandboxes.example.com"

    def test_name_collision_maps_to_conflict(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                409,
                json={"code": "name_taken", "message": "name job42 exists"},
            )

        with pytest.raises(ConflictError) as excinfo:
            make_client(handler).sandboxes.create("base", name="job42")
        assert excinfo.value.code == "name_taken"
        assert excinfo.value.status == 409
        assert excinfo.value.retryable is False

    def test_quota_maps_to_rate_limit_with_retryable(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                429,
                json={
                    "code": "quota_exceeded",
                    "message": "concurrency limit",
                    "retryable": True,
                    "request_id": "req-9",
                },
            )

        with pytest.raises(RateLimitError) as excinfo:
            make_client(handler).sandboxes.create("base")
        assert excinfo.value.code == "quota_exceeded"
        assert excinfo.value.retryable is True
        assert excinfo.value.request_id == "req-9"


class TestLifecycle:
    def test_resume_rearms_token_for_new_epoch(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes/abc123":
                return httpx.Response(200, json=sandbox_body(epoch=1))
            assert request.url.path == "/v1/sandboxes/abc123/resume"
            return httpx.Response(
                200,
                json={"sandbox": sandbox_body(epoch=2), "token": token_body(epoch=2)},
            )

        sandbox = make_client(handler).sandboxes.get("abc123")
        assert sandbox.token is None  # a plain get mints nothing
        sandbox.resume(deadline_seconds=600)
        assert sandbox.info.epoch == 2
        assert sandbox.token is not None
        assert sandbox.token.epoch == 2

    def test_get_unknown_sandbox_maps_to_not_found(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"code": "not_found", "message": "nope"})

        with pytest.raises(NotFoundError):
            make_client(handler).sandboxes.get("zzz999")

    def test_delete_returns_none_on_204(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "DELETE"
            return httpx.Response(204)

        sandbox_handler_client = make_client(lambda _: httpx.Response(200, json=sandbox_body()))
        sandbox = sandbox_handler_client.sandboxes.get("abc123")
        # Re-point the underlying httpx client at the delete handler.
        sandbox._api.set_httpx_client(
            httpx.Client(
                transport=httpx.MockTransport(handler),
                base_url=BASE_URL,
                headers={"X-API-Key": "key123"},
            )
        )
        assert sandbox.delete() is None


class TestList:
    def test_iterate_follows_cursors_and_encodes_filters(self) -> None:
        pages: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            params = dict(request.url.params)
            pages.append(params)
            if params.get("cursor") is None:
                return httpx.Response(
                    200,
                    json={
                        "items": [sandbox_body("aaa111")],
                        "next_cursor": "page2",
                    },
                )
            return httpx.Response(
                200, json={"items": [sandbox_body("bbb222")], "next_cursor": None}
            )

        ids = [
            s.sandbox_id
            for s in make_client(handler).sandboxes.iterate(
                state=SandboxState.RUNNING, metadata={"run": "42", "user": "alice"}
            )
        ]

        assert ids == ["aaa111", "bbb222"]
        assert pages[0]["state"] == "running"
        assert pages[0]["metadata"] == "run=42&user=alice"
        assert pages[1]["cursor"] == "page2"

    def test_async_iterate_follows_cursors_across_three_pages(self) -> None:
        pages: list[dict[str, Any]] = []
        cursors = {None: "page2", "page2": "page3", "page3": None}
        bodies = {None: "aaa111", "page2": "bbb222", "page3": "ccc333"}

        def handler(request: httpx.Request) -> httpx.Response:
            params = dict(request.url.params)
            pages.append(params)
            cursor = params.get("cursor")
            return httpx.Response(
                200,
                json={
                    "items": [sandbox_body(bodies[cursor])],
                    "next_cursor": cursors[cursor],
                },
            )

        async def scenario() -> list[str]:
            client = make_async_client(handler)
            return [s.sandbox_id async for s in client.sandboxes.iterate(limit=1)]

        assert asyncio.run(scenario()) == ["aaa111", "bbb222", "ccc333"]
        assert [page.get("cursor") for page in pages] == [None, "page2", "page3"]
        assert pages[0]["limit"] == "1"


class TestAsync:
    def test_async_create_and_pause(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})
            assert request.url.path == "/v1/sandboxes/abc123/pause"
            return httpx.Response(200, json=sandbox_body(state="paused"))

        async def scenario() -> None:
            client = make_async_client(handler)
            sandbox = await client.sandboxes.create("base")
            assert sandbox.token is not None
            info = await sandbox.pause()
            assert info.state == SandboxState.PAUSED

        asyncio.run(scenario())
