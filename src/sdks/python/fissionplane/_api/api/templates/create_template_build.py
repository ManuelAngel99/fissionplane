from http import HTTPStatus
from typing import Any

import httpx

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.create_template_build_request import CreateTemplateBuildRequest
from ...models.error import Error
from ...models.template_build import TemplateBuild
from ...types import Response


def _get_kwargs(
    *,
    body: CreateTemplateBuildRequest,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/templates/builds",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Error | TemplateBuild | None:
    if response.status_code == 201:
        response_201 = TemplateBuild.from_dict(response.json())

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

    if response.status_code == 429:
        response_429 = Error.from_dict(response.json())

        return response_429

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx.Response
) -> Response[Error | TemplateBuild]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateTemplateBuildRequest,
) -> Response[Error | TemplateBuild]:
    """Start a template build

     Builds a template from an OCI image reference and a recipe. The
    image tag is resolved to an immutable digest when the build
    starts and never consulted again. The build is asynchronous:
    poll the build with `getTemplateBuild`, tail its output with
    `getTemplateBuildLogs`. On success the returned template alias,
    if one was requested, is pointed at the new artifact atomically.

    Args:
        body (CreateTemplateBuildRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | TemplateBuild]
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
    body: CreateTemplateBuildRequest,
) -> Error | TemplateBuild | None:
    """Start a template build

     Builds a template from an OCI image reference and a recipe. The
    image tag is resolved to an immutable digest when the build
    starts and never consulted again. The build is asynchronous:
    poll the build with `getTemplateBuild`, tail its output with
    `getTemplateBuildLogs`. On success the returned template alias,
    if one was requested, is pointed at the new artifact atomically.

    Args:
        body (CreateTemplateBuildRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | TemplateBuild
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateTemplateBuildRequest,
) -> Response[Error | TemplateBuild]:
    """Start a template build

     Builds a template from an OCI image reference and a recipe. The
    image tag is resolved to an immutable digest when the build
    starts and never consulted again. The build is asynchronous:
    poll the build with `getTemplateBuild`, tail its output with
    `getTemplateBuildLogs`. On success the returned template alias,
    if one was requested, is pointed at the new artifact atomically.

    Args:
        body (CreateTemplateBuildRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Error | TemplateBuild]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: CreateTemplateBuildRequest,
) -> Error | TemplateBuild | None:
    """Start a template build

     Builds a template from an OCI image reference and a recipe. The
    image tag is resolved to an immutable digest when the build
    starts and never consulted again. The build is asynchronous:
    poll the build with `getTemplateBuild`, tail its output with
    `getTemplateBuildLogs`. On success the returned template alias,
    if one was requested, is pointed at the new artifact atomically.

    Args:
        body (CreateTemplateBuildRequest):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Error | TemplateBuild
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
