"""Template registry and build operations."""

from __future__ import annotations

import asyncio
import builtins
import logging
import time
from collections.abc import Awaitable, Callable, Mapping

from fissionplane._api.api.templates import (
    create_template_build,
    delete_template,
    get_template,
    get_template_build,
    get_template_build_logs,
    list_templates,
)
from fissionplane._api.client import AuthenticatedClient
from fissionplane._api.models import (
    BuildStep,
    CreateTemplateBuildRequest,
    Resources,
    Template,
    TemplateBuildLogEntry,
    TemplateBuildLogs,
    TemplateBuildStatus,
    TemplateList,
)
from fissionplane._api.models import (
    TemplateBuild as TemplateBuildInfo,
)
from fissionplane._api.types import UNSET
from fissionplane._retry import Caller, RetryPolicy
from fissionplane.errors import (
    FissionPlaneError,
    TemplateBuildError,
    _unwrap,
    raise_for_response,
)

_TERMINAL_STATUSES = frozenset({TemplateBuildStatus.SUCCEEDED, TemplateBuildStatus.FAILED})


def _build_request(
    image: str,
    alias: str | None,
    steps: list[BuildStep] | None,
    start_command: str | None,
    ready_command: str | None,
    resources: Resources | None,
) -> CreateTemplateBuildRequest:
    return CreateTemplateBuildRequest(
        image=image,
        alias=alias if alias is not None else UNSET,
        steps=steps if steps is not None else UNSET,
        start_command=start_command if start_command is not None else UNSET,
        ready_command=ready_command if ready_command is not None else UNSET,
        resources=resources if resources is not None else UNSET,
    )


def _finished(info: TemplateBuildInfo) -> TemplateBuildInfo:
    """Return a successful build or raise its reported failure.

    Args:
        info: A terminal template build.

    Returns:
        The successful build.

    Raises:
        TemplateBuildError: The build failed.
    """
    if info.status is TemplateBuildStatus.FAILED:
        detail = info.error if isinstance(info.error, str) else "template build failed"
        raise TemplateBuildError(detail)
    return info


