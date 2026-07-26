"""Port exposure records for one sandbox.

Every port defaults to private: reachable at its hostname with a
capability token. Exposure records exist to make public access an
explicit, durable, audited opt-in; these are control-plane operations,
delegated to the generated core under ``fissionplane._api``. The server
rejects exposure records for its reserved agent port.
"""

from __future__ import annotations

import builtins
import logging
from collections.abc import Mapping

from fissionplane._api.api.ports import expose_port, list_ports, unexpose_port
from fissionplane._api.client import AuthenticatedClient
from fissionplane._api.models import (
    ExposePortRequest,
    PortExposure,
    PortList,
    PortVisibility,
)
from fissionplane._retry import Caller, RetryPolicy
from fissionplane.errors import _unwrap, raise_for_response


class Ports(Caller):
    """Port exposure operations for one sandbox."""

    def __init__(
        self,
        api: AuthenticatedClient,
        sandbox_id: str,
        *,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Bind the service to one sandbox.

        Args:
            api: The generated control-plane client.
            sandbox_id: The sandbox the records belong to.
            retry: How retryable failures are reissued. Omitted means the
                default policy.
            logger: Where retries are reported. Omitted means the
                ``fissionplane`` logger.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self._sandbox_id = sandbox_id

    def list(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> builtins.list[PortExposure]:
        """List the sandbox's exposure records.

        A port with no record is private — reachable with a capability
        token, like every other port.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call, overriding any header
                of the same name set on the client.

        Returns:
            The sandbox's exposure records.
        """
        page = _unwrap(
            self._execute(
                lambda: list_ports.sync_detailed(self._sandbox_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, PortList)
        return page.items

    def expose(
        self,
        port: int,
        visibility: PortVisibility | str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> PortExposure:
        """Record the port's exposure. Idempotent.

        ``public`` admits anonymous traffic to this tenant application
        port; ``private`` records it without widening access.

        Args:
            port: The port to record, 1-65535.
            visibility: ``"public"`` or ``"private"``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The exposure record, including the port's public URL.

        Example:
            ```python
            exposure = sandbox.ports.expose(3000, "public")
            print(exposure.url)  # https://3000-abc123.sandboxes.example.com
            ```
        """
        body = ExposePortRequest(visibility=PortVisibility(visibility))
        result = _unwrap(
            self._execute(
                lambda: expose_port.sync_detailed(
                    self._sandbox_id, port, client=self._api, body=body
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, PortExposure)
        return result

    def unexpose(
        self,
        port: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Remove the port's exposure record.

        The port returns to the default: private, capability token
        required. Public traffic to the port stops.

        Args:
            port: The port whose record to remove.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            self._execute(
                lambda: unexpose_port.sync_detailed(self._sandbox_id, port, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )


class AsyncPorts(Caller):
    """Async counterpart of :class:`Ports`."""

    def __init__(
        self,
        api: AuthenticatedClient,
        sandbox_id: str,
        *,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Bind the service to one sandbox.

        Args:
            api: The generated control-plane client.
            sandbox_id: The sandbox the records belong to.
            retry: How retryable failures are reissued.
            logger: Where retries are reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self._sandbox_id = sandbox_id

    async def list(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> builtins.list[PortExposure]:
        """List the sandbox's exposure records.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The sandbox's exposure records.
        """
        page = _unwrap(
            await self._execute_async(
                lambda: list_ports.asyncio_detailed(self._sandbox_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, PortList)
        return page.items

    async def expose(
        self,
        port: int,
        visibility: PortVisibility | str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> PortExposure:
        """Record the port's exposure. Idempotent.

        Args:
            port: The port to record, 1-65535.
            visibility: ``"public"`` or ``"private"``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The exposure record, including the port's public URL.
        """
        body = ExposePortRequest(visibility=PortVisibility(visibility))
        result = _unwrap(
            await self._execute_async(
                lambda: expose_port.asyncio_detailed(
                    self._sandbox_id, port, client=self._api, body=body
                ),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, PortExposure)
        return result

    async def unexpose(
        self,
        port: int,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Remove the port's exposure record.

        Args:
            port: The port whose record to remove.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            await self._execute_async(
                lambda: unexpose_port.asyncio_detailed(self._sandbox_id, port, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
