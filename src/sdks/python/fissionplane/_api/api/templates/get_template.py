from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.error import Error
from ...models.template import Template
from ...types import Response


def _get_kwargs(
    template: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/templates/{template}".format(
            template=quote(str(template), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | Template | None:
    if response.status_code == 200:
        response_200 = Template.from_dict(response.json())

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
) -> Response[Error | Template]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    template: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | Template]:
    """Get a template

     Resolves an alias to its current record. Aliases are mutable;
    the artifact a sandbox is created from is resolved at admission
    time, so reading a template and creating from it can observe
    different artifacts if the alias is re-pointed in between.

    Args:
        template (str): Mutable, human-readable template alias.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Template]
    """

    kwargs = _get_kwargs(
        template=template,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    template: str,
    *,
    client: AuthenticatedClient | Client,
) -> Error | Template | None:
    """Get a template

     Resolves an alias to its current record. Aliases are mutable;
    the artifact a sandbox is created from is resolved at admission
    time, so reading a template and creating from it can observe
    different artifacts if the alias is re-pointed in between.

    Args:
        template (str): Mutable, human-readable template alias.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Template
    """

    return sync_detailed(
        template=template,
        client=client,
    ).parsed


async def asyncio_detailed(
    template: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Error | Template]:
    """Get a template

     Resolves an alias to its current record. Aliases are mutable;
    the artifact a sandbox is created from is resolved at admission
    time, so reading a template and creating from it can observe
    different artifacts if the alias is re-pointed in between.

    Args:
        template (str): Mutable, human-readable template alias.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | Template]
    """

    kwargs = _get_kwargs(
        template=template,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    template: str,
    *,
    client: AuthenticatedClient | Client,
) -> Error | Template | None:
    """Get a template

     Resolves an alias to its current record. Aliases are mutable;
    the artifact a sandbox is created from is resolved at admission
    time, so reading a template and creating from it can observe
    different artifacts if the alias is re-pointed in between.

    Args:
        template (str): Mutable, human-readable template alias.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | Template
    """

    return (
        await asyncio_detailed(
            template=template,
            client=client,
        )
    ).parsed
