"""Command execution inside one sandbox over the data plane."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Literal

from websockets.exceptions import InvalidStatus

from fissionplane._dataplane.api.commands import (
    get_process,
    get_process_logs,
    kill_process,
    list_processes,
    run_command,
    start_process,
)
from fissionplane._dataplane.client import AuthenticatedClient as DataplaneClient
from fissionplane._dataplane.models import (
    CommandResult,
    KillProcessSignal,
    Process,
    ProcessList,
    ProcessLogs,
    PtySize,
    RunCommandRequest,
    RunCommandRequestEnv,
    StartProcessRequest,
    StartProcessRequestEnv,
)
from fissionplane._dataplane.types import UNSET, Unset
from fissionplane._http import DEFAULT_REQUEST_TIMEOUT, install_async_client, install_sync_client
from fissionplane._retry import AnyResponse, Caller, RetryPolicy
from fissionplane.errors import FissionPlaneError, _unwrap, raise_for_response
from fissionplane.streaming import (
    AsyncConnect,
    AsyncConnection,
    AsyncStream,
    StreamingProtocolError,
    SyncConnect,
    SyncConnection,
    SyncStream,
    default_async_connect,
    default_sync_connect,
    parse_json_object,
    require_int,
    require_positive_int,
    require_string,
    websocket_subprotocols,
    websocket_url,
)

DEFAULT_AGENT_PORT = 50000
"""The well-known port every sandbox serves its data-plane agent on."""

_NO_TOKEN_MESSAGE = (
    "this handle holds no capability token for the data plane; "
    "obtain one via sandboxes.create(), resume(), or mint_token()"
)


def _run_request(
    command: str,
    args: list[str] | None,
    cwd: str | None,
    env: dict[str, str] | None,
    stdin: str | None,
    timeout_seconds: int | None,
) -> RunCommandRequest:
    request_env: RunCommandRequestEnv | Unset = UNSET
    if env is not None:
        request_env = RunCommandRequestEnv.from_dict(env)
    return RunCommandRequest(
        command=command,
        args=args if args is not None else UNSET,
        cwd=cwd if cwd is not None else UNSET,
        env=request_env,
        stdin=stdin if stdin is not None else UNSET,
        timeout_seconds=timeout_seconds if timeout_seconds is not None else UNSET,
    )


_TOKEN_HEADER = "X-Sandbox-Token"


def _build_dataplane_client(
    base_url: str, token: str, httpx_args: dict[str, object] | None
) -> DataplaneClient:
    return DataplaneClient(
        base_url=base_url,
        token=token,
        auth_header_name=_TOKEN_HEADER,
        prefix="",
        raise_on_unexpected_status=False,
        httpx_args=httpx_args or {},
    )


def _unauthorized_handshake(error: InvalidStatus) -> bool:
    return error.response.status_code == 401


class _DataplaneModule(Caller):
    """State shared by one sandbox's data-plane surfaces.

    The underlying client is built lazily on first use and rebuilt
    whenever the capability token changes — tokens are minted per epoch,
    and both a resume and a re-mint re-arm the handle with a fresh one.
    """

    def __init__(
        self,
        *,
        base_url: str,
        token: Callable[[], str | None],
        httpx_args: dict[str, object] | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        super().__init__(retry=retry, logger=logger)
        self._base_url = base_url
        self._token = token
        self._httpx_args = httpx_args
        self._request_timeout = request_timeout
        self._client: DataplaneClient | None = None
        self._client_token: str | None = None

    def _require_token(self) -> str:
        token = self._token()
        if token is None:
            raise FissionPlaneError(_NO_TOKEN_MESSAGE)
        return token

    def _install(self, client: DataplaneClient, token: str) -> None:
        raise NotImplementedError

    def _dataplane(self) -> DataplaneClient:
        token = self._require_token()
        if self._client is None or self._client_token != token:
            client = _build_dataplane_client(self._base_url, token, self._httpx_args)
            self._install(client, token)
            self._client = client
            self._client_token = token
        return self._client


class _SyncDataplaneModule(_DataplaneModule):
    """The synchronous data-plane call path for one sandbox."""

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
        super().__init__(
            base_url=base_url,
            token=token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=retry,
            logger=logger,
        )
        self._refresh_token = refresh_token
        self._websocket_connect = websocket_connect or default_sync_connect

    def _install(self, client: DataplaneClient, token: str) -> None:
        install_sync_client(
            client,
            base_url=self._base_url,
            auth_header=_TOKEN_HEADER,
            credential=token,
            request_timeout=self._request_timeout,
            httpx_args=self._httpx_args,
        )

    def _invoke(
        self,
        operation: Callable[[DataplaneClient], AnyResponse],
        *,
        idempotent: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AnyResponse:
        """Run one data-plane operation, re-minting the token on a 401.

        A capability token expires on its own schedule and dies with its
        epoch, so a 401 is routine rather than exceptional: the handle
        mints a token for the current epoch and reissues the request once.
        """
        response = self._execute(
            lambda: operation(self._dataplane()),
            idempotent=idempotent,
            request_timeout=request_timeout,
            headers=headers,
        )
        if int(response.status_code) != 401 or self._refresh_token is None:
            return response
        self._logger.debug("data plane rejected the capability token; re-minting")
        if self._refresh_token() is None:
            return response
        return self._execute(
            lambda: operation(self._dataplane()),
            idempotent=idempotent,
            request_timeout=request_timeout,
            headers=headers,
        )

    def _connect(self, path: str, query: dict[str, str | int | bool]) -> SyncConnection:
        """Open a data-plane stream, re-minting the token on a 401 handshake."""
        url = websocket_url(self._base_url, path, query)
        try:
            return self._websocket_connect(
                url, subprotocols=websocket_subprotocols(self._require_token())
            )
        except InvalidStatus as error:
            if not _unauthorized_handshake(error) or self._refresh_token is None:
                raise
            self._logger.debug("stream handshake rejected the capability token; re-minting")
            if self._refresh_token() is None:
                raise
        return self._websocket_connect(
            url, subprotocols=websocket_subprotocols(self._require_token())
        )


class _AsyncDataplaneModule(_DataplaneModule):
    """The asynchronous data-plane call path for one sandbox."""

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
        super().__init__(
            base_url=base_url,
            token=token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=retry,
            logger=logger,
        )
        self._refresh_token = refresh_token
        self._websocket_connect = websocket_connect or default_async_connect

    def _install(self, client: DataplaneClient, token: str) -> None:
        install_async_client(
            client,
            base_url=self._base_url,
            auth_header=_TOKEN_HEADER,
            credential=token,
            request_timeout=self._request_timeout,
            httpx_args=self._httpx_args,
        )

    async def _invoke(
        self,
        operation: Callable[[DataplaneClient], Awaitable[AnyResponse]],
        *,
        idempotent: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AnyResponse:
        """Async counterpart of :meth:`_SyncDataplaneModule._invoke`."""
        response = await self._execute_async(
            lambda: operation(self._dataplane()),
            idempotent=idempotent,
            request_timeout=request_timeout,
            headers=headers,
        )
        if int(response.status_code) != 401 or self._refresh_token is None:
            return response
        self._logger.debug("data plane rejected the capability token; re-minting")
        if await self._refresh_token() is None:
            return response
        return await self._execute_async(
            lambda: operation(self._dataplane()),
            idempotent=idempotent,
            request_timeout=request_timeout,
            headers=headers,
        )

    async def _connect(self, path: str, query: dict[str, str | int | bool]) -> AsyncConnection:
        """Async counterpart of :meth:`_SyncDataplaneModule._connect`."""
        url = websocket_url(self._base_url, path, query)
        try:
            return await self._websocket_connect(
                url, subprotocols=websocket_subprotocols(self._require_token())
            )
        except InvalidStatus as error:
            if not _unauthorized_handshake(error) or self._refresh_token is None:
                raise
            self._logger.debug("stream handshake rejected the capability token; re-minting")
            if await self._refresh_token() is None:
                raise
        return await self._websocket_connect(
            url, subprotocols=websocket_subprotocols(self._require_token())
        )


@dataclass(frozen=True)
class ProcessOutputEvent:
    type: Literal["stdout", "stderr"]
    sequence: int
    data: str


@dataclass(frozen=True)
class ProcessExitEvent:
    type: Literal["exit"]
    sequence: int
    exit_code: int


@dataclass(frozen=True)
class ProcessGapEvent:
    type: Literal["gap"]
    from_sequence: int
    to_sequence: int


ProcessStreamEvent = ProcessOutputEvent | ProcessExitEvent | ProcessGapEvent


def _parse_process_event(frame: str | bytes) -> ProcessStreamEvent | None:
    message = parse_json_object(frame)
    message_type = message.get("type")
    if not isinstance(message_type, str):
        raise StreamingProtocolError("process stream frame type must be a string")
    if message_type not in {"stdout", "stderr", "exit", "gap"}:
        return None
    if message_type in {"stdout", "stderr"}:
        output_type: Literal["stdout", "stderr"] = (
            "stdout" if message_type == "stdout" else "stderr"
        )
        return ProcessOutputEvent(
            type=output_type,
            sequence=require_positive_int(message, "sequence"),
            data=require_string(message, "data"),
        )
    if message_type == "exit":
        return ProcessExitEvent(
            type="exit",
            sequence=require_positive_int(message, "sequence"),
            exit_code=require_int(message, "exit_code"),
        )
    return ProcessGapEvent(
        type="gap",
        from_sequence=require_positive_int(message, "from_sequence"),
        to_sequence=require_positive_int(message, "to_sequence"),
    )


class ProcessAttachment(SyncStream[ProcessStreamEvent]):
    def _parse(self, frame: str | bytes) -> ProcessStreamEvent | None:
        return _parse_process_event(frame)

    def send_input(self, data: str) -> None:
        self._send({"type": "input", "data": data})

    def close_stdin(self) -> None:
        self._send({"type": "close_stdin"})

    def resize(self, cols: int, rows: int) -> None:
        self._send({"type": "resize", "cols": cols, "rows": rows})

    def signal(self, signal: str) -> None:
        self._send({"type": "signal", "signal": signal})


class AsyncProcessAttachment(AsyncStream[ProcessStreamEvent]):
    def _parse(self, frame: str | bytes) -> ProcessStreamEvent | None:
        return _parse_process_event(frame)

    async def send_input(self, data: str) -> None:
        await self._send({"type": "input", "data": data})

    async def close_stdin(self) -> None:
        await self._send({"type": "close_stdin"})

    async def resize(self, cols: int, rows: int) -> None:
        await self._send({"type": "resize", "cols": cols, "rows": rows})

    async def signal(self, signal: str) -> None:
        await self._send({"type": "signal", "signal": signal})


def _start_request(
    command: str,
    args: list[str] | None,
    cwd: str | None,
    env: dict[str, str] | None,
    pty: PtySize | None,
) -> StartProcessRequest:
    request_env: StartProcessRequestEnv | Unset = UNSET
    if env is not None:
        request_env = StartProcessRequestEnv.from_dict(env)
    return StartProcessRequest(
        command=command,
        args=args if args is not None else UNSET,
        cwd=cwd if cwd is not None else UNSET,
        env=request_env,
        pty=pty if pty is not None else UNSET,
    )


class ProcessHandle:
    """Operations bound to one supervised process.

    Attributes:
        info (Process): The latest known metadata for the process.
    """

    def __init__(self, commands: Commands, info: Process) -> None:
        """Wrap one process representation.

        Args:
            commands: The command service the process belongs to.
            info: The process representation the handle starts from.
        """
        self._commands = commands
        self.info = info

    @property
    def pid(self) -> int:
        """The process identifier inside the sandbox."""
        return self.info.pid

    def refresh(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Process:
        """Re-read the process metadata.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The refreshed process metadata.
        """
        self.info = self._commands.get_process(
            self.pid, request_timeout=request_timeout, headers=headers
        )
        return self.info

    def logs(
        self,
        *,
        after: int = 0,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ProcessLogs:
        """Read the process's retained output.

        Args:
            after: Read output recorded after this sequence number.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The retained output and the sequence to poll from next.
        """
        return self._commands.logs(
            self.pid, after=after, request_timeout=request_timeout, headers=headers
        )

    def attach(self, *, after: int = 0) -> ProcessAttachment:
        """Attach to the process's retained and live output.

        Args:
            after: Replay retained output recorded after this sequence
                number before following the live stream.

        Returns:
            An iterator over the process's output and exit events.
        """
        return self._commands.attach(self.pid, after=after)

    def kill(
        self,
        signal: str = "SIGTERM",
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Signal the process.

        Args:
            signal: One of ``SIGTERM``, ``SIGKILL``, ``SIGINT``, ``SIGHUP``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        self._commands.kill(self.pid, signal, request_timeout=request_timeout, headers=headers)


class AsyncProcessHandle:
    """Async counterpart of :class:`ProcessHandle`.

    Attributes:
        info (Process): The latest known metadata for the process.
    """

    def __init__(self, commands: AsyncCommands, info: Process) -> None:
        """Wrap one process representation.

        Args:
            commands: The command service the process belongs to.
            info: The process representation the handle starts from.
        """
        self._commands = commands
        self.info = info

    @property
    def pid(self) -> int:
        """The process identifier inside the sandbox."""
        return self.info.pid

    async def refresh(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Process:
        """Re-read the process metadata.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The refreshed process metadata.
        """
        self.info = await self._commands.get_process(
            self.pid, request_timeout=request_timeout, headers=headers
        )
        return self.info

    async def logs(
        self,
        *,
        after: int = 0,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ProcessLogs:
        """Read the process's retained output.

        Args:
            after: Read output recorded after this sequence number.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The retained output and the sequence to poll from next.
        """
        return await self._commands.logs(
            self.pid, after=after, request_timeout=request_timeout, headers=headers
        )

    async def attach(self, *, after: int = 0) -> AsyncProcessAttachment:
        """Attach to the process's retained and live output.

        Args:
            after: Replay retained output recorded after this sequence
                number before following the live stream.

        Returns:
            An async iterator over the process's output and exit events.
        """
        return await self._commands.attach(self.pid, after=after)

    async def kill(
        self,
        signal: str = "SIGTERM",
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Signal the process.

        Args:
            signal: One of ``SIGTERM``, ``SIGKILL``, ``SIGINT``, ``SIGHUP``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        await self._commands.kill(
            self.pid, signal, request_timeout=request_timeout, headers=headers
        )


class Commands(_SyncDataplaneModule):
    """Run-to-completion command execution inside one sandbox.

    The underlying data-plane client is built lazily on first use and
    rebuilt whenever the handle's capability token changes: tokens are
    minted per epoch, and a resume re-arms the handle with a fresh one.
    A call the data plane rejects as unauthorised re-mints the token from
    the control plane and is reissued once.
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
            base_url: The sandbox's data-plane origin,
                ``https://<agent_port>-<sandbox_id>.<domain>``.
            token: Zero-argument callable returning the handle's current
                capability token, or ``None`` when it holds none.
            refresh_token: Zero-argument callable that mints a token for
                the current epoch and returns it, used when the data
                plane rejects the one in hand.
            httpx_args: Extra ``httpx`` client arguments, forwarded from
                the parent client so tests can inject a transport.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries and token re-mints are reported.
            websocket_connect: Connector used for streaming surfaces.
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

    def run(
        self,
        command: str,
        *,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        stdin: str | None = None,
        timeout_seconds: int | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> CommandResult:
        """Run a command inside the sandbox and block until it exits.

        Output is captured and returned in one document, truncated at the
        agent's limit — for unbounded or interactive output, use the
        streaming surface instead.

        Args:
            command: The program to run.
            args: Arguments passed to the program.
            cwd: Working directory. Omitted means the default user's home.
            env: Environment variables set for this command only.
            stdin: Bytes written to the command's stdin before it is closed.
            timeout_seconds: Kill the command if it has not exited after
                this long. Omitted means the agent's default. This is the
                sandbox's budget for the command, not the HTTP client's.
            request_timeout: Seconds this HTTP call may take, overriding
                the client default. ``0`` disables the timeout. Leave a
                command's ``timeout_seconds`` room to expire first.
            headers: Extra headers for this call, overriding any header
                of the same name set on the client.

        Returns:
            The command's exit code and captured output.

        Raises:
            CommandTimeoutError: The command did not exit within
                ``timeout_seconds``; it has been killed.
            FissionPlaneError: The handle holds no capability token.

        Example:
            ```python
            result = sandbox.commands.run("python", args=["-V"])
            print(result.exit_code, result.stdout)
            ```
        """
        body = _run_request(command, args, cwd, env, stdin, timeout_seconds)
        result = _unwrap(
            self._invoke(
                lambda client: run_command.sync_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, CommandResult)
        return result

    def start(
        self,
        command: str,
        *,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        pty: PtySize | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ProcessHandle:
        """Start a supervised background process.

        Args:
            command: The program to run.
            args: Arguments passed to the program.
            cwd: Working directory. Omitted means the default user's home.
            env: Environment variables set for this process only.
            pty: Allocate a pseudo-terminal of this size.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the supervised process.
        """
        body = _start_request(command, args, cwd, env, pty)
        process = _unwrap(
            self._invoke(
                lambda client: start_process.sync_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(process, Process)
        return ProcessHandle(self, process)

    def get(
        self,
        pid: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ProcessHandle:
        """Get a handle for one supervised process.

        Args:
            pid: The process to read.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the supervised process.
        """
        return ProcessHandle(
            self, self.get_process(pid, request_timeout=request_timeout, headers=headers)
        )

    def get_process(
        self,
        pid: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Process:
        """Read metadata for one supervised process.

        Args:
            pid: The process to read.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The process metadata.
        """
        process = _unwrap(
            self._invoke(
                lambda client: get_process.sync_detailed(pid, client=client),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(process, Process)
        return process

    def logs(
        self,
        pid: int,
        *,
        after: int = 0,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ProcessLogs:
        """Read retained output for one supervised process.

        Args:
            pid: The process to read.
            after: Read output recorded after this sequence number.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The retained output and the sequence to poll from next.
        """
        logs = _unwrap(
            self._invoke(
                lambda client: get_process_logs.sync_detailed(pid, client=client, after=after),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(logs, ProcessLogs)
        return logs

    def attach(self, pid: int, *, after: int = 0) -> ProcessAttachment:
        """Attach to retained and live process output.

        A handshake the data plane rejects as unauthorised re-mints the
        capability token and reconnects once.

        Args:
            pid: The process to attach to.
            after: Replay retained output recorded after this sequence
                number before following the live stream.

        Returns:
            An iterator over the process's output and exit events.

        Raises:
            ValueError: ``after`` is not a non-negative integer.
        """
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be a non-negative integer")
        return ProcessAttachment(self._connect(f"/processes/{pid}/stream", {"after": after}))

    def list_processes(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> list[Process]:
        """List the processes the agent supervises inside the sandbox.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The supervised processes.
        """
        page = _unwrap(
            self._invoke(
                lambda client: list_processes.sync_detailed(client=client),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, ProcessList)
        return page.items

    def kill(
        self,
        pid: int,
        signal: str = "SIGTERM",
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Send a signal to a process inside the sandbox.

        Args:
            pid: The process to signal.
            signal: One of ``SIGTERM``, ``SIGKILL``, ``SIGINT``, ``SIGHUP``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            self._invoke(
                lambda client: kill_process.sync_detailed(
                    pid, client=client, signal=KillProcessSignal(signal)
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )


class AsyncCommands(_AsyncDataplaneModule):
    """Async counterpart of :class:`Commands`."""

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
            base_url: The sandbox's data-plane origin,
                ``https://<agent_port>-<sandbox_id>.<domain>``.
            token: Zero-argument callable returning the handle's current
                capability token, or ``None`` when it holds none.
            refresh_token: Zero-argument coroutine function that mints a
                token for the current epoch and returns it, used when the
                data plane rejects the one in hand.
            httpx_args: Extra ``httpx`` client arguments, forwarded from
                the parent client so tests can inject a transport.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries and token re-mints are reported.
            websocket_connect: Connector used for streaming surfaces.
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

    async def run(
        self,
        command: str,
        *,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        stdin: str | None = None,
        timeout_seconds: int | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> CommandResult:
        """Run a command inside the sandbox and block until it exits.

        Args:
            command: The program to run.
            args: Arguments passed to the program.
            cwd: Working directory. Omitted means the default user's home.
            env: Environment variables set for this command only.
            stdin: Bytes written to the command's stdin before it is closed.
            timeout_seconds: Kill the command if it has not exited after
                this long. Omitted means the agent's default.
            request_timeout: Seconds this HTTP call may take, overriding
                the client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The command's exit code and captured output.

        Raises:
            CommandTimeoutError: The command did not exit within
                ``timeout_seconds``; it has been killed.
            FissionPlaneError: The handle holds no capability token.
        """
        body = _run_request(command, args, cwd, env, stdin, timeout_seconds)
        result = _unwrap(
            await self._invoke(
                lambda client: run_command.asyncio_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, CommandResult)
        return result

    async def start(
        self,
        command: str,
        *,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        pty: PtySize | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AsyncProcessHandle:
        """Start a supervised background process.

        Args:
            command: The program to run.
            args: Arguments passed to the program.
            cwd: Working directory. Omitted means the default user's home.
            env: Environment variables set for this process only.
            pty: Allocate a pseudo-terminal of this size.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the supervised process.
        """
        body = _start_request(command, args, cwd, env, pty)
        process = _unwrap(
            await self._invoke(
                lambda client: start_process.asyncio_detailed(client=client, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(process, Process)
        return AsyncProcessHandle(self, process)

    async def get(
        self,
        pid: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AsyncProcessHandle:
        """Get a handle for one supervised process.

        Args:
            pid: The process to read.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the supervised process.
        """
        return AsyncProcessHandle(
            self, await self.get_process(pid, request_timeout=request_timeout, headers=headers)
        )

    async def get_process(
        self,
        pid: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Process:
        """Read metadata for one supervised process.

        Args:
            pid: The process to read.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The process metadata.
        """
        process = _unwrap(
            await self._invoke(
                lambda client: get_process.asyncio_detailed(pid, client=client),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(process, Process)
        return process

    async def logs(
        self,
        pid: int,
        *,
        after: int = 0,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ProcessLogs:
        """Read retained output for one supervised process.

        Args:
            pid: The process to read.
            after: Read output recorded after this sequence number.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The retained output and the sequence to poll from next.
        """
        logs = _unwrap(
            await self._invoke(
                lambda client: get_process_logs.asyncio_detailed(pid, client=client, after=after),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(logs, ProcessLogs)
        return logs

    async def attach(self, pid: int, *, after: int = 0) -> AsyncProcessAttachment:
        """Attach to retained and live process output.

        A handshake the data plane rejects as unauthorised re-mints the
        capability token and reconnects once.

        Args:
            pid: The process to attach to.
            after: Replay retained output recorded after this sequence
                number before following the live stream.

        Returns:
            An async iterator over the process's output and exit events.

        Raises:
            ValueError: ``after`` is not a non-negative integer.
        """
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be a non-negative integer")
        connection = await self._connect(f"/processes/{pid}/stream", {"after": after})
        return AsyncProcessAttachment(connection)

    async def list_processes(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> list[Process]:
        """List the processes the agent supervises inside the sandbox.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The supervised processes.
        """
        page = _unwrap(
            await self._invoke(
                lambda client: list_processes.asyncio_detailed(client=client),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, ProcessList)
        return page.items

    async def kill(
        self,
        pid: int,
        signal: str = "SIGTERM",
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Send a signal to a process inside the sandbox.

        Args:
            pid: The process to signal.
            signal: One of ``SIGTERM``, ``SIGKILL``, ``SIGINT``, ``SIGHUP``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            await self._invoke(
                lambda client: kill_process.asyncio_detailed(
                    pid, client=client, signal=KillProcessSignal(signal)
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