class TemplateBuild(Caller):
    """A live handle on one template build.

    Attributes:
        info (TemplateBuildInfo): The latest known representation of the
            build.
    """

    def __init__(
        self,
        api: AuthenticatedClient,
        info: TemplateBuildInfo,
        *,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Wrap one build representation.

        Args:
            api: The generated control-plane client.
            info: The build representation the handle starts from.
            retry: How retryable failures are reissued.
            logger: Where retries are reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self.info = info

    @property
    def build_id(self) -> str:
        """The build identifier."""
        return self.info.build_id

    def refresh(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TemplateBuildInfo:
        """Re-read the build from the control plane.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call, overriding any header
                of the same name set on the client.

        Returns:
            The refreshed build representation.
        """
        info = _unwrap(
            self._execute(
                lambda: get_template_build.sync_detailed(self.build_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, TemplateBuildInfo)
        self.info = info
        return info

    def logs(
        self,
        offset: int = 0,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> tuple[list[TemplateBuildLogEntry], int]:
        """Read one page of build log entries.

        A call at the current end returns an empty page, not an error.

        Args:
            offset: Entry offset from which to read; pass the returned
                ``next_offset`` on the next poll.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The log entries and the offset for the next poll.
        """
        page = _unwrap(
            self._execute(
                lambda: get_template_build_logs.sync_detailed(
                    self.build_id, client=self._api, offset=offset
                ),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, TemplateBuildLogs)
        return page.entries, page.next_offset

    def wait(
        self,
        poll_interval: float = 2.0,
        timeout: float | None = None,
        *,
        _sleep: Callable[[float], object] = time.sleep,
    ) -> TemplateBuildInfo:
        """Poll the build until it reaches a terminal status.

        Args:
            poll_interval: Seconds between polls.
            timeout: Give up after this many seconds. ``None`` waits
                forever.

        Returns:
            The build representation, with status ``succeeded``.

        Raises:
            TemplateBuildError: The build ended as ``failed``; the message
                carries the build's error.
            FissionPlaneError: ``timeout`` elapsed before a terminal status.

        Example:
            ```python
            build = client.templates.build("python:3.12", alias="py")
            info = build.wait()
            print(info.artifact_id)
            ```
        """
        deadline = time.monotonic() + timeout if timeout is not None else None
        info = self.info
        while info.status not in _TERMINAL_STATUSES:
            if deadline is not None and time.monotonic() >= deadline:
                raise FissionPlaneError(
                    f"build {self.build_id} did not reach a terminal status within {timeout}s"
                )
            _sleep(poll_interval)
            info = self.refresh()
        return _finished(info)


class Templates(Caller):
    """The template registry and template builds."""

    def __init__(
        self,
        api: AuthenticatedClient,
        *,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Bind the service to a control-plane client.

        Args:
            api: The generated control-plane client.
            retry: How retryable failures are reissued. Omitted means the
                default policy.
            logger: Where retries are reported. Omitted means the
                ``fissionplane`` logger.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api

    def _build_handle(self, info: TemplateBuildInfo) -> TemplateBuild:
        return TemplateBuild(self._api, info, retry=self._retry, logger=self._logger)

    def list(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TemplateList:
        """List templates visible to the organisation.

        Args:
            limit: Page size, 1-100.
            cursor: Opaque cursor from a previous page's ``next_cursor``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call, overriding any header
                of the same name set on the client.

        Returns:
            One page of templates.
        """
        page = _unwrap(
            self._execute(
                lambda: list_templates.sync_detailed(
                    client=self._api,
                    limit=limit if limit is not None else UNSET,
                    cursor=cursor if cursor is not None else UNSET,
                ),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, TemplateList)
        return page

    def get(
        self,
        template: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Template:
        """Resolve a template alias or ID to its current record.

        Args:
            template: A template alias or template ID.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The template record.
        """
        result = _unwrap(
            self._execute(
                lambda: get_template.sync_detailed(template, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, Template)
        return result

    def build(
        self,
        image: str,
        *,
        alias: str | None = None,
        steps: builtins.list[BuildStep] | None = None,
        start_command: str | None = None,
        ready_command: str | None = None,
        resources: Resources | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TemplateBuild:
        """Start a template build from an OCI image reference.

        The image tag is resolved to an immutable digest when the build
        starts and never consulted again. The build is asynchronous:
        follow it with :meth:`TemplateBuild.wait` or
        :meth:`TemplateBuild.logs`.

        Args:
            image: OCI image reference.
            alias: Template alias to point at the artifact when the build
                succeeds. Re-pointed atomically.
            steps: Recipe steps, executed in order inside the build VM.
            start_command: Command started at boot, before the warm
                snapshot is captured.
            ready_command: Readiness probe the warm-up waits for before
                capture.
            resources: The compute shape of the artifact.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the queued build.

        Example:
            ```python
            build = client.templates.build(
                "python:3.12",
                alias="py",
                steps=[BuildStep(command="pip install flask")],
            )
            info = build.wait()
            ```
        """
        body = _build_request(image, alias, steps, start_command, ready_command, resources)
        info = _unwrap(
            self._execute(
                lambda: create_template_build.sync_detailed(client=self._api, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, TemplateBuildInfo)
        return self._build_handle(info)

    def get_build(
        self,
        build_id: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TemplateBuild:
        """Fetch one build by identifier.

        Args:
            build_id: The build identifier.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the build.
        """
        info = _unwrap(
            self._execute(
                lambda: get_template_build.sync_detailed(build_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, TemplateBuildInfo)
        return self._build_handle(info)

    def delete(
        self,
        template: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Retire a template record and its alias.

        Existing sandboxes created from the artifact are unaffected.

        Args:
            template: A template alias or template ID.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            self._execute(
                lambda: delete_template.sync_detailed(template, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )


class AsyncTemplateBuild(Caller):
    """Async counterpart of :class:`TemplateBuild`.

    Attributes:
        info (TemplateBuildInfo): The latest known representation of the
            build.
    """

    def __init__(
        self,
        api: AuthenticatedClient,
        info: TemplateBuildInfo,
        *,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Wrap one build representation.

        Args:
            api: The generated control-plane client.
            info: The build representation the handle starts from.
            retry: How retryable failures are reissued.
            logger: Where retries are reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api
        self.info = info

    @property
    def build_id(self) -> str:
        """The build identifier."""
        return self.info.build_id

    async def refresh(
        self,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TemplateBuildInfo:
        """Re-read the build from the control plane.

        Args:
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The refreshed build representation.
        """
        info = _unwrap(
            await self._execute_async(
                lambda: get_template_build.asyncio_detailed(self.build_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, TemplateBuildInfo)
        self.info = info
        return info

    async def logs(
        self,
        offset: int = 0,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> tuple[list[TemplateBuildLogEntry], int]:
        """Read one page of build log entries.

        Args:
            offset: Entry offset from which to read; pass the returned
                ``next_offset`` on the next poll.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The log entries and the offset for the next poll.
        """
        page = _unwrap(
            await self._execute_async(
                lambda: get_template_build_logs.asyncio_detailed(
                    self.build_id, client=self._api, offset=offset
                ),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, TemplateBuildLogs)
        return page.entries, page.next_offset

    async def wait(
        self,
        poll_interval: float = 2.0,
        timeout: float | None = None,
        *,
        _sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
    ) -> TemplateBuildInfo:
        """Poll the build until it reaches a terminal status.

        Args:
            poll_interval: Seconds between polls.
            timeout: Give up after this many seconds. ``None`` waits
                forever.

        Returns:
            The build representation, with status ``succeeded``.

        Raises:
            TemplateBuildError: The build ended as ``failed``; the message
                carries the build's error.
            FissionPlaneError: ``timeout`` elapsed before a terminal status.
        """
        deadline = time.monotonic() + timeout if timeout is not None else None
        info = self.info
        while info.status not in _TERMINAL_STATUSES:
            if deadline is not None and time.monotonic() >= deadline:
                raise FissionPlaneError(
                    f"build {self.build_id} did not reach a terminal status within {timeout}s"
                )
            await _sleep(poll_interval)
            info = await self.refresh()
        return _finished(info)


class AsyncTemplates(Caller):
    """Async counterpart of :class:`Templates`."""

    def __init__(
        self,
        api: AuthenticatedClient,
        *,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Bind the service to a control-plane client.

        Args:
            api: The generated control-plane client.
            retry: How retryable failures are reissued.
            logger: Where retries are reported.
        """
        super().__init__(retry=retry, logger=logger)
        self._api = api

    def _build_handle(self, info: TemplateBuildInfo) -> AsyncTemplateBuild:
        return AsyncTemplateBuild(self._api, info, retry=self._retry, logger=self._logger)

    async def list(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TemplateList:
        """List templates visible to the organisation.

        Args:
            limit: Page size, 1-100.
            cursor: Opaque cursor from a previous page's ``next_cursor``.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            One page of templates.
        """
        page = _unwrap(
            await self._execute_async(
                lambda: list_templates.asyncio_detailed(
                    client=self._api,
                    limit=limit if limit is not None else UNSET,
                    cursor=cursor if cursor is not None else UNSET,
                ),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(page, TemplateList)
        return page

    async def get(
        self,
        template: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Template:
        """Resolve a template alias or ID to its current record.

        Args:
            template: A template alias or template ID.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            The template record.
        """
        result = _unwrap(
            await self._execute_async(
                lambda: get_template.asyncio_detailed(template, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(result, Template)
        return result

    async def build(
        self,
        image: str,
        *,
        alias: str | None = None,
        steps: builtins.list[BuildStep] | None = None,
        start_command: str | None = None,
        ready_command: str | None = None,
        resources: Resources | None = None,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AsyncTemplateBuild:
        """Start a template build from an OCI image reference.

        Args:
            image: OCI image reference.
            alias: Template alias to point at the artifact when the build
                succeeds. Re-pointed atomically.
            steps: Recipe steps, executed in order inside the build VM.
            start_command: Command started at boot, before the warm
                snapshot is captured.
            ready_command: Readiness probe the warm-up waits for before
                capture.
            resources: The compute shape of the artifact.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the queued build.
        """
        body = _build_request(image, alias, steps, start_command, ready_command, resources)
        info = _unwrap(
            await self._execute_async(
                lambda: create_template_build.asyncio_detailed(client=self._api, body=body),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, TemplateBuildInfo)
        return self._build_handle(info)

    async def get_build(
        self,
        build_id: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AsyncTemplateBuild:
        """Fetch one build by identifier.

        Args:
            build_id: The build identifier.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.

        Returns:
            A handle on the build.
        """
        info = _unwrap(
            await self._execute_async(
                lambda: get_template_build.asyncio_detailed(build_id, client=self._api),
                idempotent=True,
                request_timeout=request_timeout,
                headers=headers,
            )
        )
        assert isinstance(info, TemplateBuildInfo)
        return self._build_handle(info)

    async def delete(
        self,
        template: str,
        *,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Retire a template record and its alias.

        Args:
            template: A template alias or template ID.
            request_timeout: Seconds this call may take, overriding the
                client default. ``0`` disables the timeout.
            headers: Extra headers for this call.
        """
        raise_for_response(
            await self._execute_async(
                lambda: delete_template.asyncio_detailed(template, client=self._api),
                request_timeout=request_timeout,
                headers=headers,
            )
        )
