#!/usr/bin/env python3
"""Validate the lockstep SDK version used by a release tag."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAG_PATTERN = re.compile(
    r"^sdks/v(?P<version>\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?)$"
)
SEMVER_PATTERN = re.compile(
    r"^(?P<base>\d+\.\d+\.\d+)"
    r"(?:-(?P<kind>alpha|beta|rc)(?:\.(?P<number>\d+))?)?$"
)


def python_version(semver: str) -> str:
    """Convert the supported SemVer prerelease spelling to PEP 440."""
    match = SEMVER_PATTERN.fullmatch(semver)
    if match is None:
        raise ValueError(f"unsupported SDK version: {semver}")

    kind = match.group("kind")
    if kind is None:
        return match.group("base")

    pep_kind = {"alpha": "a", "beta": "b", "rc": "rc"}[kind]
    return f"{match.group('base')}{pep_kind}{match.group('number') or '0'}"


def read_json(path: Path) -> object:
    with path.open(encoding="utf-8") as file:
        return json.load(file)


def locked_package_version(path: Path, package_name: str) -> str:
    source = path.read_text(encoding="utf-8")
    for package in source.split("[[package]]"):
        name = re.search(r'^name\s*=\s*"([^"]+)"', package, re.MULTILINE)
        version = re.search(r'^version\s*=\s*"([^"]+)"', package, re.MULTILINE)
        if name is not None and name.group(1) == package_name and version is not None:
            return version.group(1)
    raise ValueError(f"could not find {package_name} in {path.relative_to(ROOT)}")


def toml_section_version(path: Path, section: str) -> str:
    source = path.read_text(encoding="utf-8")
    match = re.search(
        rf"^\[{re.escape(section)}\]\s*$"
        rf"(?P<body>.*?)(?=^\[|\Z)",
        source,
        re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise ValueError(f"could not find [{section}] in {path.relative_to(ROOT)}")
    version = re.search(r'^version\s*=\s*"([^"]+)"', match.group("body"), re.MULTILINE)
    if version is None:
        raise ValueError(
            f"could not find version in [{section}] in {path.relative_to(ROOT)}"
        )
    return version.group(1)


def quoted_constant(path: Path, name: str) -> str:
    source = path.read_text(encoding="utf-8")
    match = re.search(rf"\b{name}\s*=\s*['\"]([^'\"]+)['\"]", source)
    if match is None:
        raise ValueError(f"could not find {name} in {path.relative_to(ROOT)}")
    return match.group(1)


def validate(tag: str) -> tuple[str, str]:
    tag_match = TAG_PATTERN.fullmatch(tag)
    if tag_match is None:
        raise ValueError(
            "release tag must look like sdks/v1.2.3, sdks/v1.2.3-beta, "
            "or sdks/v1.2.3-beta.1"
        )

    semver = tag_match.group("version")
    pep440 = python_version(semver)

    package_json = read_json(ROOT / "src/sdks/typescript/package.json")
    if not isinstance(package_json, dict):
        raise TypeError("TypeScript package manifest is not an object")

    observed = {
        "src/sdks/typescript/package.json": package_json.get("version"),
        "src/sdks/typescript/src/api/metadata.ts": quoted_constant(
            ROOT / "src/sdks/typescript/src/api/metadata.ts", "sdkVersion"
        ),
        "src/sdks/rust/Cargo.toml": toml_section_version(
            ROOT / "src/sdks/rust/Cargo.toml", "package"
        ),
        "Cargo.lock": locked_package_version(ROOT / "Cargo.lock", "fissionplane"),
    }
    python_observed = {
        "src/sdks/python/pyproject.toml": toml_section_version(
            ROOT / "src/sdks/python/pyproject.toml", "project"
        ),
        "src/sdks/python/fissionplane/_version.py": quoted_constant(
            ROOT / "src/sdks/python/fissionplane/_version.py", "FALLBACK_VERSION"
        ),
        "src/sdks/python/uv.lock": locked_package_version(
            ROOT / "src/sdks/python/uv.lock", "fissionplane"
        ),
    }

    errors = [
        f"{path}: expected {semver}, found {value}"
        for path, value in observed.items()
        if value != semver
    ]
    errors.extend(
        f"{path}: expected {pep440}, found {value}"
        for path, value in python_observed.items()
        if value != pep440
    )
    if errors:
        raise ValueError(
            "release versions do not match the tag:\n- " + "\n- ".join(errors)
        )

    return semver, pep440


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("tag", help="Release tag, for example sdks/v0.1.0")
    parser.add_argument(
        "--github-output",
        type=Path,
        help="Append version metadata to a GitHub Actions output file",
    )
    args = parser.parse_args()

    try:
        semver, pep440 = validate(args.tag)
    except (KeyError, TypeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    prerelease = "-" in semver
    npm_tag = semver.split("-", 1)[1].split(".", 1)[0] if prerelease else "latest"
    print(f"SDK release {semver} (Python {pep440}, npm tag {npm_tag})")

    if args.github_output is not None:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"version={semver}\n")
            output.write(f"python_version={pep440}\n")
            output.write(f"npm_tag={npm_tag}\n")
            output.write(f"prerelease={'true' if prerelease else 'false'}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
