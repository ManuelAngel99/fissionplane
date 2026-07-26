<p align="center">
  <img src="assets/lockup.svg" alt="FissionPlane" width="700" />
</p>

<p align="center">
  <em>Open-source, self-hosted infrastructure for secure code execution in isolated Firecracker microVMs.</em>
</p>

<p align="center">
  <a href="https://github.com/ManuelAngel99/fissionplane/actions/workflows/rust.yml">
    <img alt="Rust CI" src="https://github.com/ManuelAngel99/fissionplane/actions/workflows/rust.yml/badge.svg" />
  </a>
  <a href="https://github.com/ManuelAngel99/fissionplane/actions/workflows/typescript.yml">
    <img alt="TypeScript CI" src="https://github.com/ManuelAngel99/fissionplane/actions/workflows/typescript.yml/badge.svg" />
  </a>
  <a href="https://github.com/ManuelAngel99/fissionplane/actions/workflows/sdks.yml">
    <img alt="SDK CI" src="https://github.com/ManuelAngel99/fissionplane/actions/workflows/sdks.yml/badge.svg" />
  </a>
  <a href="LICENSE">
    <img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" />
  </a>
</p>

<p align="center">
  <a href="docs/index.md">Documentation</a> ·
  <a href="docs/architecture/overview.md">Architecture</a> ·
  <a href="src/contracts/">API contracts</a> ·
  <a href="docs/development.md">Development</a>
</p>

FissionPlane gives AI agents, code interpreters, developer tools, and CI
systems a secure place to execute model-generated or user-submitted code.
Each sandbox provides a complete Linux environment with command, filesystem,
network, and lifecycle controls.

## Open source by design

FissionPlane is free and open-source software under the permissive Apache
License 2.0. You may use it in personal or commercial projects. You may
modify, redistribute, and offer services based on it, subject to the license
terms.

The design requires no proprietary FissionPlane service. The control plane,
gateway, node runtime, guest programs, API contracts, and SDKs are all in this
repository.

## Why FissionPlane

- **Built for agentic workflows.** Each agent or task gets a complete Linux
  workspace for commands, files, packages, services, and tools.
- **Hardware isolation.** Each sandbox runs in a Firecracker microVM with its
  own kernel, filesystem, network namespace, and resource limits.
- **Stateful sandboxes.** Pause a sandbox to object storage and resume its
  memory, processes, filesystem, and device state.
- **SDK-driven control.** Lifecycle and data-plane APIs use OpenAPI.
  TypeScript, Python, and Rust SDKs provide programmatic control.
- **Fully self-hosted.** The control plane, data plane, and sandbox compute
  stay in infrastructure that you operate.
- **Kubernetes-native.** One Helm chart installs into an existing cluster
  without custom resources, an operator, or cluster-wide changes.
- **Resilient data path.** Running workloads continue through a control-plane
  outage because the control plane does not proxy sandbox traffic.

## Sandbox capabilities

- Create a sandbox from an immutable template.
- Run commands and stream standard input, output, and errors.
- Open PTY sessions and send process signals.
- Read, write, upload, download, and watch files.
- Expose a guest port through a private or public HTTPS URL.
- Build templates from OCI images and repeatable build steps.
- Pause, resume, extend, and delete a sandbox through an SDK or REST API.

## Architecture

The architecture has four planes:

```text
                         lifecycle gRPC
client ──REST──> control-plane ──────────────────┐
                                                 ▼
client ─HTTPS──> gateway ───────mTLS──────────> vm-host
                 edge plane                    node plane
                                                   │
                                                 vsock
                                                   ▼
                                         Firecracker microVM
                                         vm-init → vm-steward
                                               guest plane
```

- The **control plane** authenticates callers, enforces quotas, places
  sandboxes, records state, and mints capability tokens.
- The **edge plane** terminates TLS, checks access, and routes sandbox traffic
  to the correct node.
