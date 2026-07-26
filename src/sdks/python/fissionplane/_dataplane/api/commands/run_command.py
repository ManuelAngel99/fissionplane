from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.command_result import CommandResult
from ...models.error import Error
from ...models.run_command_request import RunCommandRequest
from ...types import Response


def _get_kwargs(
    *,
    body: RunCommandRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/commands",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> CommandResult | Error | None:
    if response.status_code == 200:
        response_200 = CommandResult.from_dict(response.json())

        return response_200

    if response.status_code == 400:
        response_400 = Error.from_dict(response.json())

        return response_400

    if response.status_code == 401:
        response_401 = Error.from_dict(response.json())

        return response_401

    if response.status_code == 408:
        response_408 = Error.from_dict(response.json())

        return response_408

    if response.status_code == 429:
        response_429 = Error.from_dict(response.json())

        return response_429

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[CommandResult | Error]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: RunCommandRequest,
) -> Response[CommandResult | Error]:
    """Run a command to completion

     Starts the command inside the sandbox and blocks until it exits
    or the timeout elapses. Output is captured and returned in one
    document, truncated at the advertised limit — for unbounded or
    interactive output, use the streaming surface instead.

    Args:
        body (RunCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommandResult | Error]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: RunCommandRequest,
) -> CommandResult | Error | None:
    """Run a command to completion

     Starts the command inside the sandbox and blocks until it exits
    or the timeout elapses. Output is captured and returned in one
    document, truncated at the advertised limit — for unbounded or
    interactive output, use the streaming surface instead.

    Args:
        body (RunCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommandResult | Error
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: RunCommandRequest,
) -> Response[CommandResult | Error]:
    """Run a command to completion

     Starts the command inside the sandbox and blocks until it exits
    or the timeout elapses. Output is captured and returned in one
    document, truncated at the advertised limit — for unbounded or
    interactive output, use the streaming surface instead.

    Args:
        body (RunCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CommandResult | Error]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: RunCommandRequest,
) -> CommandResult | Error | None:
    """Run a command to completion

     Starts the command inside the sandbox and blocks until it exits
    or the timeout elapses. Output is captured and returned in one
    document, truncated at the advertised limit — for unbounded or
    interactive output, use the streaming surface instead.

    Args:
        body (RunCommandRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CommandResult | Error
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
