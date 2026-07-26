"""The client entry points over the generated cores.

``FissionPlane`` (sync) and ``AsyncFissionPlane`` expose the same surface;
both delegate every request to the generated clients under
``fissionplane._api`` and ``fissionplane._dataplane``, which are produced
from the specifications and never edited by hand.
"""

from __future__ import annotations

import logging
import os

from fissionplane._api.client import AuthenticatedClient
from fissionplane._http import (
    DEFAULT_REQUEST_TIMEOUT,
    install_async_client,
    install_sync_client,
)
from fissionplane._retry import DEFAULT_MAX_RETRIES, RetryPolicy, default_logger
from fissionplane.commands import DEFAULT_AGENT_PORT
from fissionplane.sandboxes import AsyncSandboxes, Sandboxes
from fissionplane.streaming import AsyncConnect, SyncConnect
from fissionplane.templates import AsyncTemplates, Templates

_DEFAULT_BASE_URL = "https://api.example.com"

_NO_CREDENTIAL_MESSAGE = "no credential: pass api_key/access_token or set FISSIONPLANE_API_KEY"


def _validate_credential(kind: str, value: str) -> str:
    """Reject a credential the transport could never send.

    Args:
        kind: The argument the credential came from, named for the error.
        value: The credential as resolved from arguments or environment.

    Returns:
        The credential, unchanged.

    Raises:
        ValueError: The credential is empty or contains whitespace,
            which no valid credential does and which a header would
            silently mangle.
    """
    if value == "" or any(character.isspace() for character in value):
        raise ValueError(
            f"{kind} is empty or contains whitespace; pass a valid credential as "
            f"FissionPlane({kind}=...) or set FISSIONPLANE_API_KEY"
        )
    return value


def _resolve_credential(api_key: str | None, access_token: str | None) -> tuple[str, str]:
    """Pick the credential and the header it travels in.

    Args:
        api_key: API key, or ``None`` to read ``FISSIONPLANE_API_KEY``.
        access_token: Bearer token used when no API key is available.

    Returns:
        The header name and the header value.

    Raises:
        ValueError: Neither an API key nor an access token is available,
            or the one found is malformed.
    """
    resolved_key = api_key if api_key is not None else os.environ.get("FISSIONPLANE_API_KEY")
    if resolved_key is not None:
        return "X-API-Key", _validate_credential("api_key", resolved_key)
    if access_token is not None:
        return "Authorization", f"Bearer {_validate_credential('access_token', access_token)}"
    raise ValueError(_NO_CREDENTIAL_MESSAGE)


def _resolve_base_url(base_url: str | None) -> str:
    if base_url is not None:
        return base_url
    return os.environ.get("FISSIONPLANE_API_URL", _DEFAULT_BASE_URL)


def _build_api_client(
    api_key: str | None,
    access_token: str | None,
    base_url: str | None,
    httpx_args: dict[str, object] | None,
    request_timeout: float | None,
    is_async: bool,
) -> AuthenticatedClient:
    """Create the generated client using explicit or environment configuration.

    The generated core's own lazy client is replaced by one the SDK
    builds, so every request carries the SDK ``User-Agent`` and the
    default timeout, and per-call overrides reach the transport.

    Args:
        api_key: API key, or ``None`` to read ``FISSIONPLANE_API_KEY``.
        access_token: Bearer token used when no API key is available.
        base_url: Control-plane URL, or ``None`` to use the environment or default.
        httpx_args: Arguments forwarded to the generated client's HTTP transport.
        request_timeout: Default per-request budget in seconds.
        is_async: Configure the async transport rather than the sync one.

    Returns:
        An authenticated generated client.

    Raises:
        ValueError: Neither an API key nor an access token is available,
            or the one found is empty or contains whitespace.
    """
    auth_header, credential = _resolve_credential(api_key, access_token)
    resolved_url = _resolve_base_url(base_url)
    client = AuthenticatedClient(
        base_url=resolved_url,
        token=credential,
        auth_header_name=auth_header,
        prefix="",
        raise_on_unexpected_status=False,
        httpx_args=httpx_args or {},
    )
    install = install_async_client if is_async else install_sync_client
    install(
        client,
        base_url=resolved_url,
        auth_header=auth_header,
        credential=credential,
        request_timeout=request_timeout,
        httpx_args=httpx_args,
    )
    return client


