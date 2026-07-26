from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.template_build_logs import TemplateBuildLogs
from ...types import UNSET, Response, Unset


def _get_kwargs(
    build_id: str,
    *,
    offset: int | Unset = 0,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["offset"] = offset

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/templates/builds/{build_id}/logs".format(
            build_id=quote(str(build_id), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | TemplateBuildLogs | None:
    if response.status_code == 200:
        response_200 = TemplateBuildLogs.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Error.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = Error.from_dict(response.json())

        return response_404

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | TemplateBuildLogs]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    build_id: str,
    *,
    client: AuthenticatedClient | Client,
    offset: int | Unset = 0,
) -> Response[Error | TemplateBuildLogs]:
    """Read build logs

     Returns log entries starting at `offset`. Poll with the returned
    `next_offset` until the build reaches a terminal status; a call
    at the current end returns an empty page, not an error.

    Args:
        build_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        offset (int | Unset):  Default: 0.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | TemplateBuildLogs]
    """

    kwargs = _get_kwargs(
        build_id=build_id,
        offset=offset,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    build_id: str,
    *,
    client: AuthenticatedClient | Client,
    offset: int | Unset = 0,
) -> Error | TemplateBuildLogs | None:
    """Read build logs

     Returns log entries starting at `offset`. Poll with the returned
    `next_offset` until the build reaches a terminal status; a call
    at the current end returns an empty page, not an error.

    Args:
        build_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        offset (int | Unset):  Default: 0.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | TemplateBuildLogs
    """

    return sync_detailed(
        build_id=build_id,
        client=client,
        offset=offset,
    ).parsed


async def asyncio_detailed(
    build_id: str,
    *,
    client: AuthenticatedClient | Client,
    offset: int | Unset = 0,
) -> Response[Error | TemplateBuildLogs]:
    """Read build logs

     Returns log entries starting at `offset`. Poll with the returned
    `next_offset` until the build reaches a terminal status; a call
    at the current end returns an empty page, not an error.

    Args:
        build_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        offset (int | Unset):  Default: 0.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | TemplateBuildLogs]
    """

    kwargs = _get_kwargs(
        build_id=build_id,
        offset=offset,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    build_id: str,
    *,
    client: AuthenticatedClient | Client,
    offset: int | Unset = 0,
) -> Error | TemplateBuildLogs | None:
    """Read build logs

     Returns log entries starting at `offset`. Poll with the returned
    `next_offset` until the build reaches a terminal status; a call
    at the current end returns an empty page, not an error.

    Args:
        build_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        offset (int | Unset):  Default: 0.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | TemplateBuildLogs
    """

    return (
        await asyncio_detailed(
            build_id=build_id,
            client=client,
            offset=offset,
        )
    ).parsed
