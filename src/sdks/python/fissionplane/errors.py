"""Error taxonomy, mirroring the contract's ``Error`` schema.

``code`` is machine-readable and stable across releases; ``retryable``
answers the caller's next line of code. The control plane and the data
plane share one error shape, so one mapping serves both generated cores.
"""

from __future__ import annotations

from fissionplane._api.models.error import Error as _ApiError
from fissionplane._api.types import Response as _ApiResponse
from fissionplane._api.types import Unset as _ApiUnset
from fissionplane._dataplane.models.error import Error as _DataplaneError
from fissionplane._dataplane.types import Response as _DataplaneResponse
from fissionplane._dataplane.types import Unset as _DataplaneUnset


class FissionPlaneError(Exception):
    """Base class for every error raised by the SDK.

    Attributes:
        status (int | None): The HTTP status code, when one applies.
        code (str | None): The contract's machine-readable error code,
            stable across releases.
        retryable (bool): Whether issuing the same request again would
            plausibly work.
        request_id (str | None): The request identifier, for correlating
            with support and audit.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        retryable: bool = False,
        request_id: str | None = None,
    ) -> None:
        """Create an SDK error with optional response metadata.

        Args:
            message: Human-readable error description.
            status: HTTP status code, when the error came from a response.
            code: Stable machine-readable error code.
            retryable: Whether retrying the same request may succeed.
            request_id: Request identifier used for diagnostics.
        """
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable
        self.request_id = request_id


class AuthenticationError(FissionPlaneError):
    """401: missing, malformed, or expired credential."""


class ForbiddenError(FissionPlaneError):
    """403: the credential is valid but does not permit the operation."""


class NotFoundError(FissionPlaneError):
    """404: no such resource, for an authenticated caller."""


class CommandTimeoutError(FissionPlaneError):
    """408: the command did not exit within ``timeout_seconds``; it has
    been killed."""


class ConflictError(FissionPlaneError):
    """409: another lifecycle operation holds the mutex, or the state
    does not permit the operation. Re-read the sandbox and decide."""


class SnapshotExpiredError(FissionPlaneError):
    """410: the snapshot is no longer restorable."""


class RateLimitError(FissionPlaneError):
    """429: a quota or rate limit binds; ``code`` distinguishes which."""


class TemplateBuildError(FissionPlaneError):
    """A template build ended as ``failed``; the message carries the
    build's error string."""


_STATUS_TO_ERROR: dict[int, type[FissionPlaneError]] = {
    401: AuthenticationError,
    403: ForbiddenError,
    404: NotFoundError,
    408: CommandTimeoutError,
    409: ConflictError,
    410: SnapshotExpiredError,
    429: RateLimitError,
}

_ERROR_MODELS = (_ApiError, _DataplaneError)
_UNSET_TYPES = (_ApiUnset, _DataplaneUnset)


def parsed_retryable(response: _ApiResponse | _DataplaneResponse) -> bool | None:
    """The ``retryable`` flag the server set on an error body.

    Args:
        response: A detailed response from either generated core.

    Returns:
        The flag, or ``None`` when the body did not parse as an ``Error``
        or left the field out — the caller then falls back to the status.
    """
    parsed = response.parsed
    if not isinstance(parsed, _ERROR_MODELS) or isinstance(parsed.retryable, _UNSET_TYPES):
        return None
    return parsed.retryable


def raise_for_response(response: _ApiResponse | _DataplaneResponse) -> None:
    """Raise the mapped error for a non-2xx response; no-op otherwise.

    Args:
        response: A detailed response from either generated core.

    Raises:
        FissionPlaneError: The subclass mapped from the HTTP status,
            carrying the contract's ``code``, ``retryable``, and
            ``request_id`` when the body parsed as an ``Error``.
    """
    status = int(response.status_code)
    if status < 400:
        return

    code: str | None = None
    message = f"request failed with status {status}"
    retryable = status >= 500
    request_id: str | None = None
    if isinstance(response.parsed, _ERROR_MODELS):
        code = response.parsed.code
        message = response.parsed.message
        if not isinstance(response.parsed.retryable, _UNSET_TYPES):
            retryable = response.parsed.retryable
        if not isinstance(response.parsed.request_id, _UNSET_TYPES):
            request_id = response.parsed.request_id

    error_class = _STATUS_TO_ERROR.get(status, FissionPlaneError)
    raise error_class(
        message,
        status=status,
        code=code,
        retryable=retryable,
        request_id=request_id,
    )


def _unwrap(response: _ApiResponse | _DataplaneResponse) -> object:
    """Raise for a non-2xx response, then hand back the parsed body."""
    raise_for_response(response)
    return response.parsed
