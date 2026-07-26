"""The ``httpx`` wiring shared by the control plane and the data plane.

The generated cores build their own ``httpx`` clients from whatever the
constructor was handed, and their operations forward nothing per request.
So the SDK installs its own client on each generated core — carrying the
credential, the SDK ``User-Agent``, and the default timeout — and routes
per-call overrides to it through a context variable rather than through
the generated signatures.

Anything the caller puts in ``httpx_args`` wins: it is applied last.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

import httpx

from fissionplane._api.client import AuthenticatedClient as _ApiClient
from fissionplane._dataplane.client import AuthenticatedClient as _DataplaneClient
from fissionplane._version import USER_AGENT

DEFAULT_REQUEST_TIMEOUT = 60.0
"""Seconds a request may take before the SDK gives up on it."""

GeneratedClient = _ApiClient | _DataplaneClient
"""Either generated core's authenticated client; they share one shape."""


def to_timeout(seconds: float | None) -> httpx.Timeout:
    """Translate a request timeout in seconds into an ``httpx`` timeout.

    Args:
        seconds: The budget for one request. ``None`` or ``0`` disables
            the timeout, matching the convention callers expect from
            ``request_timeout``.

    Returns:
        The equivalent ``httpx`` timeout, applied to connect, read,
        write, and pool alike.
    """
    if seconds is None or seconds <= 0:
        return httpx.Timeout(None)
    return httpx.Timeout(seconds)


@dataclass(frozen=True)
class _Overrides:
    timeout: httpx.Timeout | None
    headers: dict[str, str] | None


_OVERRIDES: ContextVar[_Overrides | None] = ContextVar(
    "fissionplane_request_overrides", default=None
)


@contextmanager
def request_overrides(
    request_timeout: float | None,
    headers: Mapping[str, str] | None,
) -> Iterator[None]:
    """Apply per-call timeout and headers to requests made in this block.

    The overrides live in a context variable, so concurrent tasks each
    see their own: a task started before the block keeps the client
    defaults.

    Args:
        request_timeout: Seconds this call may take, or ``None`` to keep
            the client's default. ``0`` disables the timeout.
        headers: Headers added to the request, overriding any header of
            the same name set on the client.

    Yields:
        ``None``; the overrides are removed when the block exits.
    """
    if request_timeout is None and not headers:
        yield
        return
    overrides = _Overrides(
        timeout=to_timeout(request_timeout) if request_timeout is not None else None,
        headers=dict(headers) if headers else None,
    )
    reset_token = _OVERRIDES.set(overrides)
    try:
        yield
    finally:
        _OVERRIDES.reset(reset_token)


def _apply_overrides(request: httpx.Request) -> None:
    overrides = _OVERRIDES.get()
    if overrides is None:
        return
    if overrides.timeout is not None:
        request.extensions["timeout"] = overrides.timeout.as_dict()
    if overrides.headers is not None:
        for name, value in overrides.headers.items():
            request.headers[name] = value


class _OverridableClient(httpx.Client):
    """An ``httpx`` client that honours the ambient per-call overrides."""

    def send(self, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        _apply_overrides(request)
        return super().send(request, **kwargs)


class _OverridableAsyncClient(httpx.AsyncClient):
    """Async counterpart of :class:`_OverridableClient`."""

    async def send(self, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        _apply_overrides(request)
        return await super().send(request, **kwargs)


def _client_kwargs(
    *,
    base_url: str,
    auth_header: str,
    credential: str,
    request_timeout: float | None,
    httpx_args: Mapping[str, object] | None,
) -> dict[str, Any]:
    arguments: dict[str, Any] = dict(httpx_args or {})
    headers: dict[str, str] = {"User-Agent": USER_AGENT, auth_header: credential}
    caller_headers = arguments.pop("headers", None)
    if isinstance(caller_headers, Mapping):
        headers.update({str(name): str(value) for name, value in caller_headers.items()})
    arguments.setdefault("timeout", to_timeout(request_timeout))
    return {"base_url": base_url, "headers": headers, **arguments}


def install_sync_client(
    client: GeneratedClient,
    *,
    base_url: str,
    auth_header: str,
    credential: str,
    request_timeout: float | None,
    httpx_args: Mapping[str, object] | None,
) -> None:
    """Give a generated core an SDK-configured synchronous ``httpx`` client.

    Args:
        client: The generated core to configure.
        base_url: The origin every request is relative to.
        auth_header: The header the credential travels in.
        credential: The credential value, already prefixed if it needs one.
        request_timeout: The default per-request budget in seconds.
        httpx_args: Caller-supplied ``httpx`` arguments; applied last, so
            a caller's ``timeout`` or ``headers`` win.
    """
    client.set_httpx_client(
        _OverridableClient(
            **_client_kwargs(
                base_url=base_url,
                auth_header=auth_header,
                credential=credential,
                request_timeout=request_timeout,
                httpx_args=httpx_args,
            )
        )
    )


def install_async_client(
    client: GeneratedClient,
    *,
    base_url: str,
    auth_header: str,
    credential: str,
    request_timeout: float | None,
    httpx_args: Mapping[str, object] | None,
) -> None:
    """Async counterpart of :func:`install_sync_client`.

    Args:
        client: The generated core to configure.
        base_url: The origin every request is relative to.
        auth_header: The header the credential travels in.
        credential: The credential value, already prefixed if it needs one.
        request_timeout: The default per-request budget in seconds.
        httpx_args: Caller-supplied ``httpx`` arguments; applied last.
    """
    client.set_async_httpx_client(
        _OverridableAsyncClient(
            **_client_kwargs(
                base_url=base_url,
                auth_header=auth_header,
                credential=credential,
                request_timeout=request_timeout,
                httpx_args=httpx_args,
            )
        )
    )
