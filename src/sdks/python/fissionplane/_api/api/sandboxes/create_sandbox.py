from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.create_sandbox_request import CreateSandboxRequest
from ...models.error import Error
from ...models.sandbox_with_token import SandboxWithToken
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: CreateSandboxRequest,
    idempotency_key: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(idempotency_key, Unset):
        headers["Idempotency-Key"] = idempotency_key

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxWithToken | None:
    if response.status_code == 201:
        response_201 = SandboxWithToken.from_dict(response.json())

        return response_201

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = Error.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Error.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if response.status_code == 429:
        response_429 = Error.from_dict(response.json())

        return response_429

    if response.status_code == 503:
        response_503 = Error.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SandboxWithToken]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SandboxWithToken]:
    """Create a sandbox

     Synchronous: the call blocks until a node has acknowledged the
    sandbox, and returns a usable sandbox — identifier, domain, and
    capability token — or an error.

    Supply `Idempotency-Key` to make retries safe: a retry with the
    same key returns the sandbox the first attempt created rather
    than creating a second one.

    Args:
        idempotency_key (str | Unset):
        body (CreateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxWithToken]
    """

    kwargs = _get_kwargs(
        body=body,
        idempotency_key=idempotency_key,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest,
    idempotency_key: str | Unset = UNSET,
) -> Error | SandboxWithToken | None:
    """Create a sandbox

     Synchronous: the call blocks until a node has acknowledged the
    sandbox, and returns a usable sandbox — identifier, domain, and
    capability token — or an error.

    Supply `Idempotency-Key` to make retries safe: a retry with the
    same key returns the sandbox the first attempt created rather
    than creating a second one.

    Args:
        idempotency_key (str | Unset):
        body (CreateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxWithToken
    """

    return sync_detailed(
        client=client,
        body=body,
        idempotency_key=idempotency_key,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest,
    idempotency_key: str | Unset = UNSET,
) -> Response[Error | SandboxWithToken]:
    """Create a sandbox

     Synchronous: the call blocks until a node has acknowledged the
    sandbox, and returns a usable sandbox — identifier, domain, and
    capability token — or an error.

    Supply `Idempotency-Key` to make retries safe: a retry with the
    same key returns the sandbox the first attempt created rather
    than creating a second one.

    Args:
        idempotency_key (str | Unset):
        body (CreateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxWithToken]
    """

    kwargs = _get_kwargs(
        body=body,
        idempotency_key=idempotency_key,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: CreateSandboxRequest,
    idempotency_key: str | Unset = UNSET,
) -> Error | SandboxWithToken | None:
    """Create a sandbox

     Synchronous: the call blocks until a node has acknowledged the
    sandbox, and returns a usable sandbox — identifier, domain, and
    capability token — or an error.

    Supply `Idempotency-Key` to make retries safe: a retry with the
    same key returns the sandbox the first attempt created rather
    than creating a second one.

    Args:
        idempotency_key (str | Unset):
        body (CreateSandboxRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxWithToken
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            idempotency_key=idempotency_key,
        )
    ).parsed
