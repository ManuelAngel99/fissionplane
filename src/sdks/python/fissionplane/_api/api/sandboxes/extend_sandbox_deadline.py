from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.extend_deadline_request import ExtendDeadlineRequest
from ...models.sandbox import Sandbox
from ...types import Response


def _get_kwargs(
    sandbox_id: str,
    *,
    body: ExtendDeadlineRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/sandboxes/{sandbox_id}/deadline".format(
            sandbox_id=quote(str(sandbox_id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Sandbox | None:
    if response.status_code == 200:
        response_200 = Sandbox.from_dict(response.json())

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
) -> Response[Error | Sandbox]:
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
    body: ExtendDeadlineRequest,
) -> Response[Error | Sandbox]:
    """Extend a sandbox's deadline

     Sets the sandbox's deadline to now plus `deadline_seconds`,
    bounded by the installation's maximum lease. The deadline is
    recorded here and enforced by the node.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (ExtendDeadlineRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
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
    body: ExtendDeadlineRequest,
) -> Error | Sandbox | None:
    """Extend a sandbox's deadline

     Sets the sandbox's deadline to now plus `deadline_seconds`,
    bounded by the installation's maximum lease. The deadline is
    recorded here and enforced by the node.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (ExtendDeadlineRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
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
    body: ExtendDeadlineRequest,
) -> Response[Error | Sandbox]:
    """Extend a sandbox's deadline

     Sets the sandbox's deadline to now plus `deadline_seconds`,
    bounded by the installation's maximum lease. The deadline is
    recorded here and enforced by the node.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (ExtendDeadlineRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Sandbox]
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
    body: ExtendDeadlineRequest,
) -> Error | Sandbox | None:
    """Extend a sandbox's deadline

     Sets the sandbox's deadline to now plus `deadline_seconds`,
    bounded by the installation's maximum lease. The deadline is
    recorded here and enforced by the node.

    Args:
        sandbox_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        body (ExtendDeadlineRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Sandbox
    """

    return (
        await asyncio_detailed(
            sandbox_id=sandbox_id,
            client=client,
            body=body,
        )
    ).parsed
