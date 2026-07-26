"""Bounded retries for the ergonomic layer.

The generated cores issue exactly one request and hand back whatever came
of it. This module decides whether issuing it again is worth the risk: the
contract's ``retryable`` flag answers that for a response, and HTTP method
semantics answer it for a transport failure. Retries never happen inside
the generated cores, so the low-level surface stays exactly one request.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

import httpx

from fissionplane._api.types import Response as _ApiResponse
from fissionplane._dataplane.types import Response as _DataplaneResponse
from fissionplane._http import request_overrides
from fissionplane.errors import parsed_retryable

AnyResponse = _ApiResponse | _DataplaneResponse
"""A detailed response from either generated core."""

LOGGER_NAME = "fissionplane"
"""The default logger the SDK reports retries and token refreshes on."""

DEFAULT_MAX_RETRIES = 2
"""Extra attempts made after the first one fails retryably."""


def default_logger() -> logging.Logger:
    """The SDK's default logger.

    Returns:
        The ``fissionplane`` logger, which emits nothing until the
        application configures logging.
    """
    return logging.getLogger(LOGGER_NAME)


@dataclass(frozen=True)
class RetryPolicy:
    """How often, and how patiently, a retryable failure is reissued.

    Attributes:
        max_retries (int): Attempts made after the first one, so the
            default of 2 means at most 3 requests. ``0`` disables
            retrying.
        base_delay (float): Seconds the first backoff is drawn from.
        factor (float): Multiplier applied to the backoff ceiling per
            attempt.
        max_delay (float): Cap on the backoff ceiling, in seconds.
    """

    max_retries: int = DEFAULT_MAX_RETRIES
    base_delay: float = 0.25
    factor: float = 2.0
    max_delay: float = 8.0


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


async def _async_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def _backoff(policy: RetryPolicy, attempt: int) -> float:
    """Full-jitter exponential backoff, so retries from many clients spread out."""
    ceiling = min(policy.base_delay * policy.factor**attempt, policy.max_delay)
    return random.uniform(0.0, ceiling)


def should_retry(response: AnyResponse) -> bool:
    """Whether the contract says reissuing this request may succeed.

    Args:
        response: A detailed response from either generated core.

    Returns:
        ``True`` when the error body sets ``retryable``, or when the
        status is 429 or 5xx and the body does not deny it.
    """
    status = int(response.status_code)
    flag = parsed_retryable(response)
    if flag is True:
        return True
    if status == 429 or status >= 500:
        return flag is not False
    return False


class Caller:
    """Runs generated operations with overrides, retries, and logging.

    Every ergonomic class inherits this so one policy and one logger flow
    from the entry point down to the last data-plane call.
    """

    def __init__(
        self,
        *,
        retry: RetryPolicy | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Bind an execution policy.

        Args:
            retry: How retryable failures are reissued. Omitted means the
                default policy.
            logger: Where retries and token refreshes are reported.
                Omitted means the ``fissionplane`` logger.
        """
        self._retry = retry if retry is not None else RetryPolicy()
        self._logger = logger if logger is not None else default_logger()

    def _execute(
        self,
        operation: Callable[[], AnyResponse],
        *,
        idempotent: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AnyResponse:
        """Run one generated operation, retrying it when that is safe."""
        with request_overrides(request_timeout, headers):
            return self._retrying(operation, idempotent=idempotent)

    async def _execute_async(
        self,
        operation: Callable[[], Awaitable[AnyResponse]],
        *,
        idempotent: bool = False,
        request_timeout: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> AnyResponse:
        """Async counterpart of :meth:`_execute`."""
        with request_overrides(request_timeout, headers):
            return await self._retrying_async(operation, idempotent=idempotent)

    def _attempts(self, idempotent: bool) -> int:
        if not idempotent or self._retry.max_retries <= 0:
            return 1
        return self._retry.max_retries + 1

    def _report(self, reason: str, attempt: int, delay: float) -> None:
        self._logger.debug(
            "retrying after %s (attempt %d) in %.3fs",
            reason,
            attempt + 1,
            delay,
        )

    def _retrying(self, operation: Callable[[], AnyResponse], *, idempotent: bool) -> AnyResponse:
        attempts = self._attempts(idempotent)
        attempt = 0
        while True:
            final = attempt >= attempts - 1
            try:
                response = operation()
            except httpx.TransportError as error:
                if final:
                    raise
                reason = f"transport error {type(error).__name__}"
            else:
                if final or not should_retry(response):
                    return response
                reason = f"status {int(response.status_code)}"
            delay = _backoff(self._retry, attempt)
            self._report(reason, attempt, delay)
            _sleep(delay)
            attempt += 1

    async def _retrying_async(
        self, operation: Callable[[], Awaitable[AnyResponse]], *, idempotent: bool
    ) -> AnyResponse:
        attempts = self._attempts(idempotent)
        attempt = 0
        while True:
            final = attempt >= attempts - 1
            try:
                response = await operation()
            except httpx.TransportError as error:
                if final:
                    raise
                reason = f"transport error {type(error).__name__}"
            else:
                if final or not should_retry(response):
                    return response
                reason = f"status {int(response.status_code)}"
            delay = _backoff(self._retry, attempt)
            self._report(reason, attempt, delay)
            await _async_sleep(delay)
            attempt += 1
