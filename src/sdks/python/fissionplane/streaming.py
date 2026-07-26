"""Shared WebSocket support for data-plane streams."""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Awaitable, Iterator, Sequence
from typing import Protocol, TypeVar
from urllib.parse import urlencode, urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection as AsyncClientConnection
from websockets.asyncio.client import connect as async_connect
from websockets.sync.client import ClientConnection as SyncClientConnection
from websockets.sync.client import connect as sync_connect
from websockets.typing import Subprotocol

from fissionplane.errors import FissionPlaneError

T = TypeVar("T")


class StreamingProtocolError(FissionPlaneError):
    """A known streaming message didn't match the protocol."""


class SyncConnection(Protocol):
    @property
    def subprotocol(self) -> str | None: ...

    def __iter__(self) -> Iterator[str | bytes]: ...

    def send(self, message: str) -> None: ...

    def close(self) -> None: ...


class AsyncConnection(Protocol):
    @property
    def subprotocol(self) -> str | None: ...

    def __aiter__(self) -> AsyncIterator[str | bytes]: ...

    async def send(self, message: str) -> None: ...

    async def close(self) -> None: ...


class SyncConnect(Protocol):
    def __call__(
        self, uri: str, *, subprotocols: Sequence[str] | None = None
    ) -> SyncConnection: ...


class AsyncConnect(Protocol):
    def __call__(
        self, uri: str, *, subprotocols: Sequence[str] | None = None
    ) -> Awaitable[AsyncConnection]: ...


def default_sync_connect(
    uri: str, *, subprotocols: Sequence[str] | None = None
) -> SyncClientConnection:
    protocols = (
        [Subprotocol(subprotocol) for subprotocol in subprotocols]
        if subprotocols is not None
        else None
    )
    return sync_connect(uri, subprotocols=protocols)


async def default_async_connect(
    uri: str, *, subprotocols: Sequence[str] | None = None
) -> AsyncClientConnection:
    protocols = (
        [Subprotocol(subprotocol) for subprotocol in subprotocols]
        if subprotocols is not None
        else None
    )
    return await async_connect(uri, subprotocols=protocols)


def _validate_subprotocol(subprotocol: str | None) -> None:
    if subprotocol != "fissionplane.v1":
        raise StreamingProtocolError("server did not select fissionplane.v1")


def websocket_url(
    base_url: str,
    path: str,
    query: dict[str, str | int | bool],
) -> str:
    parts = urlsplit(base_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    encoded_query = urlencode(
        {
            name: str(value).lower() if isinstance(value, bool) else value
            for name, value in query.items()
        }
    )
    return urlunsplit((scheme, parts.netloc, path, encoded_query, ""))


def websocket_subprotocols(token: str) -> list[str]:
    encoded = base64.urlsafe_b64encode(token.encode()).decode().rstrip("=")
    return ["fissionplane.v1", f"fissionplane.token.{encoded}"]


def parse_json_object(frame: str | bytes) -> dict[str, object]:
    if not isinstance(frame, str):
        raise StreamingProtocolError("expected a JSON text frame")
    try:
        value = json.loads(frame)
    except json.JSONDecodeError as error:
        raise StreamingProtocolError("received malformed JSON text frame") from error
    if not isinstance(value, dict):
        raise StreamingProtocolError("expected a JSON object frame")
    return {str(key): item for key, item in value.items()}


def require_positive_int(message: dict[str, object], name: str) -> int:
    value = message.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise StreamingProtocolError(f"known frame field {name!r} must be a positive integer")
    return value


def require_int(message: dict[str, object], name: str) -> int:
    value = message.get(name)
    if not isinstance(value, int) or isinstance(value, bool):
        raise StreamingProtocolError(f"known frame field {name!r} must be an integer")
    return value


def require_string(message: dict[str, object], name: str) -> str:
    value = message.get(name)
    if not isinstance(value, str):
        raise StreamingProtocolError(f"known frame field {name!r} must be a string")
    return value


class SyncStream(Iterator[T]):
    def __init__(self, connection: SyncConnection) -> None:
        _validate_subprotocol(connection.subprotocol)
        self._connection = connection
        self._messages = iter(connection)

    def __iter__(self) -> SyncStream[T]:
        return self

    def __next__(self) -> T:
        while True:
            event = self._parse(next(self._messages))
            if event is not None:
                return event

    def close(self) -> None:
        self._connection.close()

    def _send(self, message: dict[str, object]) -> None:
        self._connection.send(json.dumps(message, separators=(",", ":")))

    def _parse(self, frame: str | bytes) -> T | None:
        raise NotImplementedError


class AsyncStream(AsyncIterator[T]):
    def __init__(self, connection: AsyncConnection) -> None:
        _validate_subprotocol(connection.subprotocol)
        self._connection = connection
        self._messages = connection.__aiter__()

    def __aiter__(self) -> AsyncStream[T]:
        return self

    async def __anext__(self) -> T:
        while True:
            event = self._parse(await self._messages.__anext__())
            if event is not None:
                return event

    async def close(self) -> None:
        await self._connection.close()

    async def _send(self, message: dict[str, object]) -> None:
        await self._connection.send(json.dumps(message, separators=(",", ":")))

    def _parse(self, frame: str | bytes) -> T | None:
        raise NotImplementedError
