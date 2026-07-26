"""Filesystem access inside one sandbox."""

from __future__ import annotations

import builtins
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

from fissionplane._dataplane.api.files import (
    download_file,
    list_files,
    make_directory,
    move_file,
    remove_file,
    stat_file,
    upload_file,
)
from fissionplane._dataplane.models import (
    FileInfo,
    FileKind,
    FileList,
    MakeDirectoryRequest,
    MoveFileRequest,
)
from fissionplane._dataplane.types import UNSET, File
from fissionplane._http import DEFAULT_REQUEST_TIMEOUT
from fissionplane._retry import RetryPolicy
from fissionplane.commands import _AsyncDataplaneModule, _SyncDataplaneModule
from fissionplane.errors import _unwrap, raise_for_response
from fissionplane.streaming import (
    AsyncConnect,
    AsyncStream,
    StreamingProtocolError,
    SyncConnect,
    SyncStream,
    parse_json_object,
    require_positive_int,
    require_string,
)


@dataclass(frozen=True)
class FileChangeEvent:
    type: Literal["created", "modified", "removed"]
    sequence: int
    path: str
    kind: FileKind


@dataclass(frozen=True)
class FileMoveEvent:
    type: Literal["moved"]
    sequence: int
    path: str
    old_path: str
    kind: FileKind


@dataclass(frozen=True)
class FileOverflowEvent:
    type: Literal["overflow"]
    sequence: int


FileWatchEvent = FileChangeEvent | FileMoveEvent | FileOverflowEvent


def _parse_watch_event(frame: str | bytes) -> FileWatchEvent | None:
    message = parse_json_object(frame)
    message_type = message.get("type")
    if not isinstance(message_type, str):
        raise StreamingProtocolError("file watch frame type must be a string")
    if message_type not in {"created", "modified", "removed", "moved", "overflow"}:
        return None
    sequence = require_positive_int(message, "sequence")
    if message_type == "overflow":
        return FileOverflowEvent(type="overflow", sequence=sequence)
    path = require_string(message, "path")
    try:
        kind = FileKind(require_string(message, "kind"))
    except ValueError as error:
        raise StreamingProtocolError("known frame field 'kind' is invalid") from error
    if message_type == "moved":
        return FileMoveEvent(
            type="moved",
            sequence=sequence,
            path=path,
            old_path=require_string(message, "old_path"),
            kind=kind,
        )
    change_type: Literal["created", "modified", "removed"]
    if message_type == "created":
        change_type = "created"
    elif message_type == "modified":
        change_type = "modified"
    else:
        change_type = "removed"
    return FileChangeEvent(type=change_type, sequence=sequence, path=path, kind=kind)


class FileWatch(SyncStream[FileWatchEvent]):
    def _parse(self, frame: str | bytes) -> FileWatchEvent | None:
        return _parse_watch_event(frame)


class AsyncFileWatch(AsyncStream[FileWatchEvent]):
    def _parse(self, frame: str | bytes) -> FileWatchEvent | None:
        return _parse_watch_event(frame)