class FissionPlane:
    """The entry point: one client per credential and control plane.

    Attributes:
        sandboxes (Sandboxes): The sandbox collection.
        templates (Templates): The template registry and template builds.
        api (AuthenticatedClient): The generated low-level client, for
            anything the ergonomic layer does not wrap.

    Example:
        ```python
        from fissionplane import FissionPlane

        client = FissionPlane()  # reads FISSIONPLANE_API_KEY
        sandbox = client.sandboxes.create("base")
        result = sandbox.commands.run("python", args=["-V"])
        print(result.stdout)
        sandbox.ports.expose(3000, "public")
        sandbox.pause()
        ```
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        access_token: str | None = None,
        base_url: str | None = None,
        agent_port: int = DEFAULT_AGENT_PORT,
        httpx_args: dict[str, object] | None = None,
        websocket_connect: SyncConnect | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        logger: logging.Logger | None = None,
    ) -> None:
        """Build a client from a credential.

        Args:
            api_key: Organisation API key. Omitted means the
                ``FISSIONPLANE_API_KEY`` environment variable.
            access_token: OIDC bearer token, used when no API key is
                available.
            base_url: The control-plane URL. Omitted means the
                ``FISSIONPLANE_API_URL`` environment variable, then the
                default.
            agent_port: The well-known data-plane port sandboxes serve
                their agent on.
            httpx_args: Extra arguments for the underlying ``httpx``
                clients (control plane and data plane alike), e.g. a
                custom ``transport``. A ``timeout`` or ``headers`` here
                wins over the SDK's defaults.
            websocket_connect: Connector used for the streaming surfaces.
            request_timeout: Seconds any one request may take. ``0`` or
                ``None`` disables the timeout. Override it per call with
                the ``request_timeout`` argument on any operation.
            max_retries: Attempts made after a retryable failure, so the
                default of 2 means at most 3 requests. ``0`` disables
                retrying. Only calls that are safe to reissue are
                retried: reads, and a create carrying an idempotency key.
            logger: Where the SDK reports retries, capability-token
                re-mints, and page fetches, at debug level. Omitted means
                the ``fissionplane`` logger.

        Raises:
            ValueError: No credential was passed or found in the
                environment, or the credential is empty or contains
                whitespace.
        """
        self.api = _build_api_client(
            api_key, access_token, base_url, httpx_args, request_timeout, is_async=False
        )
        retry = RetryPolicy(max_retries=max_retries)
        resolved_logger = logger if logger is not None else default_logger()
        self.sandboxes = Sandboxes(
            self.api,
            agent_port=agent_port,
            httpx_args=httpx_args,
            websocket_connect=websocket_connect,
            request_timeout=request_timeout,
            retry=retry,
            logger=resolved_logger,
        )
        self.templates = Templates(self.api, retry=retry, logger=resolved_logger)


class AsyncFissionPlane:
    """Async counterpart of :class:`FissionPlane`.

    Attributes:
        sandboxes (AsyncSandboxes): The sandbox collection.
        templates (AsyncTemplates): The template registry and builds.
        api (AuthenticatedClient): The generated low-level client, for
            anything the ergonomic layer does not wrap.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        access_token: str | None = None,
        base_url: str | None = None,
        agent_port: int = DEFAULT_AGENT_PORT,
        httpx_args: dict[str, object] | None = None,
        websocket_connect: AsyncConnect | None = None,
        request_timeout: float | None = DEFAULT_REQUEST_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        logger: logging.Logger | None = None,
    ) -> None:
        """Build a client from a credential.

        Args:
            api_key: Organisation API key. Omitted means the
                ``FISSIONPLANE_API_KEY`` environment variable.
            access_token: OIDC bearer token, used when no API key is
                available.
            base_url: The control-plane URL. Omitted means the
                ``FISSIONPLANE_API_URL`` environment variable, then the
                default.
            agent_port: The well-known data-plane port sandboxes serve
                their agent on.
            httpx_args: Extra arguments for the underlying ``httpx``
                clients (control plane and data plane alike). A
                ``timeout`` or ``headers`` here wins over the SDK's
                defaults.
            websocket_connect: Connector used for the streaming surfaces.
            request_timeout: Seconds any one request may take. ``0`` or
                ``None`` disables the timeout.
            max_retries: Attempts made after a retryable failure. ``0``
                disables retrying.
            logger: Where the SDK reports retries, capability-token
                re-mints, and page fetches, at debug level.

        Raises:
            ValueError: No credential was passed or found in the
                environment, or the credential is empty or contains
                whitespace.
        """
        self.api = _build_api_client(
            api_key, access_token, base_url, httpx_args, request_timeout, is_async=True
        )
        retry = RetryPolicy(max_retries=max_retries)
        resolved_logger = logger if logger is not None else default_logger()
        self.sandboxes = AsyncSandboxes(
            self.api,
            agent_port=agent_port,
            httpx_args=httpx_args,
            websocket_connect=websocket_connect,
            request_timeout=request_timeout,
            retry=retry,
            logger=resolved_logger,
        )
        self.templates = AsyncTemplates(self.api, retry=retry, logger=resolved_logger)
