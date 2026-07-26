---
type: Index
title: fissionplane
description: Technical documentation for fissionplane, a platform for running untrusted code inside Firecracker microVMs on Kubernetes.
tags: [fissionplane, architecture, index]
timestamp: 2026-07-27T07:33:00Z
---

# fissionplane

fissionplane runs untrusted code inside hardware-isolated Firecracker microVMs. A *sandbox*
starts in a few hundred milliseconds, exposes a process and filesystem API with full PTY and
streaming support, can publish ports to the public internet, and can be paused to durable
storage and resumed later.

The system is designed to be installed into an existing Kubernetes cluster with a single Helm
chart, and to coexist with unrelated microservices in that cluster without requiring
cluster-wide changes.

## How to read this bundle

This documentation is an [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
bundle: one markdown file per concept, YAML frontmatter for structured fields, ordinary
markdown links for relationships. Start with the architecture overview, then read the
component document for whatever you are changing.

- [Architecture](architecture/index.md) — cross-cutting design: the system as a whole,
  networking, security, and the snapshot subsystem.
- [Components](components/index.md) — one document per deployable unit, describing its
  internals.
- [Sources](sources.md) — the external material the bundle's factual claims rest on, and the
  rule for citing it.

## Document types used in this bundle

| `type` | Meaning |
|---|---|
| `Index` | Navigational document. One per directory. |
| `Architecture` | A cross-cutting design concern spanning several components. |
| `Component` | A single deployable unit or in-guest program, described from the inside. |
| `Reference` | Material the bundle points at rather than argues: sources, provenance, citation rules. |

## Vocabulary

These terms are used precisely throughout, and mean nothing else.

| Term | Definition |
|---|---|
| **Sandbox** | One running Firecracker microVM belonging to one tenant, with its own network namespace, cgroup, and writable disk. |
| **Template** | An immutable, pre-booted artifact a sandbox is created from. Produced by the template builder. |
| **Snapshot** | An immutable artifact capturing a paused sandbox: guest memory, VM device state, and disk. |
| **Artifact** | Any immutable object in the artifact store, described by a manifest. Templates, snapshots, and filesystem layers are all artifacts. |
| **Source map** | The per-file record naming, for every block, which artifact supplies its bytes and where in that artifact's object they sit. A reserved source means the block is zero. It is the only authority on a stored file's contents; allocated extents are never consulted, because a hole becomes a zero byte the moment it reaches object storage. |
| **Parented artifact** | An artifact whose source map names another artifact, so it stores only the blocks that differ. Distinct from lineage, which records provenance and which no read resolves. Templates are never parented. The format permits a block to come from any of several sources; what the writer chooses to produce is a separate policy. |
| **Flattening** | Assembling an artifact and its sources into one local image before a VM starts. The result is node-local state, not an artifact. |
| **Node** | A Kubernetes node in the sandbox node pool, running exactly one `vm-host`. |
| **Sandbox node pool** | The labelled and tainted subset of cluster nodes permitted to run sandboxes. |
| **Guest** | Everything inside the microVM: the guest kernel, `vm-init`, `vm-steward`, and tenant processes. |
| **Occupant** | The tenant workload inside a sandbox. Assumed hostile at all times. |

## System invariants

Every component upholds these. A change that violates one is a design change, not an
implementation detail.

1. **The host is authoritative for lifecycle.** A sandbox can never prevent, delay, or veto
   its own pause or termination.
2. **The guest is hostile.** No host component trusts any byte originating inside a sandbox,
   including bytes from `vm-steward`.
3. **Artifacts are immutable.** Published artifacts are never mutated. A new pause produces a
   new artifact. The manifest is written last and is the commit marker.
4. **PostgreSQL is the source of truth.** Redis is a rebuildable cache. Losing Redis degrades
   latency, never correctness.
5. **Sandboxes are not Kubernetes objects.** They are far too short-lived and numerous for
   etcd. The control plane owns them.
6. **The sealed surface stays small.** `vm-steward` is baked into snapshots and cannot be
   redeployed, so its protocol is minimal, versioned by capability negotiation, and changes
   rarely.
