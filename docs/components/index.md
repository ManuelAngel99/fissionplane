---
type: Index
title: Components
description: One document per deployable unit of fissionplane, describing its internals, interfaces, and failure modes.
tags: [components, index]
timestamp: 2026-07-27T07:33:00Z
---

# Components

Six services and two in-guest programs. Each document describes the component from the inside:
responsibilities, internal structure, interfaces, state, failure modes, and what it must never
do.

## Host side

| Component | Runs as | Responsibility |
|---|---|---|
| [control-plane](control-plane.md) | Deployment | Admission, authentication, placement, the sandbox catalog, template registry, token minting. Off the data path. |
| [gateway](gateway.md) | Deployment behind a LoadBalancer | TLS termination, per-sandbox subdomain routing, token and cookie verification. |
| [vm-host](vm-host.md) | Privileged DaemonSet | Owns every Firecracker process on its node: lifecycle, snapshots, networking, the node artifact cache, and the sandbox API. |
| [template-builder](template-builder.md) | Deployment on the sandbox node pool | Turns an OCI image and a recipe into a bootable template artifact. |
| [artifact-store](artifact-store.md) | Library plus object storage | The artifact manifest format, the object layout, and the node cache with its eviction policy. |

## Guest side

| Component | Runs as | Responsibility |
|---|---|---|
| [vm-init](vm-init.md) | PID 1 inside every sandbox | Mounts, reaping, and supervising `vm-steward`. Deliberately tiny. |
| [vm-steward](vm-steward.md) | Supervised child of `vm-init` | Executes work inside the guest: processes with PTY, filesystem, watches, port relay, lifecycle hooks. |

## Contracts

| Document | Responsibility |
|---|---|
| [vm-protocol](vm-protocol.md) | The wire contract between `vm-host` and `vm-steward`. The one interface sealed into snapshots, and therefore the one that must not churn. |
