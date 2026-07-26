---
type: Reference
title: Sources
description: The external material this bundle's claims rest on, where the raw copies live, and the rule for citing them.
tags: [reference, sources, provenance]
timestamp: 2026-07-27T11:15:00Z
---

# Sources

Most of this bundle is design reasoning, and reasoning can be argued with on its own terms. A
smaller part is claims about how something else behaves — what the hypervisor does on a mismatched
restore, what the kernel does to a private mapping on discard, what a jailer argument causes. Those
cannot be argued with; they can only be checked. This document says where to check them.

## Why the raw material is pinned rather than linked

A link to a document that changes is not a citation. The hypervisor's documentation is versioned
alongside its code and moves with it, so a claim that was true when it was written can quietly stop
being true, and nothing in a markdown link will say so. Raw copies therefore live under
`references/` at a recorded revision, and a citation names a file and a line in that copy.

`references/` is deliberately not committed. It is bulk third-party material that is reproducible
from the recorded revisions, and treating it as a build input rather than as source keeps the
repository about our own work.

| Source | What it is | What rests on it |
|---|---|---|
| `references/firecracker-docs/` | The hypervisor's own `docs/` tree, pinned at the revision recorded in `PROVENANCE.txt` | The snapshot format and its compatibility requirements, the userfaultfd contract, jailer behaviour, balloon and huge-page semantics, vsock semantics across restore, the production host configuration, and the supported-kernel and release-support windows |
| `references/firecracker-src/` | The jailer's source, at the same revision | The handful of jailer behaviours that are load-bearing for us and documented nowhere — chiefly that enabling a controller writes into every ancestor's delegation file up to the hierarchy root, which decides whether our cgroup preflight can be satisfied at all |
| `references/arxiv/2102.12892.pdf` | *Restoring Uniqueness in MicroVM Snapshots* — Brooker, Catangiu, Danilov, Graf, MacCarthaigh and Sandu, AWS, 2021 | The clone-hygiene argument in [security](architecture/security.md): why reseeding the guest kernel does not make a userspace generator safe, why wiping at suspend beats wiping at restore, and why an external fence is required rather than merely helpful. Also the reseed the agent performs in [vm-steward](components/vm-steward.md), and the limits of what a build-time strip can reach in [template-builder](components/template-builder.md) |

Two production sandbox platforms were also read as source while this bundle was written. They are
not cited by name anywhere, deliberately — a design document that argues from what a competitor
happens to do ages badly and reasons poorly. Where reading them changed something here, the
argument was rewritten to stand on its own, and where they merely agreed with a decision the
agreement is noted without attribution.

## The rule

**A claim about external behaviour cites the pinned copy, or it is marked as unverified.** Not a
memory of the documentation, not a link to its current head, and not an inference from a filename.
This bundle has already had claims that were plausible, widely believed, and wrong — that the
hypervisor refuses a mismatched restore, that dirty-page tracking is the only way to obtain a dirty
set — and each survived until somebody opened the file.

**Where the documentation is silent, the implementation is the fallback, and saying so is part of
the citation.** Some behaviour we depend on is real, load-bearing, and simply undocumented. Citing
the source for it is better than asserting it and better than dropping a true constraint — but the
reader should be told which one they are getting, because a documented behaviour is a promise and
an observed one is a fact about a revision that may not survive the next.

Marking something unverified is a legitimate outcome and a more useful one than a confident
sentence. [Security](architecture/security.md) and [overview](architecture/overview.md) both carry
passages saying that a set of claims about the orchestrator has no prior art behind it, because an
assertion nobody has tested is a different risk from an assertion that is wrong, and the reader
deserves to know which one they are holding.
