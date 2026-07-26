"""fissionplane Python SDK.

>>> from fissionplane import FissionPlane
>>> client = FissionPlane()  # reads FISSIONPLANE_API_KEY
>>> sandbox = client.sandboxes.create("base")
>>> print(sandbox.commands.run("echo", args=["hello"]).stdout)
>>> sandbox.ports.expose(3000, "public")
>>> sandbox.pause()

The cores under ``fissionplane._api`` and ``fissionplane._dataplane`` are
generated from ``src/contracts/openapi.yaml`` and ``src/contracts/dataplane.yaml``
(``just generate-sdks``) and never edited by hand.
"""

from fissionplane._api.models import (
    BuildStep,
    CapabilityToken,
    EgressPolicy,
    PortExposure,
    PortVisibility,
    Resources,
    SandboxState,
    Template,
    TemplateBuildLogEntry,
    TemplateBuildStatus,
)
from fissionplane._api.models import (
    Sandbox as SandboxInfo,
)
from fissionplane._api.models import (
    TemplateBuild as TemplateBuildInfo,
)
from fissionplane._dataplane.models import (
    CommandResult,
    FileInfo,
    FileKind,
    Process,
    ProcessLogs,
    PtySize,
)
from fissionplane._http import DEFAULT_REQUEST_TIMEOUT
from fissionplane._retry import DEFAULT_MAX_RETRIES, RetryPolicy
from fissionplane._version import __version__
from fissionplane.client import AsyncFissionPlane, FissionPlane
from fissionplane.commands import (
    DEFAULT_AGENT_PORT,
    AsyncCommands,
    AsyncProcessAttachment,
    AsyncProcessHandle,
    Commands,
    ProcessAttachment,
    ProcessExitEvent,
    ProcessGapEvent,
    ProcessHandle,
    ProcessOutputEvent,
    ProcessStreamEvent,
)
from fissionplane.errors import (
    AuthenticationError,
    CommandTimeoutError,
    ConflictError,
    FissionPlaneError,
    ForbiddenError,
    NotFoundError,
    RateLimitError,
    SnapshotExpiredError,
    TemplateBuildError,
)
from fissionplane.files import (
    AsyncFiles,
    AsyncFileWatch,
    FileChangeEvent,
    FileMoveEvent,
    FileOverflowEvent,
    Files,
    FileWatch,
    FileWatchEvent,
)
from fissionplane.ports import AsyncPorts, Ports
from fissionplane.sandboxes import AsyncSandbox, AsyncSandboxes, Sandbox, Sandboxes
from fissionplane.streaming import StreamingProtocolError
from fissionplane.templates import (
    AsyncTemplateBuild,
    AsyncTemplates,
    TemplateBuild,
    Templates,
)

__all__ = [
    "AsyncCommands",
    "AsyncFiles",
    "AsyncFileWatch",
    "AsyncFissionPlane",
    "AsyncPorts",
    "AsyncProcessAttachment",
    "AsyncProcessHandle",
    "AsyncSandbox",
    "AsyncSandboxes",
    "AsyncTemplateBuild",
    "AsyncTemplates",
    "AuthenticationError",
    "BuildStep",
    "CapabilityToken",
    "CommandResult",
    "CommandTimeoutError",
    "Commands",
    "ConflictError",
    "DEFAULT_AGENT_PORT",
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_REQUEST_TIMEOUT",
    "EgressPolicy",
    "FileChangeEvent",
    "FileInfo",
    "FileKind",
    "FileMoveEvent",
    "FileOverflowEvent",
    "Files",
    "FileWatch",
    "FileWatchEvent",
    "ForbiddenError",
    "NotFoundError",
    "FissionPlane",
    "FissionPlaneError",
    "PortExposure",
    "PortVisibility",
    "Ports",
    "Process",
    "ProcessAttachment",
    "ProcessExitEvent",
    "ProcessGapEvent",
    "ProcessHandle",
    "ProcessLogs",
    "ProcessOutputEvent",
    "ProcessStreamEvent",
    "PtySize",
    "RateLimitError",
    "Resources",
    "RetryPolicy",
    "Sandbox",
    "SandboxInfo",
    "SandboxState",
    "Sandboxes",
    "SnapshotExpiredError",
    "StreamingProtocolError",
    "Template",
    "TemplateBuild",
    "TemplateBuildError",
    "TemplateBuildInfo",
    "TemplateBuildLogEntry",
    "TemplateBuildStatus",
    "Templates",
    "__version__",
]