- The **node plane** owns Firecracker processes, networking, resource limits,
  snapshots, and the node artifact cache.
- The **guest plane** runs tenant code. FissionPlane treats every byte from the
  guest as hostile.

The template builder converts an OCI image and build steps into a bootable
artifact. PostgreSQL is the source of truth. Redis is a rebuildable routing
cache. S3-compatible object storage holds templates and snapshots.

Read the [system overview](docs/architecture/overview.md) for lifecycle,
request, storage, and failure flows.

## Contracts and SDKs

FissionPlane defines two HTTP contracts:

- [`openapi.yaml`](src/contracts/openapi.yaml) defines sandbox lifecycle,
  templates, tokens, and port exposure.
- [`dataplane.yaml`](src/contracts/dataplane.yaml) defines commands,
  processes, and filesystem operations inside one sandbox.

The TypeScript and Python SDK cores are generated from these contracts.
Handwritten layers provide sandbox handles, errors, pagination, and streaming.
The Rust SDK is handwritten and tested against mock HTTP and WebSocket
servers.

- [TypeScript SDK](src/sdks/typescript/README.md)
- [Python SDK](src/sdks/python/README.md)
- [Rust SDK](src/sdks/rust/README.md)

## Repository map

- [`src/apps`](src/apps) contains independently built services and guest
  programs.
- [`src/libs`](src/libs) contains shared Rust and TypeScript packages.
  [`src/libs/rust/domain`](src/libs/rust/domain) and
  [`src/libs/typescript/core`](src/libs/typescript/core) carry the validated
  value-object definitions for their respective runtimes.
- [`src/contracts`](src/contracts) contains the public HTTP contracts.
- [`src/sdks`](src/sdks) contains the TypeScript, Python, and Rust clients.
- [`docs`](docs/index.md) contains the design and component documents.
- [`deploy/dev`](deploy/dev) initializes local development stores. It does not
  contain production manifests.

Canonical FissionPlane resource IDs are secure 24-character
lowercase-alphanumeric NanoIDs. Rust newtypes and TypeScript Effect Schema
brands validate IDs, names, slugs, aliases, and descriptions at system
boundaries. External identity-provider IDs and content-addressed artifact
digests retain their own formats.

## Development

The local stack starts PostgreSQL, Redis, ClickHouse, and MinIO.

```sh
cp .env.example .env
just dev-up
just watch control-plane
```

The Rust toolchain is pinned in
[`rust-toolchain.toml`](rust-toolchain.toml). Install `cargo-nextest`,
`cargo-deny`, and `cargo-watch` before you run all Rust checks.

```sh
just ci
```

Use Node.js 24 with pnpm 10 for the TypeScript workspace. Use `uv` for the
Python SDK.

```sh
just install-ts
just check-ts
just check-sdks
just lint-spec
```

Run `just --list` to see all development commands. Read the
[local development guide](docs/development.md) for store roles, ports,
migrations, and troubleshooting.

## Documentation

- [Documentation index](docs/index.md) defines the project vocabulary and
  system invariants.
- [System overview](docs/architecture/overview.md) explains components,
  lifecycle flows, storage, and Kubernetes deployment.
- [Security model](docs/architecture/security.md) states trust boundaries,
  host requirements, and known limits.
- [Networking](docs/architecture/networking.md) covers namespaces, routing,
  egress policy, and port exposure.
- [Component documents](docs/components/index.md) assign each service one
  responsibility.
- [TypeScript architecture](docs/typescript-architecture.md) covers the
  console and backoffice applications.

## Contributing

Open an issue before you change an architecture decision, public contract, or
security boundary. Run the relevant checks before you submit a pull request.

Do not edit generated SDK code. Change the contract, then run:

```sh
just generate-sdks
```

## License

FissionPlane is licensed under the
[Apache License, Version 2.0](LICENSE).

Copyright 2026 Manuel Suarez.
