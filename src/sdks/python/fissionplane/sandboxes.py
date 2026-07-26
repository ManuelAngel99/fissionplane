"""Sandbox handles and collection operations."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Iterator, Mapping
from urllib.parse import urlencode

from fissionplane._api.api.sandboxes import (
    create_sandbox,
    delete_sandbox,
    extend_sandbox_deadline,
    get_sandbox,
    list_sandboxes,
    mint_sandbox_token,
    pause_sandbox,
    resume_sandbox,
)
from fissionplane._api.client import AuthenticatedClient
from fissionplane._api.models import (
    CapabilityToken,
    CreateSandboxRequest,
    CreateSandboxRequestMetadata,
    EgressPolicy,
    ExtendDeadlineRequest,
    MintTokenRequest,
    ResumeSandboxRequest,
    SandboxList,
    SandboxState,
    SandboxWithToken,
)
from fissionplane._api.models import (
    Sandbox as SandboxInfo,
)
from fissionplane._api.types import UNSET, Unset
from fissionplane._http import DEFAULT_REQUEST_TIMEOUT
from fissionplane._retry import Caller, RetryPolicy
from fissionplane.commands import DEFAULT_AGENT_PORT, AsyncCommands, Commands
from fissionplane.errors import _unwrap, raise_for_response
from fissionplane.files import AsyncFiles, Files
from fissionplane.ports import AsyncPorts, Ports
from fissionplane.streaming import AsyncConnect, SyncConnect


def _metadata_filter(metadata: dict[str, str] | None) -> str | Unset:
    return urlencode(metadata) if metadata is not None else UNSET


def _create_request(
    template: str,
    name: str | None,
    metadata: dict[str, str] | None,
    deadline_seconds: int | None,
    egress: EgressPolicy | None,
) -> CreateSandboxRequest:
    request_metadata: CreateSandboxRequestMetadata | Unset = UNSET
    if metadata is not None:
        request_metadata = CreateSandboxRequestMetadata.from_dict(metadata)
    return CreateSandboxRequest(
        template=template,
        name=name if name is not None else UNSET,
        metadata=request_metadata,
        deadline_seconds=deadline_seconds if deadline_seconds is not None else UNSET,
        egress=egress if egress is not None else UNSET,
    )


def _mint_request(ttl_seconds: int | None, ports: list[int] | None) -> MintTokenRequest:
    return MintTokenRequest(
        ttl_seconds=ttl_seconds if ttl_seconds is not None else UNSET,
        ports=ports if ports is not None else UNSET,
    )


def _resume_request(deadline_seconds: int | None) -> ResumeSandboxRequest | Unset:
    if deadline_seconds is None:
        return UNSET
    return ResumeSandboxRequest(deadline_seconds=deadline_seconds)


def hostname(info: SandboxInfo, port: int) -> str:
    """The public hostname of a published port.

    Args:
        info: The sandbox the port belongs to.
        port: The published port.

    Returns:
        ``<port>-<sandbox_id>.<domain>``.
    """
    return f"{port}-{info.sandbox_id}.{info.domain}"


class Sandbox(Caller):
    """A live handle on one sandbox.

    Holds the latest known representation and, when obtained from an
    operation that mints one (create, resume, mint_token), the
    capability token for the current epoch.

    Attributes:
        info (SandboxInfo): The latest representation read from the
            control plane.
        token (CapabilityToken | None): The capability token for the
            current epoch, when the handle owns one.
        ports (Ports): Port exposure records for this sandbox.
        commands (Commands): Command execution over the data plane,
            authenticated by ``token``.
        files (Files): Filesystem access over the data plane.
    """

    def __init__(
        self,
        api: AuthenticatedClient,
        info: SandboxInfo,
        token: CapabilityToken | None = None,
        *,
        agent_port: int = DEFAULT_AGENT_PORT,
        httpx_args: dict[str, object] | None = None,
        websocket_connect: SyncConnect | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Wrap one sandbox representation.

        Args:
            api: The generated control-plane client.
            info: The sandbox representation the handle starts from.
            token: A capability token for the current epoch, when the
                operation that produced the handle minted one.
            agent_port: The port the sandbox's data-plane agent serves on.
            httpx_args: Extra ``httpx`` client arguments, forwarded to the
                data-plane client so tests can inject a transport.
            websocket_connect: Connector used for the streaming surfaces.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries and token re-mints are reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self.info = info
        self.token = token
        self.ports = Ports(api, info.sandbox_id, retry=self._retry, logger=self._logger)
        dataplane_url = f"https://{agent_port}-{info.sandbox_id}.{info.domain}"
        self.commands = Commands(
            base_url=dataplane_url,
            token=self._current_token,
            refresh_token=self._remint_token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=self._retry,
            logger=self._logger,
            websocket_connect=websocket_connect,
        )
        self.files = Files(
            base_url=dataplane_url,
            token=self._current_token,
            refresh_token=self._remint_token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=self._retry,
            logger=self._logger,
            websocket_connect=websocket_connect,
        )

    def _current_token(self) -> str | None:
        return self.token.token if self.token is not None else None

    def _remint_token(self) -> str | None:
        """Mint a token for the current epoch, for a rejected data-plane call."""
        return self.mint_token().token

    @property
    def sandbox_id(self) -> str:
        """The sandbox identifier."""
        return self.info.sandbox_id

    def hostname(self, port: int) -> str:
        """The public hostname of a published port.

        Args:
            port: The published port.

        Returns:
            ``<port>-<sandbox_id>.<domain>``.
        """
        return hostname(self.info, port)

    def refresh(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Re-read the sandbox from the control plane.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call, overriding any header
                of the same name set on the client.

        Returns:
            The refreshed sandbox representation.
        """
        info = _unwrap(
            self._execute(
                lambda: get_sandbox.sync_detailed(self.sandbox_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        self.info = info
        return info

    def pause(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Snapshot the sandbox and release its node capacity.

        Complete when the node reports the VM snapshotted;
        ``restorable_until`` on the returned sandbox records how long
        the snapshot stays restorable.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The paused sandbox.
        """
        info = _unwrap(
            self._execute(
                lambda: pause_sandbox.sync_detailed(self.sandbox_id, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        self.info = info
        return info

    def resume(
        self,
        *,
        deadline_seconds: int | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Restore the snapshot onto a node.

        The resumed instance carries a new epoch: tokens minted against
        the previous instance fail closed, so the handle's token is
        replaced by the fresh one this operation returns.

        Args:
            deadline_seconds: Lease for the resumed instance, from now.
                Omitted means the default lease.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The running sandbox, under its new epoch.
        """
        body = _resume_request(deadline_seconds)
        result = _unwrap(
            self._execute(
                lambda: resume_sandbox.sync_detailed(self.sandbox_id, client=self._api, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, SandboxWithToken)
        self.info = result.sandbox
        self.token = result.token
        return self.info

    def extend_deadline(
        self,
        deadline_seconds: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Set the deadline to now plus ``deadline_seconds``.

        Args:
            deadline_seconds: The new lease length, measured from now.
                Bounded by the installation's maximum lease.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The sandbox with its new deadline.
        """
        body = ExtendDeadlineRequest(deadline_seconds=deadline_seconds)
        info = _unwrap(
            self._execute(
                lambda: extend_sandbox_deadline.sync_detailed(
                    self.sandbox_id, client=self._api, body=body
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        self.info = info
        return info

    def mint_token(
        self,
        *,
        ttl_seconds: int | None = None,
        ports: list[int] | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> CapabilityToken:
        """Mint a capability token for the current epoch.

        Args:
            ttl_seconds: Requested token lifetime, bounded by the
                installation's maximum.
            ports: Restrict the token to these ports — a scope can only
                narrow, never widen.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A fresh capability token; the handle keeps it for its
            data-plane requests.
        """
        body = _mint_request(ttl_seconds, ports)
        token = _unwrap(
            self._execute(
                lambda: mint_sandbox_token.sync_detailed(
                    self.sandbox_id, client=self._api, body=body
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(token, CapabilityToken)
        self.token = token
        return token

    def delete(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Terminate the sandbox.

        The record remains readable as ``terminated``. Deleting a paused
        sandbox also releases its snapshot.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            self._execute(
                lambda: delete_sandbox.sync_detailed(self.sandbox_id, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )


class Sandboxes(Caller):
    """Operations on the sandbox collection."""

    def __init__(
        self,
        api: AuthenticatedClient,
        *,
        agent_port: int = DEFAULT_AGENT_PORT,
        httpx_args: dict[str, object] | None = None,
        websocket_connect: SyncConnect | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Bind the collection to a control-plane client.

        Args:
            api: The generated control-plane client.
            agent_port: The data-plane port handed to every handle.
            httpx_args: Extra ``httpx`` client arguments handed to every
                handle's data-plane client.
            websocket_connect: Connector handed to every handle's
                streaming surfaces.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries, token re-mints, and page fetches are
                reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self._agent_port = agent_port
        self._httpx_args = httpx_args
        self._websocket_connect = websocket_connect
        self._request_timeout = request_timeout

    def _handle(self, info: SandboxInfo, token: CapabilityToken | None = None) -> Sandbox:
        return Sandbox(
            self._api,
            info,
            token,
            agent_port=self._agent_port,
            httpx_args=self._httpx_args,
            websocket_connect=self._websocket_connect,
            request_timeout=self._request_timeout,
            retry=self._retry,
            logger=self._logger,
        )

    def create(
        self,
        template: str,
        *,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
        deadline_seconds: int | None = None,
        egress: EgressPolicy | None = None,
        idempotency_key: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Sandbox:
        """Create a sandbox and block until a node has acknowledged it.

        Creation is only retried when ``idempotency_key`` is set: without
        one, reissuing the request risks a second sandbox.

        Args:
            template: A template alias or artifact ID. Aliases resolve at
                admission time.
            name: Optional name, unique within the organisation. A
                colliding create fails with :class:`ConflictError`.
            metadata: Tenant key-value metadata, filterable in list.
            deadline_seconds: Requested lease length, from now. Omitted
                means the default lease.
            egress: Egress allow and deny lists, fixed at create.
            idempotency_key: Makes retries safe — the same key returns
                the sandbox the first attempt created.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call, overriding any header
                of the same name set on the client.

        Returns:
            A handle on the running sandbox, armed with a capability
            token for its first epoch.

        Example:
            ```python
            sandbox = client.sandboxes.create(
                "base",
                name="job42",
                metadata={"run": "42"},
                deadline_seconds=600,
            )
            print(sandbox.sandbox_id)
            ```
        """
        body = _create_request(template, name, metadata, deadline_seconds, egress)
        key = idempotency_key if idempotency_key is not None else UNSET
        result = _unwrap(
            self._execute(
                lambda: create_sandbox.sync_detailed(
                    client=self._api, body=body, idempotency_key=key
                ),
                idempotent=idempotency_key is not None,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, SandboxWithToken)
        return self._handle(result.sandbox, result.token)

    def get(
        self,
        sandbox_id: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Sandbox:
        """Fetch one sandbox by identifier.

        The returned handle holds no capability token; mint one with
        :meth:`Sandbox.mint_token` before using its data plane.

        Args:
            sandbox_id: The sandbox identifier.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the sandbox.
        """
        info = _unwrap(
            self._execute(
                lambda: get_sandbox.sync_detailed(sandbox_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        return self._handle(info)

    def list(
        self,
        *,
        state: SandboxState | None = None,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
        limit: int | None = None,
        cursor: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxList:
        """One page of sandboxes; see :meth:`iterate` for the whole collection.

        Args:
            state: Filter on the tenant-visible state.
            name: Exact match on the tenant-assigned name.
            metadata: Metadata filter; a sandbox matches when every pair
                matches.
            limit: Page size, 1-100.
            cursor: Opaque cursor from a previous page's ``next_cursor``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            One page of sandboxes, most recently created first.
        """
        self._logger.debug("listing sandboxes (cursor=%s, limit=%s)", cursor, limit)
        page = _unwrap(
            self._execute(
                lambda: list_sandboxes.sync_detailed(
                    client=self._api,
                    state=state if state is not None else UNSET,
                    name=name if name is not None else UNSET,
                    metadata=_metadata_filter(metadata),
                    limit=limit if limit is not None else UNSET,
                    cursor=cursor if cursor is not None else UNSET,
                ),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, SandboxList)
        return page

    def iterate(
        self,
        *,
        state: SandboxState | None = None,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
        limit: int | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Iterator[Sandbox]:
        """Walk every page of the collection.

        Pages are fetched lazily, one request per page, following each
        page's ``next_cursor`` until the collection is exhausted.

        Args:
            state: Filter on the tenant-visible state.
            name: Exact match on the tenant-assigned name.
            metadata: Metadata filter; a sandbox matches when every pair
                matches.
            limit: Page size, 1-100. Omitted means the server's default.
            request_timeout: Seconds each page fetch may take, overriding
                the client default. ``0`` disables the timeout.
            headers: Extra headers for each page fetch.

        Yields:
            A handle per sandbox, across all pages.
        """
        cursor: str | None = None
        while True:
            page = self.list(
                state=state,
                name=name,
                metadata=metadata,
                limit=limit,
                cursor=cursor,
                request_timeout=request_timeout,
                headers=headers,
            )
            for info in page.items:
                yield self._handle(info)
            next_cursor = page.next_cursor
            if isinstance(next_cursor, Unset) or next_cursor is None:
                return
            cursor = next_cursor


class AsyncSandbox(Caller):
    """Async counterpart of :class:`Sandbox`.

    Attributes:
        info (SandboxInfo): The latest representation read from the
            control plane.
        token (CapabilityToken | None): The capability token for the
            current epoch, when the handle owns one.
        ports (AsyncPorts): Port exposure records for this sandbox.
        commands (AsyncCommands): Command execution over the data plane,
            authenticated by ``token``.
        files (AsyncFiles): Filesystem access over the data plane.
    """

    def __init__(
        self,
        api: AuthenticatedClient,
        info: SandboxInfo,
        token: CapabilityToken | None = None,
        *,
        agent_port: int = DEFAULT_AGENT_PORT,
        httpx_args: dict[str, object] | None = None,
        websocket_connect: AsyncConnect | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Wrap one sandbox representation.

        Args:
            api: The generated control-plane client.
            info: The sandbox representation the handle starts from.
            token: A capability token for the current epoch, when the
                operation that produced the handle minted one.
            agent_port: The port the sandbox's data-plane agent serves on.
            httpx_args: Extra ``httpx`` client arguments, forwarded to the
                data-plane client so tests can inject a transport.
            websocket_connect: Connector used for the streaming surfaces.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries and token re-mints are reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self.info = info
        self.token = token
        self.ports = AsyncPorts(api, info.sandbox_id, retry=self._retry, logger=self._logger)
        dataplane_url = f"https://{agent_port}-{info.sandbox_id}.{info.domain}"
        self.commands = AsyncCommands(
            base_url=dataplane_url,
            token=self._current_token,
            refresh_token=self._remint_token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=self._retry,
            logger=self._logger,
            websocket_connect=websocket_connect,
        )
        self.files = AsyncFiles(
            base_url=dataplane_url,
            token=self._current_token,
            refresh_token=self._remint_token,
            httpx_args=httpx_args,
            request_timeout=request_timeout,
            retry=self._retry,
            logger=self._logger,
            websocket_connect=websocket_connect,
        )

    def _current_token(self) -> str | None:
        return self.token.token if self.token is not None else None

    async def _remint_token(self) -> str | None:
        """Mint a token for the current epoch, for a rejected data-plane call."""
        return (await self.mint_token()).token

    @property
    def sandbox_id(self) -> str:
        """The sandbox identifier."""
        return self.info.sandbox_id

    def hostname(self, port: int) -> str:
        """The public hostname of a published port.

        Args:
            port: The published port.

        Returns:
            ``<port>-<sandbox_id>.<domain>``.
        """
        return hostname(self.info, port)

    async def refresh(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Re-read the sandbox from the control plane.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The refreshed sandbox representation.
        """
        info = _unwrap(
            await self._execute_async(
                lambda: get_sandbox.asyncio_detailed(self.sandbox_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        self.info = info
        return info

    async def pause(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Snapshot the sandbox and release its node capacity.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The paused sandbox.
        """
        info = _unwrap(
            await self._execute_async(
                lambda: pause_sandbox.asyncio_detailed(self.sandbox_id, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        self.info = info
        return info

    async def resume(
        self,
        *,
        deadline_seconds: int | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Restore the snapshot onto a node.

        The resumed instance carries a new epoch, so the handle's token
        is replaced by the fresh one this operation returns.

        Args:
            deadline_seconds: Lease for the resumed instance, from now.
                Omitted means the default lease.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The running sandbox, under its new epoch.
        """
        body = _resume_request(deadline_seconds)
        result = _unwrap(
            await self._execute_async(
                lambda: resume_sandbox.asyncio_detailed(
                    self.sandbox_id, client=self._api, body=body
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, SandboxWithToken)
        self.info = result.sandbox
        self.token = result.token
        return self.info

    async def extend_deadline(
        self,
        deadline_seconds: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxInfo:
        """Set the deadline to now plus ``deadline_seconds``.

        Args:
            deadline_seconds: The new lease length, measured from now.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The sandbox with its new deadline.
        """
        body = ExtendDeadlineRequest(deadline_seconds=deadline_seconds)
        info = _unwrap(
            await self._execute_async(
                lambda: extend_sandbox_deadline.asyncio_detailed(
                    self.sandbox_id, client=self._api, body=body
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        self.info = info
        return info

    async def mint_token(
        self,
        *,
        ttl_seconds: int | None = None,
        ports: list[int] | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> CapabilityToken:
        """Mint a capability token for the current epoch.

        Args:
            ttl_seconds: Requested token lifetime, bounded by the
                installation's maximum.
            ports: Restrict the token to these ports — a scope can only
                narrow, never widen.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A fresh capability token; the handle keeps it for its
            data-plane requests.
        """
        body = _mint_request(ttl_seconds, ports)
        token = _unwrap(
            await self._execute_async(
                lambda: mint_sandbox_token.asyncio_detailed(
                    self.sandbox_id, client=self._api, body=body
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(token, CapabilityToken)
        self.token = token
        return token

    async def delete(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Terminate the sandbox.

        The record remains readable as ``terminated``.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            await self._execute_async(
                lambda: delete_sandbox.asyncio_detailed(self.sandbox_id, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )


class AsyncSandboxes(Caller):
    """Async counterpart of :class:`Sandboxes`."""

    def __init__(
        self,
        api: AuthenticatedClient,
        *,
        agent_port: int = DEFAULT_AGENT_PORT,
        httpx_args: dict[str, object] | None = None,
        websocket_connect: AsyncConnect | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Bind the collection to a control-plane client.

        Args:
            api: The generated control-plane client.
            agent_port: The data-plane port handed to every handle.
            httpx_args: Extra ``httpx`` client arguments handed to every
                handle's data-plane client.
            websocket_connect: Connector handed to every handle's
                streaming surfaces.
            request_timeout: Seconds a request may take. ``0`` or ``None``
                disables the timeout.
            retry: How retryable failures are reissued.
            logger: Where retries, token re-mints, and page fetches are
                reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self._agent_port = agent_port
        self._httpx_args = httpx_args
        self._websocket_connect = websocket_connect
        self._request_timeout = request_timeout

    def _handle(self, info: SandboxInfo, token: CapabilityToken | None = None) -> AsyncSandbox:
        return AsyncSandbox(
            self._api,
            info,
            token,
            agent_port=self._agent_port,
            httpx_args=self._httpx_args,
            websocket_connect=self._websocket_connect,
            request_timeout=self._request_timeout,
            retry=self._retry,
            logger=self._logger,
        )

    async def create(
        self,
        template: str,
        *,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
        deadline_seconds: int | None = None,
        egress: EgressPolicy | None = None,
        idempotency_key: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AsyncSandbox:
        """Create a sandbox and block until a node has acknowledged it.

        Creation is only retried when ``idempotency_key`` is set.

        Args:
            template: A template alias or artifact ID.
            name: Optional name, unique within the organisation.
            metadata: Tenant key-value metadata, filterable in list.
            deadline_seconds: Requested lease length, from now.
            egress: Egress allow and deny lists, fixed at create.
            idempotency_key: Makes retries safe — the same key returns
                the sandbox the first attempt created.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the running sandbox, armed with a capability
            token for its first epoch.
        """
        body = _create_request(template, name, metadata, deadline_seconds, egress)
        key = idempotency_key if idempotency_key is not None else UNSET
        result = _unwrap(
            await self._execute_async(
                lambda: create_sandbox.asyncio_detailed(
                    client=self._api, body=body, idempotency_key=key
                ),
                idempotent=idempotency_key is not None,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, SandboxWithToken)
        return self._handle(result.sandbox, result.token)

    async def get(
        self,
        sandbox_id: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AsyncSandbox:
        """Fetch one sandbox by identifier.

        Args:
            sandbox_id: The sandbox identifier.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the sandbox, holding no capability token.
        """
        info = _unwrap(
            await self._execute_async(
                lambda: get_sandbox.asyncio_detailed(sandbox_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, SandboxInfo)
        return self._handle(info)

    async def list(
        self,
        *,
        state: SandboxState | None = None,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
        limit: int | None = None,
        cursor: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> SandboxList:
        """One page of sandboxes; see :meth:`iterate` for the whole collection.

        Args:
            state: Filter on the tenant-visible state.
            name: Exact match on the tenant-assigned name.
            metadata: Metadata filter; a sandbox matches when every pair
                matches.
            limit: Page size, 1-100.
            cursor: Opaque cursor from a previous page's ``next_cursor``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            One page of sandboxes, most recently created first.
        """
        self._logger.debug("listing sandboxes (cursor=%s, limit=%s)", cursor, limit)
        page = _unwrap(
            await self._execute_async(
                lambda: list_sandboxes.asyncio_detailed(
                    client=self._api,
                    state=state if state is not None else UNSET,
                    name=name if name is not None else UNSET,
                    metadata=_metadata_filter(metadata),
                    limit=limit if limit is not None else UNSET,
                    cursor=cursor if cursor is not None else UNSET,
                ),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, SandboxList)
        return page

    async def iterate(
        self,
        *,
        state: SandboxState | None = None,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
        limit: int | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AsyncIterator[AsyncSandbox]:
        """Walk every page of the collection.

        Args:
            state: Filter on the tenant-visible state.
            name: Exact match on the tenant-assigned name.
            metadata: Metadata filter; a sandbox matches when every pair
                matches.
            limit: Page size, 1-100. Omitted means the server's default.
            request_timeout: Seconds each page fetch may take, overriding
                the client default. ``0`` disables the timeout.
            headers: Extra headers for each page fetch.

        Yields:
            A handle per sandbox, across all pages.
        """
        cursor: str | None = None
        while True:
            page = await self.list(
                state=state,
                name=name,
                metadata=metadata,
                limit=limit,
                cursor=cursor,
                request_timeout=request_timeout,
                headers=headers,
            )
            for info in page.items:
                yield self._handle(info)
            next_cursor = page.next_cursor
            if isinstance(next_cursor, Unset) or next_cursor is None:
                return
            cursor = next_cursor
