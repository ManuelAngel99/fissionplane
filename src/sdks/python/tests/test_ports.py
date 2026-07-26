"""Port exposure records, driven against a mock control plane."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from fissionplane import AsyncFissionPlane, FissionPlane, PortVisibility

BASE_URL = "http://control-plane.test"


def sandbox_body(sandbox_id: str = "abc123") -> dict:
    return {
        "sandbox_id": sandbox_id,
        "state": "running",
        "template_artifact_id": "art1",
        "epoch": 1,
        "domain": "sandboxes.example.com",
        "created_at": "2026-07-28T12:00:00Z",
        "deadline": "2026-07-28T13:00:00Z",
        "resources": {"vcpus": 2, "mem_mib": 1024},
        "metadata": {},
    }


def exposure_body(port: int, visibility: str = "public") -> dict:
    return {
        "port": port,
        "visibility": visibility,
        "url": f"https://{port}-abc123.sandboxes.example.com",
    }


def make_sandbox(handler):
    client = FissionPlane(
        api_key="key123",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
    )
    return client.sandboxes.get("abc123")


class TestPorts:
    def test_expose_sends_put_with_visibility_body(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes/abc123":
                return httpx.Response(200, json=sandbox_body())
            seen["method"] = request.method
            seen["path"] = request.url.path
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=exposure_body(8080))

        exposure = make_sandbox(handler).ports.expose(8080, "public")

        assert seen["method"] == "PUT"
        assert seen["path"] == "/v1/sandboxes/abc123/ports/8080"
        assert seen["body"] == {"visibility": "public"}
        assert exposure.port == 8080
        assert exposure.visibility == PortVisibility.PUBLIC
        assert exposure.url == "https://8080-abc123.sandboxes.example.com"

    def test_unexpose_returns_none_on_204(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes/abc123":
                return httpx.Response(200, json=sandbox_body())
            assert request.method == "DELETE"
            assert request.url.path == "/v1/sandboxes/abc123/ports/8080"
            return httpx.Response(204)

        assert make_sandbox(handler).ports.unexpose(8080) is None

    def test_list_unwraps_items(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes/abc123":
                return httpx.Response(200, json=sandbox_body())
            assert request.url.path == "/v1/sandboxes/abc123/ports"
            return httpx.Response(
                200,
                json={"items": [exposure_body(3000), exposure_body(8080, "private")]},
            )

        exposures = make_sandbox(handler).ports.list()

        assert [e.port for e in exposures] == [3000, 8080]
        assert exposures[1].visibility == PortVisibility.PRIVATE


class TestAsyncPorts:
    def test_async_expose(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes/abc123":
                return httpx.Response(200, json=sandbox_body())
            seen["method"] = request.method
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=exposure_body(3000, "private"))

        async def scenario() -> None:
            client = AsyncFissionPlane(
                api_key="key123",
                base_url=BASE_URL,
                httpx_args={"transport": httpx.MockTransport(handler)},
            )
            sandbox = await client.sandboxes.get("abc123")
            exposure = await sandbox.ports.expose(3000, PortVisibility.PRIVATE)
            assert exposure.visibility == PortVisibility.PRIVATE

        asyncio.run(scenario())

        assert seen["method"] == "PUT"
        assert seen["body"] == {"visibility": "private"}
