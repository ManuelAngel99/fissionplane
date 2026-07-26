from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.expose_port_request import ExposePortRequest
from ...models.port_exposure import PortExposure
from ...types import Response


def _get_kwargs(
    sandbox_id: str,
    port: int,
    *,
    body: ExposePortRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "put",
        "url": "/v1/sandboxes/{sandbox_id}/ports/{port}".format(
            sandbox_id=quote(str(sandbox_id), safe=""),
            port=quote(str(port), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | PortExposure | None:
    if response.status_code == 200:
        response_200 = PortExposure.from_dict(response.json())

        return response_200

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
) -> Response[Error | PortExposure]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    sandbox_id: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: ExposePortRequest,
) -> Response[Error | PortExposure]:
    """Set a port's exposure

     Records the port's exposure. `public` admits anonymous traffic
    to this one port — an explicit per-sandbox opt-in, recorded
    durably, visible in audit, and defaulting off. `private` records
    the port without widening access. Capability-token scope governs
    authenticated access and is independent of the public exposure
    record. Idempotent: repeating a `PUT` re-asserts the record.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        port (int):
        body (ExposePortRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | PortExposure]
    """

    kwargs = _get_kwargs(
        sandbox_id=sandbox_id,
        port=port,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    sandbox_id: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: ExposePortRequest,
) -> Error | PortExposure | None:
    """Set a port's exposure

     Records the port's exposure. `public` admits anonymous traffic
    to this one port — an explicit per-sandbox opt-in, recorded
    durably, visible in audit, and defaulting off. `private` records
    the port without widening access. Capability-token scope governs
    authenticated access and is independent of the public exposure
    record. Idempotent: repeating a `PUT` re-asserts the record.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        port (int):
        body (ExposePortRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | PortExposure
    """

    return sync_detailed(
        sandbox_id=sandbox_id,
        port=port,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    sandbox_id: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: ExposePortRequest,
) -> Response[Error | PortExposure]:
    """Set a port's exposure

     Records the port's exposure. `public` admits anonymous traffic
    to this one port — an explicit per-sandbox opt-in, recorded
    durably, visible in audit, and defaulting off. `private` records
    the port without widening access. Capability-token scope governs
    authenticated access and is independent of the public exposure
    record. Idempotent: repeating a `PUT` re-asserts the record.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        port (int):
        body (ExposePortRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | PortExposure]
    """

    kwargs = _get_kwargs(
        sandbox_id=sandbox_id,
        port=port,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    sandbox_id: str,
    port: int,
    *,
    client: AuthenticatedClient | Client,
    body: ExposePortRequest,
) -> Error | PortExposure | None:
    """Set a port's exposure

     Records the port's exposure. `public` admits anonymous traffic
    to this one port — an explicit per-sandbox opt-in, recorded
    durably, visible in audit, and defaulting off. `private` records
    the port without widening access. Capability-token scope governs
    authenticated access and is independent of the public exposure
    record. Idempotent: repeating a `PUT` re-asserts the record.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        port (int):
        body (ExposePortRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | PortExposure
    """

    return (
        await asyncio_detailed(
            sandbox_id=sandbox_id,
            port=port,
            client=client,
            body=body,
        )
    ).parsed
