"""The distribution version, resolved once at import.

An installed distribution is the source of truth; the fallback keeps the
version readable when the package is imported from a source checkout that
was never installed. The two are kept in step by a test.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

FALLBACK_VERSION = "0.0.1b0"
"""Mirrors ``version`` in ``pyproject.toml``; used when no distribution
metadata is installed."""


def _resolve_version() -> str:
    try:
        return version("fissionplane")
    except PackageNotFoundError:
        return FALLBACK_VERSION


__version__ = _resolve_version()
"""The SDK version."""

USER_AGENT = f"fissionplane-python/{__version__}"
"""The default ``User-Agent`` every request carries."""