class Files(_SyncDataplaneModule):
    """Synchronous filesystem operations inside one sandbox.

    A call the data plane rejects as unauthorised re-mints the handle's
    capability token from the control plane and is reissued once.
    """

    def __init__(
        self,
        *,
        base_url: str,
        token: Callable[[], str | None],
        refresh_token: Callable[[], str | None] | None = None,
        httpx_args: dict[str, object] | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
        websocket_connect: SyncConnect | None = None,
    ) -> None:
        """Bind the service to one sandbox's data plane.

        Args:
            base_url: The sandbox's data-plane origin.
            token: Zero-argument callable returning the handle's current
                capability token, or ``None`` when it holds none.
            refresh_token: Zero-argument callable that mints a token for
                the current epoch and returns it.
            httpx_args: Extra ``httpx`` client arguments.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries and token re-mints are reported.
            websocket_connect: Connector used for the watch stream.
        """
        super().__init__(
            base_url=base_url,
            token=token,
            refresh_token=refresh_token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=retry,
            logger=logger,
            websocket_connect=websocket_connect,
        )

    def list(
        self,
        path: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> builtins.list[FileInfo]:
        """List one directory's entries.

        Args:
            path: The directory to list.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The directory's entries.
        """
        page = _unwrap(
            self._invoke(
                lambda client: list_files.sync_detailed(client=client, path=path),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, FileList)
        return page.items

    def stat(
        self,
        path: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> FileInfo:
        """Read one path's metadata.

        Args:
            path: The file or directory to describe.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The path's metadata.
        """
        info = _unwrap(
            self._invoke(
                lambda client: stat_file.sync_detailed(client=client, path=path),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, FileInfo)
        return info

    def make_dir(
        self,
        path: str,
        *,
        parents: bool = True,
        mode: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Create a directory.

        Args:
            path: The directory to create.
            parents: Create missing parent directories too.
            mode: Octal permission bits, e.g. ``"0755"``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        body = MakeDirectoryRequest(
            path=path,
            parents=parents,
            mode=mode if mode is not None else UNSET,
        )
        raise_for_response(
            self._invoke(
                lambda client: make_directory.sync_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    def move(
        self,
        source: str,
        destination: str,
        *,
        overwrite: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Move or rename a path.

        Args:
            source: The path to move.
            destination: Where to move it.
            overwrite: Replace ``destination`` when it already exists.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        body = MoveFileRequest(source=source, destination=destination, overwrite=overwrite)
        raise_for_response(
            self._invoke(
                lambda client: move_file.sync_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    def remove(
        self,
        path: str,
        *,
        recursive: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Remove a file or directory.

        Args:
            path: The path to remove.
            recursive: Remove a directory's contents too.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            self._invoke(
                lambda client: remove_file.sync_detailed(
                    client=client, path=path, recursive=recursive
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    def read(
        self,
        path: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> bytes:
        """Read a file's contents.

        Args:
            path: The file to read.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The file's bytes.
        """
        result = _unwrap(
            self._invoke(
                lambda client: download_file.sync_detailed(client=client, path=path),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, File)
        return result.payload.read()

    download = read

    def write(
        self,
        path: str,
        data: bytes,
        *,
        mode: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Write a file, creating or replacing it.

        Args:
            path: The file to write.
            data: The bytes to write.
            mode: Octal permission bits, e.g. ``"0600"``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            self._invoke(
                lambda client: upload_file.sync_detailed(
                    client=client,
                    path=path,
                    mode=mode if mode is not None else UNSET,
                    body=File(payload=BytesIO(data)),
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    upload = write

    def watch(self, path: str, *, recursive: bool = False, after: int = 0) -> FileWatch:
        """Follow filesystem changes under one path.

        A handshake the data plane rejects as unauthorised re-mints the
        capability token and reconnects once.

        Args:
            path: The file or directory to watch.
            recursive: Watch the whole subtree.
            after: Replay events recorded after this sequence number
                before following the live stream.

        Returns:
            An iterator over the change events.

        Raises:
            ValueError: ``after`` is not a non-negative integer.
        """
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be a non-negative integer")
        return FileWatch(
            self._connect("/files/watch", {"path": path, "recursive": recursive, "after": after})
        )


class AsyncFiles(_AsyncDataplaneModule):
    """Async counterpart of :class:`Files`."""

    def __init__(
        self,
        *,
        base_url: str,
        token: Callable[[], str | None],
        refresh_token: Callable[[], Awaitable[str | None]] | None = None,
        httpx_args: dict[str, object] | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
        websocket_connect: AsyncConnect | None = None,
    ) -> None:
        """Bind the service to one sandbox's data plane.

        Args:
            base_url: The sandbox's data-plane origin.
            token: Zero-argument callable returning the handle's current
                capability token, or ``None`` when it holds none.
            refresh_token: Zero-argument coroutine function that mints a
                token for the current epoch and returns it.
            httpx_args: Extra ``httpx`` client arguments.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries and token re-mints are reported.
            websocket_connect: Connector used for the watch stream.
        """
        super().__init__(
            base_url=base_url,
            token=token,
            refresh_token=refresh_token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=retry,
            logger=logger,
            websocket_connect=websocket_connect,
        )

    async def list(
        self,
        path: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> builtins.list[FileInfo]:
        """List one directory's entries.

        Args:
            path: The directory to list.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The directory's entries.
        """
        page = _unwrap(
            await self._invoke(
                lambda client: list_files.asyncio_detailed(client=client, path=path),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, FileList)
        return page.items

    async def stat(
        self,
        path: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> FileInfo:
        """Read one path's metadata.

        Args:
            path: The file or directory to describe.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The path's metadata.
        """
        info = _unwrap(
            await self._invoke(
                lambda client: stat_file.asyncio_detailed(client=client, path=path),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, FileInfo)
        return info

    async def make_dir(
        self,
        path: str,
        *,
        parents: bool = True,
        mode: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Create a directory.

        Args:
            path: The directory to create.
            parents: Create missing parent directories too.
            mode: Octal permission bits, e.g. ``"0755"``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        body = MakeDirectoryRequest(
            path=path,
            parents=parents,
            mode=mode if mode is not None else UNSET,
        )
        raise_for_response(
            await self._invoke(
                lambda client: make_directory.asyncio_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    async def move(
        self,
        source: str,
        destination: str,
        *,
        overwrite: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Move or rename a path.

        Args:
            source: The path to move.
            destination: Where to move it.
            overwrite: Replace ``destination`` when it already exists.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        body = MoveFileRequest(source=source, destination=destination, overwrite=overwrite)
        raise_for_response(
            await self._invoke(
                lambda client: move_file.asyncio_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    async def remove(
        self,
        path: str,
        *,
        recursive: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Remove a file or directory.

        Args:
            path: The path to remove.
            recursive: Remove a directory's contents too.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            await self._invoke(
                lambda client: remove_file.asyncio_detailed(
                    client=client, path=path, recursive=recursive
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    async def read(
        self,
        path: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> bytes:
        """Read a file's contents.

        Args:
            path: The file to read.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The file's bytes.
        """
        result = _unwrap(
            await self._invoke(
                lambda client: download_file.asyncio_detailed(client=client, path=path),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, File)
        return result.payload.read()

    download = read

    async def write(
        self,
        path: str,
        data: bytes,
        *,
        mode: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Write a file, creating or replacing it.

        Args:
            path: The file to write.
            data: The bytes to write.
            mode: Octal permission bits, e.g. ``"0600"``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            await self._invoke(
                lambda client: upload_file.asyncio_detailed(
                    client=client,
                    path=path,
                    mode=mode if mode is not None else UNSET,
                    body=File(payload=BytesIO(data)),
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )

    upload = write

    async def watch(self, path: str, *, recursive: bool = False, after: int = 0) -> AsyncFileWatch:
        """Follow filesystem changes under one path.

        A handshake the data plane rejects as unauthorised re-mints the
        capability token and reconnects once.

        Args:
            path: The file or directory to watch.
            recursive: Watch the whole subtree.
            after: Replay events recorded after this sequence number
                before following the live stream.

        Returns:
            An async iterator over the change events.

        Raises:
            ValueError: ``after`` is not a non-negative integer.
        """
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be a non-negative integer")
        connection = await self._connect(
            "/files/watch", {"path": path, "recursive": recursive, "after": after}
        )
        return AsyncFileWatch(connection)
