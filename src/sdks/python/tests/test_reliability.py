"""Timeouts, identity, retries, overrides, and credential validation.

These behaviours live entirely in the handwritten layer: the generated
cores issue one request with whatever the client was configured with, so
everything asserted here is the wrapper's own doing. The mock transport
sees the fully built request, which is where the timeout, the
``User-Agent``, and per-call headers become observable.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from fissionplane import (
    AsyncFissionPlane,
    FissionPlane,
    FissionPlaneError,
    RateLimitError,
    __version__,
)
from fissionplane import _retry as retry_module
from fissionplane._version import FALLBACK_VERSION

BASE_URL = "http://control-plane.test"
DATAPLANE_ORIGIN = "https://50000-abc123.sandboxes.example.com"
PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


@pytest.fixture(autouse=True)
def _instant_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the backoff schedule out of the test clock."""
    monkeypatch.setattr(retry_module, "_sleep", lambda _seconds: None)

    async def no_wait(_seconds: float) -> None:
        return None

    monkeypatch.setattr(retry_module, "_async_sleep", no_wait)


def sandbox_body(sandbox_id: str = "abc123", **overrides: Any) -> dict:
    body = {
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
    body.update(overrides)
    return body


def token_body() -> dict:
    return {"token": "cap-epoch-1", "expires_at": "2026-07-28T12:30:00Z", "epoch": 1}


def created() -> httpx.Response:
    return httpx.Response(201, json={"sandbox": sandbox_body(), "token": token_body()})


def make_client(handler, **kwargs: Any) -> FissionPlane:
    return FissionPlane(
        api_key="key123",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
        **kwargs,
    )


def make_async_client(handler, **kwargs: Any) -> AsyncFissionPlane:
    return AsyncFissionPlane(
        api_key="key123",
        base_url=BASE_URL,
        httpx_args={"transport": httpx.MockTransport(handler)},
        **kwargs,
    )


class TestVersion:
    def test_fallback_matches_pyproject(self) -> None:
        match = re.search(r'^version = "([^"]+)"', PYPROJECT.read_text(), re.MULTILINE)
        assert match is not None
        assert match.group(1) == FALLBACK_VERSION


class TestUserAgent:
    def test_control_and_data_plane_carry_the_sdk_user_agent(self) -> None:
        agents: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            agents.append(request.headers.get("User-Agent"))
            if request.url.path == "/v1/sandboxes":
                return created()
            return httpx.Response(200, json={"exit_code": 0, "stdout": "", "stderr": ""})

        sandbox = make_client(handler).sandboxes.create("base")
        sandbox.commands.run("true")

        assert agents == [f"fissionplane-python/{__version__}"] * 2

    def test_caller_headers_override_the_default_user_agent(self) -> None:
        agents: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            agents.append(request.headers.get("User-Agent"))
            return created()

        FissionPlane(
            api_key="key123",
            base_url=BASE_URL,
            httpx_args={
                "transport": httpx.MockTransport(handler),
                "headers": {"User-Agent": "my-app/9"},
            },
        ).sandboxes.create("base")

        assert agents == ["my-app/9"]

    def test_async_carries_the_sdk_user_agent(self) -> None:
        agents: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            agents.append(request.headers.get("User-Agent"))
            return created()

        async def scenario() -> None:
            await make_async_client(handler).sandboxes.create("base")

        asyncio.run(scenario())

        assert agents == [f"fissionplane-python/{__version__}"]


def _read_timeout(request: httpx.Request) -> float | None:
    timeout = request.extensions.get("timeout")
    assert isinstance(timeout, dict)
    return timeout["read"]


class TestTimeouts:
    def test_default_is_sixty_seconds_on_both_planes(self) -> None:
        timeouts: list[float | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            timeouts.append(_read_timeout(request))
            if request.url.path == "/v1/sandboxes":
                return created()
            return httpx.Response(200, json={"exit_code": 0, "stdout": "", "stderr": ""})

        sandbox = make_client(handler).sandboxes.create("base")
        sandbox.commands.run("true")

        assert timeouts == [60.0, 60.0]

    def test_client_default_is_configurable_and_zero_disables_it(self) -> None:
        timeouts: list[float | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            timeouts.append(_read_timeout(request))
            return created()

        make_client(handler, request_timeout=5).sandboxes.create("base")
        make_client(handler, request_timeout=0).sandboxes.create("base")

        assert timeouts == [5.0, None]

    def test_httpx_args_timeout_wins_over_request_timeout(self) -> None:
        timeouts: list[float | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            timeouts.append(_read_timeout(request))
            return created()

        FissionPlane(
            api_key="key123",
            base_url=BASE_URL,
            httpx_args={
                "transport": httpx.MockTransport(handler),
                "timeout": httpx.Timeout(3.5),
            },
            request_timeout=60,
        ).sandboxes.create("base")

        assert timeouts == [3.5]

    def test_per_call_override_applies_to_one_call_only(self) -> None:
        timeouts: list[float | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            timeouts.append(_read_timeout(request))
            return httpx.Response(200, json=sandbox_body())

        sandboxes = make_client(handler).sandboxes
        sandboxes.get("abc123", request_timeout=0.5)
        sandboxes.get("abc123")

        assert timeouts == [0.5, 60.0]

    def test_per_call_override_reaches_the_data_plane(self) -> None:
        timeouts: list[float | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/sandboxes":
                return created()
            timeouts.append(_read_timeout(request))
            return httpx.Response(200, json={"exit_code": 0, "stdout": "", "stderr": ""})

        sandbox = make_client(handler).sandboxes.create("base")
        sandbox.commands.run("true", request_timeout=2)
        sandbox.files.write("/tmp/a", b"x", request_timeout=0)

        assert timeouts == [2.0, None]

    def test_async_per_call_override_applies_to_one_call_only(self) -> None:
        timeouts: list[float | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            timeouts.append(_read_timeout(request))
            return httpx.Response(200, json=sandbox_body())

        async def scenario() -> None:
            sandboxes = make_async_client(handler).sandboxes
            await sandboxes.get("abc123", request_timeout=0.5)
            await sandboxes.get("abc123")

        asyncio.run(scenario())

        assert timeouts == [0.5, 60.0]


class TestPerCallHeaders:
    def test_headers_apply_to_one_call_only(self) -> None:
        traces: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            traces.append(request.headers.get("X-Trace"))
            return httpx.Response(200, json=sandbox_body())

        sandboxes = make_client(handler).sandboxes
        sandboxes.get("abc123", headers={"X-Trace": "t1"})
        sandboxes.get("abc123")

        assert traces == ["t1", None]

    def test_async_headers_apply_to_one_call_only(self) -> None:
        traces: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            traces.append(request.headers.get("X-Trace"))
            return httpx.Response(200, json=sandbox_body())

        async def scenario() -> None:
            sandboxes = make_async_client(handler).sandboxes
            await sandboxes.get("abc123", headers={"X-Trace": "t1"})
            await sandboxes.get("abc123")

        asyncio.run(scenario())

        assert traces == ["t1", None]


def _counting_handler(response: httpx.Response, counter: list[int]):
    def handler(_: httpx.Request) -> httpx.Response:
        counter.append(1)
        return response

    return handler


class TestRetries:
    def test_read_retries_up_to_three_attempts(self) -> None:
        attempts: list[int] = []
        handler = _counting_handler(
            httpx.Response(503, json={"code": "unavailable", "message": "later"}), attempts
        )

        with pytest.raises(FissionPlaneError):
            make_client(handler).sandboxes.get("abc123")

        assert len(attempts) == 3

    def test_max_retries_zero_issues_one_request(self) -> None:
        attempts: list[int] = []
        handler = _counting_handler(httpx.Response(503, json={}), attempts)

        with pytest.raises(FissionPlaneError):
            make_client(handler, max_retries=0).sandboxes.get("abc123")

        assert len(attempts) == 1

    def test_retryable_false_is_honoured(self) -> None:
        attempts: list[int] = []
        handler = _counting_handler(
            httpx.Response(
                429,
                json={"code": "quota_exceeded", "message": "no", "retryable": False},
            ),
            attempts,
        )

        with pytest.raises(RateLimitError):
            make_client(handler).sandboxes.list()

        assert len(attempts) == 1

    def test_retryable_true_is_honoured(self) -> None:
        attempts: list[int] = []
        handler = _counting_handler(
            httpx.Response(
                429,
                json={"code": "quota_exceeded", "message": "soon", "retryable": True},
            ),
            attempts,
        )

        with pytest.raises(RateLimitError):
            make_client(handler).sandboxes.list()

        assert len(attempts) == 3

    def test_transport_error_on_a_read_is_retried_then_succeeds(self) -> None:
        attempts: list[int] = []

        def handler(_: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) == 1:
                raise httpx.ConnectError("connection refused")
            return httpx.Response(200, json=sandbox_body())

        assert make_client(handler).sandboxes.get("abc123").sandbox_id == "abc123"
        assert len(attempts) == 2

    def test_create_without_an_idempotency_key_is_never_retried(self) -> None:
        attempts: list[int] = []
        handler = _counting_handler(
            httpx.Response(503, json={"code": "unavailable", "message": "later"}), attempts
        )

        with pytest.raises(FissionPlaneError):
            make_client(handler).sandboxes.create("base")

        assert len(attempts) == 1

    def test_create_with_an_idempotency_key_is_retried(self) -> None:
        attempts: list[int] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            assert request.headers["Idempotency-Key"] == "idem-1"
            if len(attempts) < 3:
                return httpx.Response(503, json={"code": "unavailable", "message": "later"})
            return created()

        sandbox = make_client(handler).sandboxes.create("base", idempotency_key="idem-1")

        assert sandbox.sandbox_id == "abc123"
        assert len(attempts) == 3

    def test_async_read_retries_then_succeeds(self) -> None:
        attempts: list[int] = []

        def handler(_: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) < 3:
                return httpx.Response(503, json={"code": "unavailable", "message": "later"})
            return httpx.Response(200, json=sandbox_body())

        async def scenario() -> str:
            return (await make_async_client(handler).sandboxes.get("abc123")).sandbox_id

        assert asyncio.run(scenario()) == "abc123"
        assert len(attempts) == 3

    def test_async_create_without_a_key_is_never_retried(self) -> None:
        attempts: list[int] = []
        handler = _counting_handler(
            httpx.Response(503, json={"code": "unavailable", "message": "later"}), attempts
        )

        async def scenario() -> None:
            await make_async_client(handler).sandboxes.create("base")

        with pytest.raises(FissionPlaneError):
            asyncio.run(scenario())

        assert len(attempts) == 1


class RecordingHandler(logging.Handler):
    def __init__(self, records: list[logging.LogRecord]) -> None:
        super().__init__()
        self._records = records

    def emit(self, record: logging.LogRecord) -> None:
        self._records.append(record)


class TestLogger:
    def test_retries_and_page_fetches_reach_the_default_logger(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"items": [], "next_cursor": None})

        with caplog.at_level(logging.DEBUG, logger="fissionplane"):
            make_client(handler).sandboxes.list()

        assert any("listing sandboxes" in record.message for record in caplog.records)

    def test_a_supplied_logger_receives_retry_reports(self) -> None:
        logger = logging.getLogger("test.fissionplane.retry")
        logger.setLevel(logging.DEBUG)
        records: list[logging.LogRecord] = []
        handler = RecordingHandler(records)
        logger.addHandler(handler)

        def respond(_: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"code": "unavailable", "message": "later"})

        try:
            with pytest.raises(FissionPlaneError):
                make_client(respond, logger=logger, max_retries=1).sandboxes.get("abc123")
        finally:
            logger.removeHandler(handler)

        assert [record.getMessage() for record in records if "retrying" in record.getMessage()]

    def test_async_retry_reports_reach_the_supplied_logger(self) -> None:
        logger = logging.getLogger("test.fissionplane.retry.async")
        logger.setLevel(logging.DEBUG)
        records: list[logging.LogRecord] = []
        handler = RecordingHandler(records)
        logger.addHandler(handler)

        def respond(_: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"code": "unavailable", "message": "later"})

        async def scenario() -> None:
            client = make_async_client(respond, logger=logger, max_retries=1)
            await client.sandboxes.get("abc123")

        try:
            with pytest.raises(FissionPlaneError):
                asyncio.run(scenario())
        finally:
            logger.removeHandler(handler)

        assert [record.getMessage() for record in records if "retrying" in record.getMessage()]


class TestCredentialValidation:
    @pytest.mark.parametrize("api_key", ["", "  ", "key with space", "key\n"])
    def test_malformed_api_keys_are_rejected_at_construction(self, api_key: str) -> None:
        with pytest.raises(ValueError, match="FISSIONPLANE_API_KEY"):
            FissionPlane(api_key=api_key, base_url=BASE_URL)

    def test_malformed_environment_api_key_is_rejected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("FISSIONPLANE_API_KEY", "bad key")
        with pytest.raises(ValueError, match="api_key"):
            FissionPlane(base_url=BASE_URL)

    def test_malformed_access_token_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="access_token"):
            FissionPlane(access_token="tok en", base_url=BASE_URL)

    def test_async_malformed_api_key_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="FISSIONPLANE_API_KEY"):
            AsyncFissionPlane(api_key="bad key", base_url=BASE_URL)

    def test_a_valid_key_still_builds(self) -> None:
        assert FissionPlane(api_key="key123", base_url=BASE_URL).api is not None
