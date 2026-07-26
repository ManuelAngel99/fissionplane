from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.capability_token import CapabilityToken
from ...models.error import Error
from ...models.mint_token_request import MintTokenRequest
from ...types import UNSET, Response, Unset


def _get_kwargs(
    sandbox_id: str,
    *,
    body: MintTokenRequest | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox_id}/token".format(
            sandbox_id=quote(str(sandbox_id), safe=""),
        ),
    }

    if not isinstance(body, Unset):
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> CapabilityToken | Error | None:
    if response.status_code == 201:
        response_201 = CapabilityToken.from_dict(response.json())

        return response_201

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = Error.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Error.from_dict(response.json())

        return response_409

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[CapabilityToken | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sandbox_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: MintTokenRequest | Unset = UNSET,
) -> Response[CapabilityToken | Error]:
    """Mint a capability token

     Mints a capability token for the sandbox's current epoch. Every
    token carries the sandbox ID, the epoch, a scope, and a short
    expiry; there is no long-lived or unscoped credential. A scope
    can only narrow what the caller's own credential permits —
    request specific ports to mint an attenuated token suitable for
    a browser one-time link.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (MintTokenRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CapabilityToken | Error]
    """

    kwargs = _get_kwargs(
        sandbox_id=sandbox_id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: MintTokenRequest | Unset = UNSET,
) -> CapabilityToken | Error | None:
    """Mint a capability token

     Mints a capability token for the sandbox's current epoch. Every
    token carries the sandbox ID, the epoch, a scope, and a short
    expiry; there is no long-lived or unscoped credential. A scope
    can only narrow what the caller's own credential permits —
    request specific ports to mint an attenuated token suitable for
    a browser one-time link.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (MintTokenRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CapabilityToken | Error
    """

    return sync_detailed(
        sandbox_id=sandbox_id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    sandbox_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: MintTokenRequest | Unset = UNSET,
) -> Response[CapabilityToken | Error]:
    """Mint a capability token

     Mints a capability token for the sandbox's current epoch. Every
    token carries the sandbox ID, the epoch, a scope, and a short
    expiry; there is no long-lived or unscoped credential. A scope
    can only narrow what the caller's own credential permits —
    request specific ports to mint an attenuated token suitable for
    a browser one-time link.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (MintTokenRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CapabilityToken | Error]
    """

    kwargs = _get_kwargs(
        sandbox_id=sandbox_id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox_id: str,
    *,
    client: AuthenticatedClient | Client,
    body: MintTokenRequest | Unset = UNSET,
) -> CapabilityToken | Error | None:
    """Mint a capability token

     Mints a capability token for the sandbox's current epoch. Every
    token carries the sandbox ID, the epoch, a scope, and a short
    expiry; there is no long-lived or unscoped credential. A scope
    can only narrow what the caller's own credential permits —
    request specific ports to mint an attenuated token suitable for
    a browser one-time link.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (MintTokenRequest | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CapabilityToken | Error
    """

    return (
        await asyncio_detailed(
            sandbox_id=sandbox_id,
            client=client,
            body=body,
        )
    ).parsed
