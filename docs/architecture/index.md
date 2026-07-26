---
type: Index
title: Architecture
description: Cross-cutting design documents for fissionplane — system overview, networking, security, and snapshots.
tags: [architecture, index]
timestamp: 2026-07-27T07:33:00Z
---

# Architecture

Four documents describe the design decisions that span more than one component. Read the
[overview](overview.md) first; the other three assume its vocabulary.

- [Overview](overview.md) — the component map, the four planes, request and lifecycle flows,
  and the Kubernetes deployment topology.
- [Networking](networking.md) — per-sandbox networking, egress policy, public port exposure,
  and how the control plane reaches a specific node.
- [Security](security.md) — the trust model, isolation layers, the token model, and the
  privilege boundary on Kubernetes.
- [Snapshots](snapshots.md) — the artifact format, the object store, the node cache, the cold and
  warm restore paths, the pause sequence, and incremental snapshots.

Per-component internals live in [components](../components/index.md).
