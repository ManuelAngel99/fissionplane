from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.sandbox_list import SandboxList
from ...models.sandbox_state import SandboxState
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    limit: int | Unset = 20,
    cursor: str | Unset = UNSET,
    state: SandboxState | Unset = UNSET,
    name: str | Unset = UNSET,
    metadata: str | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["limit"] = limit

    params["cursor"] = cursor

    json_state: str | Unset = UNSET
    if not isinstance(state, Unset):
        json_state = state.value

    params["state"] = json_state

    params["name"] = name

    params["metadata"] = metadata

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/sandboxes",
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | SandboxList | None:
    if response.status_code == 200:
        response_200 = SandboxList.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = Error.from_dict(response.json())

        return response_401

    if response.status_code == 429:
        response_429 = Error.from_dict(response.json())

        return response_429

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | SandboxList]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    limit: int | Unset = 20,
    cursor: str | Unset = UNSET,
    state: SandboxState | Unset = UNSET,
    name: str | Unset = UNSET,
    metadata: str | Unset = UNSET,
) -> Response[Error | SandboxList]:
    """List sandboxes

     Lists the organisation's sandboxes, most recently created first.
    Filterable by state, name, and tenant metadata.

    Args:
        limit (int | Unset):  Default: 20.
        cursor (str | Unset):
        state (SandboxState | Unset): The tenant-visible states — exactly these four. Transitional
            states are internal: a pausing sandbox reads as `running`, a
            resuming one as `paused`.
        name (str | Unset): Tenant-assigned sandbox name, unique within an organisation.
        metadata (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxList]
    """

    kwargs = _get_kwargs(
        limit=limit,
        cursor=cursor,
        state=state,
        name=name,
        metadata=metadata,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    limit: int | Unset = 20,
    cursor: str | Unset = UNSET,
    state: SandboxState | Unset = UNSET,
    name: str | Unset = UNSET,
    metadata: str | Unset = UNSET,
) -> Error | SandboxList | None:
    """List sandboxes

     Lists the organisation's sandboxes, most recently created first.
    Filterable by state, name, and tenant metadata.

    Args:
        limit (int | Unset):  Default: 20.
        cursor (str | Unset):
        state (SandboxState | Unset): The tenant-visible states — exactly these four. Transitional
            states are internal: a pausing sandbox reads as `running`, a
            resuming one as `paused`.
        name (str | Unset): Tenant-assigned sandbox name, unique within an organisation.
        metadata (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxList
    """

    return sync_detailed(
        client=client,
        limit=limit,
        cursor=cursor,
        state=state,
        name=name,
        metadata=metadata,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    limit: int | Unset = 20,
    cursor: str | Unset = UNSET,
    state: SandboxState | Unset = UNSET,
    name: str | Unset = UNSET,
    metadata: str | Unset = UNSET,
) -> Response[Error | SandboxList]:
    """List sandboxes

     Lists the organisation's sandboxes, most recently created first.
    Filterable by state, name, and tenant metadata.

    Args:
        limit (int | Unset):  Default: 20.
        cursor (str | Unset):
        state (SandboxState | Unset): The tenant-visible states — exactly these four. Transitional
            states are internal: a pausing sandbox reads as `running`, a
            resuming one as `paused`.
        name (str | Unset): Tenant-assigned sandbox name, unique within an organisation.
        metadata (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | SandboxList]
    """

    kwargs = _get_kwargs(
        limit=limit,
        cursor=cursor,
        state=state,
        name=name,
        metadata=metadata,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    limit: int | Unset = 20,
    cursor: str | Unset = UNSET,
    state: SandboxState | Unset = UNSET,
    name: str | Unset = UNSET,
    metadata: str | Unset = UNSET,
) -> Error | SandboxList | None:
    """List sandboxes

     Lists the organisation's sandboxes, most recently created first.
    Filterable by state, name, and tenant metadata.

    Args:
        limit (int | Unset):  Default: 20.
        cursor (str | Unset):
        state (SandboxState | Unset): The tenant-visible states — exactly these four. Transitional
            states are internal: a pausing sandbox reads as `running`, a
            resuming one as `paused`.
        name (str | Unset): Tenant-assigned sandbox name, unique within an organisation.
        metadata (str | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | SandboxList
    """

    return (
        await asyncio_detailed(
            client=client,
            limit=limit,
            cursor=cursor,
            state=state,
            name=name,
            metadata=metadata,
        )
    ).parsed
