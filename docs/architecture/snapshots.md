---
type: Architecture
title: Snapshots, registry, and cache
description: The artifact format, the object registry, the node NVMe cache, the cold and warm restore paths for guest memory, the fault-handler contract, the pause sequence, incremental snapshots, how long a paused snapshot stays restorable, and why the root filesystem may be the wrong kind of device.
tags: [architecture, snapshots, storage, firecracker, cache, uffd]
timestamp: 2026-07-27T07:33:00Z
---

# Snapshots, registry, and cache

A sandbox does not boot. It resumes from a snapshot that was booted once, at build time. This
subsystem is what makes that fast, and it is the hardest part of the platform: mistakes here
are invisible until they corrupt a customer's sandbox or make cold starts unusable.

Three tiers hold the same bytes at different distances:

| Tier | Contents | Durability | Purpose |
|---|---|---|---|
| Object storage (S3-compatible) | Every artifact | Durable truth | Survives nodes; the registry |
| Node NVMe | An LRU cache of artifacts, plus per-sandbox writable disks | Disposable | Removes the network from the restore path |
| Host page cache | Clean pages of memory files currently mapped | Volatile | Lets many sandboxes of one template share physical memory |

## Artifact model

An artifact is an immutable, self-describing bundle under a single key prefix.

```
artifacts/<artifact-id>/
├── manifest.json     ← written LAST; its presence means the artifact exists
├── memory            ← guest RAM image (absent for filesystem-only artifacts)
├── memory.map        ← source map for `memory` (present only when it is stored as a diff)
├── vmstate           ← VM device state (absent for filesystem-only artifacts)
└── disk.ext4         ← root filesystem image
```

### Manifest

```json
{
  "format": 1,
  "artifact_id": "…",
  "kind": "template | snapshot | fs-layer",
  "parent_id": "… or null",
  "files": {
    "memory": {
      "size": 2147483648,
      "blake3": "…",
      "chunk_size": 4194304,
      "source_map": { "object": "memory.map", "blake3": "…" }
    },
    "disk.ext4": { "size": 8589934592, "blake3": "…" },
    "vmstate":   { "size": 41234, "blake3": "…" }
  },
  "guest": { "mem_mib": 2048, "vcpus": 2 },
  "runtime": {
    "host_arch": "x86_64",
    "cpu": { "vendor": "…", "family": 6, "model": 143, "microcode": "0x…", "template": "… or null" },
    "host_kernel": "6.1.…",
    "vmm_version": "…",
    "snapshot_format": "…",
    "guest_kernel_id": "…",
    "boot_args": "…",
    "devices": ["virtio-block", "virtio-net", "virtio-vsock", "virtio-rng", "virtio-balloon"],
    "steward_build": "…",
    "steward_capabilities": 12297
  },
  "prefetch": { "memory_ranges": "… file offsets with an access type each, not guest-physical addresses" },
  "created_at": "2026-07-27T07:33:00Z"
}
```

Four rules govern it, and they are cheap now and expensive to retrofit:

1. **The manifest is uploaded last.** Nothing reads an artifact whose manifest is absent, so a
   crash mid-upload leaves orphaned blobs for the collector rather than a half-readable
   artifact that restores into a corrupt VM.
2. **`format` is checked and unknown values are rejected.** A reader that guesses at a format
   it does not understand is how a storage layer accumulates five mutually incompatible
   encodings and a matrix of compatibility flags. One integer, checked on every read.
3. **Published artifacts are never mutated.** Pausing a sandbox produces a new artifact ID. This
   makes caching trivially correct — a cached artifact can never be stale — and makes
   concurrent readers safe without locks.
4. **The manifest holds nothing that scales with image size.** Every field above is bounded and
   human-readable, and the one structure that is not — the per-block source map — lives in a
   sidecar object named and digested from here rather than inlined. The reason is developed
   under [the source map](#the-source-map-is-the-source-of-truth); the rule belongs here,
   because it is what lets the manifest be parsed strictly and cheaply on the sandbox-start
   path.

`runtime` matters more than it looks. Most of it is a **hard filter on placement rather than a
hint**, because the hypervisor requires an identical hardware and software configuration to
restore a memory snapshot: guest CPU and device state are captured verbatim and reloaded
verbatim, with no renegotiation. Not every field is a filter, though, and the exceptions are
noted below the table.

The filter exists because **the hypervisor will not refuse a mismatch.** This is the
counter-intuitive part and it is the whole justification. On a CPU that does not match the one
recorded in the snapshot, the VMM logs a warning and proceeds; the restore *succeeds*, the
sandbox comes up, and the guest faults on a missing instruction arbitrarily later, with nothing
at restore time to attribute it to. Only the snapshot format version hard-fails. So placement is
not saving a doomed restore the cost of failing — it is supplying the check that nothing below it
performs, and the most common way to violate it is a rolling upgrade rather than a heterogeneous
fleet.

| Recorded | Why placement filters on it |
|---|---|
| Host CPU architecture, family and model, or a CPU template identifier | The guest was told at boot which instructions it has, and that answer is frozen in the image. Restoring onto a CPU without one of them faults at the first use, arbitrarily far from the restore and impossible to attribute — and the VMM only warns, so this filter is the sole check in the system. A CPU template substitutes a normalised feature set for the host's raw one, which widens the eligible pool at the cost of masking features; a template identifier is recorded in place of family and model when one is used. **Masking is not enforcement**, which matters more here than it would elsewhere: a guest can still execute an instruction its CPUID says it does not have, and saving and restoring a workload that does so is documented as producing an undefined result (`references/firecracker-docs/snapshotting/versioning.md:133-138`). A template therefore widens the eligible pool without bounding what an occupant may attempt, and the occupant is hostile by invariant. The widening is also bounded to one vendor: representing one vendor as another is not supported, each published template names a single vendor and a short list of models, and an Intel snapshot does not restore on AMD or the reverse (`references/firecracker-docs/cpu_templates/cpu-templates.md:21`, `references/firecracker-docs/cpu_templates/cpu-templates.md:59-65`, `references/firecracker-docs/snapshotting/versioning.md:132`). A mixed-vendor pool is therefore at least two disjoint pools whatever templates are in play. |
| Host microcode revision | **The field that catches a match correct in every other respect**, which is why it is recorded separately rather than folded into the row above. A CPU template is not read from the running host at restore. It is produced offline from a dump taken on one specific combination of processor model, host kernel, firmware and hypervisor version, and upstream's warning is that such a template can lose its validity **while every value in it stays identical** — a microcode update may alter the behaviour of CPU instructions, and a kernel update may change KVM emulation, without changing anything the template records (`references/firecracker-docs/cpu_templates/cpu-template-helper.md:110-122`). A key built from vendor, family, model and template identifier therefore compares equal straight through a microcode rollout, places the restore, and hands the guest a processor whose instructions no longer behave as they did when its assumptions were frozen. That fails the way a CPU mismatch fails — arbitrarily later, unattributably, and without the hypervisor refusing. Every other field in this block differs when something differs; this one exists because nothing else does. Upstream's own remedy is a fingerprint captured when the template is created and compared against the current one continuously; recording the revision here is that comparison moved to placement, which is the only point at which it can still prevent something. |
| Host kernel version | The VMM's device state is written against a particular KVM interface, and saving and loading across host kernels is called unstable outright, because the saved KVM state may carry different semantics on a different kernel (`references/firecracker-docs/snapshotting/versioning.md:88-94`). The allowance this document relies on is narrower than it used to claim. The stated requirement is an identical software and hardware configuration; what is offered against it is an observed compatibility table for named instance families and named version pairs, with the reverse direction excluded and the arrangement explicitly not recommended in production (`references/firecracker-docs/snapshotting/snapshot-support.md:667-683`). So this dimension is written as a preference rather than an exclusion **because an equality filter strands sandboxes across a kernel rollout, not because upstream sanctions the mismatch** — and which pairs are tolerable is per-release information, since each release names the host kernel versions it supports (`references/firecracker-docs/RELEASE_POLICY.md:54-55`). The preference is scored against that list rather than against a general rule about direction. |
| Snapshot format version | The device-state file is a versioned serialisation of the VMM's own structures, and this is the one dimension the VMM does hard-fail on. It is versioned independently of the VMM binary: each build supports exactly one format version and checks the file against it at load (`references/firecracker-docs/snapshotting/versioning.md:10-15`). That independence is what makes the field worth recording separately from `vmm_version`, and it is developed under [how long a paused snapshot stays restorable](#how-long-a-paused-snapshot-stays-restorable). |
| Guest kernel identity and boot args | The memory image *is* that kernel, mid-execution. Recording its identity makes the artifact self-describing, lets a node refuse an image whose guest kernel its agent pairing does not support, and supplies what the boot path needs for artifacts that carry no memory image at all. |
| Device model set | Restore reconstructs exactly the devices the snapshot declares. A node configured to add or omit one produces a mismatch between captured state and reconstructed model. Device state is backwards compatible only in one direction — a device gaining a feature makes its newer snapshots unrestorable on builds that predate it (`references/firecracker-docs/snapshotting/versioning.md:96-102`) — so the binary an artifact selects is a floor and never a ceiling. On aarch64 the interrupt controller generation is a further dimension of the same kind, since snapshots work under either GICv2 or GICv3 but cannot be restored across them (`references/firecracker-docs/snapshotting/snapshot-support.md:128-130`). It is absent from the block today because the fleet is x86_64, and it is the first field this block would need if that changed. |

**The VMM version is a binary-selection key, not a placement filter.** It is recorded for the
same reason as everything else in the block, but it is consumed differently: a node carries
several VMM builds, and the artifact names the one it needs, so the node picks a binary rather
than the fleet picking a node. Filtering on it instead would strand every paused sandbox on the
old build for the length of a rollout, in exchange for nothing — the constraint is satisfiable
locally on every node. A version the node does not carry is a hard failure, which is a
deployment problem with an obvious cause, not a silent one.

**The sealed agent's build identifier is a compatibility-negotiation input, for the same
reason.** `steward_build` names the `vm-steward` build baked into the memory image. Like the VMM
version it is frozen at capture and no node can change it, so filtering on it would strand every
paused sandbox across an agent rollout without making a single node able to satisfy it.

It is recorded because **a capability bit can be honest and still wrong.** An agent that ships a
feature with a bug advertises that feature truthfully; the bit is then sealed into every template
built during that window, and the host is contractually obliged to believe what the agent says
about itself. A reference implementation carries exactly this scar in its version table. The
answer is a host-side **capability quarantine list** — a deployable mapping from build identifier
to a set of bits to subtract from whatever that build advertises — which is owned by
[vm-steward](../components/vm-steward.md)'s protocol and lives outside the artifact, so it can be
changed without touching anything already published.

The field is what lets that list be consulted **before** the restore rather than at the
handshake. Both moments are correct, and the difference is what has already been spent: at
handshake the artifact has been fetched, the VM has been restored, and the sandbox is running,
so a quarantined capability is discovered after the whole create budget is gone. From the
manifest it is known while the create is still a decision.

The set is checked before restore is attempted, because after it there is nothing to check: a
mismatched restore does not report failure.

### How long a paused snapshot stays restorable

Carrying several VMM builds per node removes the rollout problem, and in removing it exposes a
different one this bundle has never bounded: a paused sandbox is restorable only for as long as
some build that can read its device-state file is still deployed, and that is a window with an
end.

Three upstream facts set it. The device-state file is serialised with an encoder that admits no
backwards-compatible change, so **essentially every change to the microVM state description bumps
the format's major version** (`references/firecracker-docs/snapshotting/versioning.md:57-64`).
Each binary supports exactly one format version and checks the file against it at load
(`references/firecracker-docs/snapshotting/versioning.md:10-15`), and this is the one dimension
the VMM hard-fails on rather than warning about. And support for a given release runs out: the
last two minor releases are patched for up to a year, any minor release for at least six months,
and the latest minor of each major for a year from its release date
(`references/firecracker-docs/RELEASE_POLICY.md:47-52`), against a cadence that has been roughly
quarterly (`references/firecracker-docs/RELEASE_POLICY.md:93-99`).

Put together: **the binary an artifact names is a floor and never a ceiling, so nothing collapses
a snapshot's readable window except our own retention of old builds — and a build we retain past
its support window is one that no longer receives fixes for critical bugs or security issues.**
That is the part that binds. Retaining an old VMM to keep an old snapshot restorable is cheap in
disk and expensive in exposure, because the process being kept alive is the one with a hostile
guest inside it. The two costs are not comparable and the security one wins, exactly as it does
for swap in [overview](overview.md).

So a paused snapshot needs a **maximum restorable age**, derived from the support window of the
build its format requires rather than chosen freely, and a sandbox approaching it has two honest
dispositions: restore it on a supported build and pause it again, which rewrites it into the
current format and costs one full pause, or expire it and tell the tenant why. Silently keeping
an unsupported build on the node to serve it is the option that must not be available, and the
refresh path is the one worth building, because it is the same pause path everything else uses.
Nothing here is a new mechanism — the manifest already records `vmm_version` and
`snapshot_format`, and [artifact-store](../components/artifact-store.md) already refuses to
publish a manifest missing either. What is new is that those two fields have an expiry, and
something has to act on it.

The same reasoning is what makes "once it leaves developer preview" a real gate rather than a
formality wherever this document uses the phrase. A preview feature is defined as one that should
not be used in production, may not receive patch releases for critical bugs or security issues at
all, and may change its user-facing behaviour without a major version bump
(`references/firecracker-docs/RELEASE_POLICY.md:142-148`). Adopting one is not accepting some
instability; it is opting out of the support policy that the previous paragraphs just used to
bound our own risk.

### Kinds

- **`template`** — produced by [template-builder](../components/template-builder.md); has no
  parent; the starting point for new sandboxes.
- **`snapshot`** — produced by pausing a sandbox. Its disk is stored as a diff against the image
  the sandbox was created from; its memory is stored whole in the first release.
- **`fs-layer`** — a disk image with no memory or device state, used as the build cache for
  individual recipe steps. Stored as a diff against the preceding generation.

## Registry

Object storage is the registry. There is no separate metadata service: `control-plane` records
artifact rows in PostgreSQL (ownership, aliases, lifecycle state), and the bytes live under
the artifact ID in the bucket. Aliases such as `python:3.12` resolve through PostgreSQL to an
immutable artifact ID, so a tenant naming a template gets a stable answer while the alias can
be re-pointed atomically.

**Collection** runs as a periodic job with two rules: prefixes lacking a manifest after a grace
period were failed uploads and are removed; artifacts marked deleted in PostgreSQL and no
longer referenced by any alias or paused sandbox are removed. Deletion is by prefix, and because
artifacts are immutable, a prefix is either wholly live or wholly collectable.

There is one reference to respect, and only one: **an artifact may not be collected while
another artifact names it as a source**. A diff's source map enumerates everything it depends
on, so the reference is a membership test against a listed set rather than a traversal, and
lineage — the provenance a manifest may record and no read resolves — imposes nothing. The
writer never emits more than one real source, so the set has one element and the check is a
single lookup; the collector is written against the set rather than against that count, so a
deeper chain would cost it nothing.

**Deletion runs in the opposite order from publication, and must.** Publication writes blobs
and then the manifest, so the manifest is the commit marker; deletion therefore removes the
manifest **first** and the blobs only after a grace period. Deleting a blob first would leave a
readable manifest pointing at an object that no longer exists — the same visibly broken
artifact that manifest-last exists to prevent, arrived at from the other direction.

The grace period between the two is not a formality, and it is a different quantity from the
publication grace period. **A sandbox that is still demand-paging holds a live reference on the
stored object, not merely on its local cache file.** A cold restore reads chunks from object
storage for as long as the guest keeps touching new memory, which in the worst case is the
whole life of the sandbox. The interval between removing the manifest and removing the blobs
must therefore be at least the maximum sandbox lifetime, so that no running guest can fault on
a page whose backing object was collected underneath it.

## Node cache

The cache is a directory on a dedicated NVMe filesystem, owned exclusively by
[vm-host](../components/vm-host.md).

It is a `hostPath` volume rather than a PersistentVolume, for a structural reason: DaemonSets
have no volume claim templates, so a per-node PV would require hand-managing one claim per
node. It also lives on its own filesystem rather than under the kubelet's directory, because a
cache that fills by design would otherwise drive the node into permanent disk pressure and
start evicting unrelated workloads.

**Eviction** is ours to implement; Kubernetes will not do it.

- Two watermarks: begin evicting at a high mark, stop at a low mark, plus an absolute cap so
  the same configuration behaves on a 500 GB and a 7 TB node.
- Least-recently-**used**, not least-recently-written. A popular template is written once and
  read constantly.
- **Anything currently mapped by a running sandbox is pinned.** Removing a memory file out from
  under a live VM is a catastrophic failure mode, so eviction consults the pin set and skips.
- **Pins extend to artifacts nothing has mapped.** A parent being flattened for a restore is
  pinned for the duration even though no VM holds it open. Evicting it does not corrupt
  anything — it fails the flatten — but that is an expensive failure caused by an eviction that
  had cheaper choices available.
- Exported metrics: bytes used, hit ratio, evictions, and pinned bytes. The hit ratio is
  effectively the sandbox-start latency distribution, so it belongs on the main dashboard.

On startup `vm-host` reconciles the cache against its lease file, deleting partial downloads
and releasing pins held by sandboxes that no longer exist.

## Restore: the two paths

This is the core mechanism, and it is a hybrid because neither half is sufficient alone.

### Cold: demand-paged from the object store

When a node does not have the memory file, the sandbox must still start promptly, so the VM is
restored with a **userfaultfd** memory backend. Firecracker restores the VM without populating
guest RAM, registers the memory region with userfaultfd, and hands the descriptor to
`vm-host`. When the guest touches an unpopulated page, the kernel parks that vCPU and posts a
fault; `vm-host` resolves the offset, obtains the bytes, installs them, and the vCPU resumes.
Only pages the guest actually touches are ever fetched.

Bytes come from a **local sparse file** backed by chunked ranged reads against object storage.
A read that hits present bytes is served immediately; a miss fetches the containing chunk,
writes it into the sparse file, and then serves. The file fills in as the guest runs, and a
low-priority background filler completes it.

**Chunk size and fault-fill size are separate knobs.** Chunks are fetched at megabyte scale to
amortise request overhead, but a fault must not install a single 4 KiB page when the
surrounding chunk is already in hand — that would cost hundreds of userspace round trips per
chunk. Each fault installs a run of pages around the faulting address.

The run length is a **tradeoff and not a free win**, and it is worth being precise about what
it costs. Pages installed through userfaultfd are private anonymous copies in that VM's address
space, so private resident memory grows by run length × fault count regardless of how many of
the installed pages the guest ever touches. That product is exactly the quantity the page
sharing argument on the warm path is about, so a generous run length buys latency on the cold
path by spending the resource the warm path is designed to conserve. It is tuned against
measured pages-per-fault and per-sandbox resident memory together, never against fault latency
alone.

### Obligations of the fault handler

The handler is a userspace program that a running guest's vCPUs block on. Its obligations are
set out in full here rather than left to the implementation, because each one fails as a hang
or as silent corruption rather than as a bug, none of them shows up in a functional test, and a
guest that has parked on one cannot be recovered.

**The channel to the VMM is a one-shot handshake, and that is the fact the rest of this section
follows from.** The handler binds a unix socket first; the restore call names it; the VMM creates
the userfaultfd object, maps and registers guest memory, connects, and sends two things — the
descriptor, and the guest memory layout, meaning each region's dimensions and its page size in
KiB (`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:76-95`,
`references/firecracker-docs/hugepages.md:64-68`). **After that payload, no further communication
happens on the socket or anywhere else**
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:110-112`).
This is why "an error cannot be returned to a page fault" is a property of the protocol rather
than an observation about page faults in general: there is no back-channel to return one on. It
also settles a question the source map raises, because the region dimensions arrive from the VMM
rather than being derived from configured guest RAM, so the handler never has to infer where the
memory-mapped I/O hole put the second region.

**Removal events must be handled, and handled as zeroes twice over.** A balloon device is
configured — the pre-pause reclaim pass below is what it is there for — and on this path a
balloon discard reaches the host as `MADV_DONTNEED` against the guest memory region, which the
kernel reports to the handler as `UFFD_EVENT_REMOVE`
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:118-122`).
The file backend produces no such event, which is
[its own constraint](#the-backend-choice-decides-whether-a-memory-pause-can-be-incremental). Two
obligations follow and upstream states both: the handler zeroes the pages named in the event, and
**a later fault on a range that was removed is served as a zero page rather than fetched from the
file** (`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:124-133`).
The second is the one that is easy to miss, because the region stays registered after the removal
and a fault on it looks like any other. A handler that treats such a range as merely unpopulated
serves the artifact's original content to a guest that was entitled to zeroes, and nothing
downstream will notice.

**A dead handler hangs the guest forever, and the handler is the thing that has to say so.** The
hypervisor waits indefinitely for a fault to be serviced; there is no timeout and no degraded
mode, and upstream is explicit that a handler which is no longer around leaves the VMM waiting
forever (`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:140-147`).
A handler that panics, deadlocks, or is killed leaves every vCPU that subsequently faults parked,
and the sandbox stops responding without dying, holding its slot, its memory, and its cgroup.
Three things follow. The handler is supervised and its liveness is a monitored signal in its own
right, not something inferred from sandbox health. The fault path needs a defined terminal answer,
so when a fault-path fetch exhausts its retry budget the sandbox is killed — a loud, attributable
failure over a silent hang, and the only disposition the mechanism permits. And the handler
**signals the VMM process directly on its own way out**, which upstream makes the handler's
responsibility rather than the supervisor's, and supplies the means for: the VMM's PID is
recoverable from the socket's peer credentials
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:149-155`).
Doing it from inside the handler is strictly better than waiting to be noticed, because it
converts a hang into an exit at the moment the handler already knows, and because a supervisor
that has to distinguish a hung VMM from a busy one is solving a harder problem than it needs to.

**The mirror-image failure needs a timeout, and it is the one that gets forgotten.** The handler
listens before the restore is issued, so a VMM that dies before connecting — or connects and dies
before sending the layout — leaves the handler blocked on an accept or a read that will never
complete, holding a slot for a sandbox that does not exist. Upstream recommends timeouts on both
waits for exactly this case
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:157-160`).
This costs one deadline and it is the difference between a failed create and a leaked one.

**The removal-event rate is attacker-controlled.** The balloon is a paravirtualised device that
depends on a driver inside the guest, the VMM cannot introspect it, and a compromised driver can
flood the handler with removal events
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:134-138`,
`references/firecracker-docs/ballooning.md:54-72`). Under invariant 2 that is not a degraded case
but the expected one, so the event loop is written to be cheap per event and the jailer's cgroup
is the backstop on what the flood can cost, as upstream recommends. It is also a second reason for
the lock discipline below, beyond the deadlock it exists to prevent: the path an occupant can
drive at will must not be the path that a slow object-store read can block.

**The event-read path must sit on a lock disjoint from the workers.** This is a deadlock rather
than a throughput note, which is why it is a rule and not a tuning remark. The balloon's discard
call blocks inside the kernel until the handler drains the removal event it just generated, so
any lock the event reader has to acquire is a lock the VMM is already waiting on. Our workers
block on object storage while they resolve a fault, so a shared lock means one slow ranged read
against a distant endpoint stops the entire VMM — every vCPU, not the one that faulted. The loop
that reads events therefore takes a lock the workers never touch, and worker state is guarded
separately.

**The install path has four outcomes, and three of them are not errors.** A handler written as
"install the page or fail" is wrong in both directions at once: it kills healthy sandboxes and
it hangs sick ones. Two of the non-error outcomes are produced by concurrency this document
mandates elsewhere.

| Outcome | Cause | Disposition |
|---|---|---|
| Installed | The ordinary case. | Wake the faulting thread. |
| Already present | A concurrent worker or a prefetch install won the race for the same page. | Success — the bytes the guest needs are there. **The wake is still issued.** The winner's install does not wake a thread that parked after it, so a handler that returns early here leaves a vCPU blocked on a page that is already correct. |
| Deferred | A soft failure from the kernel, most often a discard arriving against the range while the copy is in flight. | Queue the address on the handler's own deferred list and signal itself to retry. **The kernel does not redeliver a fault it has already reported**, so nothing else will bring this address back. |
| Discarded | The faulting thread is gone — the VM is being torn down, or the region is unregistered. | Drop it. There is nobody left to wake and retrying installs bytes into a dead address space. |

The deferred case is the one that must not be collapsed into either neighbour, and its cause is
the very balloon the reclaim pass depends on: a concurrent advise call against a range with a
copy in flight is ordinary behaviour, not a malfunction. Treating it as an error kills a sandbox
that is working correctly. Treating it as handled parks a vCPU permanently. So the handler owns
a deferred queue and a self-pipe to wake itself on, because the kernel supplies neither.

**Zeroing a read fault has a required order: zero, then write-protect, then wake.** An anonymous
mapping cannot be write-protected until it has been populated, so the protect must follow the
zero; and the wake must follow the protect, or the guest resumes against a page that is momentarily
writable and the write goes unrecorded. Zeroing a *write* fault takes neither step — the page is
about to be dirtied by definition, and write-protecting it only to fault again immediately is
pure overhead.

**A panic inside the fault path is converted to a fatal error rather than returned.** A
zero-valued return from an install is indistinguishable from a successful install, so a handler
that catches a panic and returns normally reports success for a page it never wrote. The guest
then reads uninitialised memory, or faults on the same address again and panics again — a
deterministic panic becomes an infinite loop that consumes a core and never advances. Killing
the sandbox is the correct answer for the same reason it is the answer to an exhausted retry
budget: the mechanism has no way to tell a guest that a read of its own memory failed.

### Warm: shared and mapped directly

Once the memory file is complete on local disk, subsequent restores use Firecracker's **file**
memory backend, which maps the file privately. Three benefits follow, and the first is the one
that matters at scale:

- **Clean pages are shared.** Every sandbox restored from the same template on the same node
  maps the same physical pages through the host page cache, until it writes to them. The
  demand-paged path cannot do this: it installs private copies per VM.
- Faults are handled in the kernel rather than by a userspace round trip.
- Clean pages are reclaimable under memory pressure and simply re-read from NVMe, instead of
  requiring swap.

### Why not use the file backend for everything

Because a private file mapping over a **full-length sparse file reads zeros**. The precise
shape of the hazard is narrower than it first appears, and getting it right changes what the
cache has to guarantee. A *truncated* file is caught: the VMM compares the declared guest
memory size against the backing file and rejects the restore when the memory size exceeds it.
What is not caught is a file of exactly the right length whose contents have not all arrived —
which is precisely the shape of a cache file being filled by ranged reads. The mapping does not
block waiting for the missing bytes and raises no error; the guest silently observes zeroed
memory. There is no lazy-fetch story for the file backend, which is the gap userfaultfd fills.

Two rules for handling the cache file follow, and both trade a loud failure for a silent one:

- **The file is `ftruncate`d to the exact memory size before any chunk is written.** Growing it
  as chunks arrive would make its length a second, unsynchronised presence record, and would
  turn "incomplete" into "rejected by the VMM" — a failure that looks like a corrupt artifact
  rather than a cache miss. Length carries no information; the presence record carries all of
  it.
- **The file is never truncated or hole-punched while it is mapped.** Shrinking or punching a
  mapped file makes the affected pages inaccessible, and the next guest access takes `SIGBUS`,
  killing the VMM and the sandbox with it. Eviction, reclaim, and error recovery all have to
  respect this, which is why the pin set exists.

### A mapped memory file is immutable

External modification of a file that is currently mapped is undefined behaviour, and the guest
observing the mapping has no way to detect it. This is upstream's own rule rather than an
inference from how mappings work: the memory file must be treated as immutable by the VMM and the
host alike, and modifying it externally corrupts guest memory
(`references/firecracker-docs/snapshotting/snapshot-support.md:472-476`). It also explains why the
file has to survive as long as the sandbox does, since a restore maps it privately and pages from
it on demand for the VM's entire lifetime
(`references/firecracker-docs/snapshotting/snapshot-support.md:76-86`). It constrains two paths
that would otherwise reach for an in-place write:

- **Digest-mismatch recovery never rewrites in place.** A file whose whole-file digest does not
  match is replaced by fetching into a new file and swapping, never by re-fetching the
  offending chunks over the existing one. If the bad file is mapped, in-place repair is
  modifying a live guest's memory underneath it.
- **The background filler never writes a file the file backend has mapped.** The filler's whole
  purpose is to complete a file that the *userfaultfd* path is reading from, which is safe
  because that path copies bytes out and installs them rather than mapping the file into the
  guest. Once a restore has selected the file backend, the file is complete by definition and
  the filler has nothing left to do — but the rule is stated rather than inferred, because the
  inference stops holding the moment anyone adds a repair or a re-verification pass.

### The two paths share one file, when memory is stored whole

The elegant part: **when the memory file is stored whole, the sparse cache file and the complete
memory file are the same file**. A sparse file that has been fully populated *is* a valid memory
image.
So the transition needs no separate format, no conversion, and no migration. A template arrives
on a node, serves its first sandbox lazily, finishes filling in the background, and every later
sandbox on that node gets the shared, kernel-paged path automatically.

The qualification is load-bearing and is developed under [incremental
snapshots](#incremental-snapshots): a memory file **stored as a diff** has to be flattened into a
local file that corresponds to no stored object, so for that class the cache file and the stored
object are different things and the digest that gates the warm path is computed locally rather
than read from the manifest. Templates — the artifacts that back many sandboxes and where sharing
actually pays — always store memory whole, so the property holds exactly where it earns its keep,
and it is unaffected by whether their disk is layered.

Backend selection is a per-restore decision about the **memory file specifically**, since the VMM
accepts it as a parameter on the restore call. It is keyed on how that file is stored rather than
on whether the artifact has a parent, because layering is per-file: an artifact's disk may be a
diff while its memory is not, which is exactly what the first release publishes.

| Memory file | Backend |
|---|---|
| Stored whole, complete verified file present | File |
| Stored whole, file incomplete | userfaultfd |
| Stored as a diff, flattening complete and locally verified | File, over the flattened image |
| Stored as a diff, flattening incomplete | userfaultfd, each fault resolved through the source map |

The last row is what keeps such a restore from waiting on the flatten. The fault handler already
resolves an offset to bytes; with a source map it resolves an offset to a *source* first, and
then to bytes from that source or to a zero page. Flattening proceeds in the background exactly
as the filler does, and the restore switches to the file backend when it completes. A cold
restore of a layered memory file therefore costs at most two chunk fetches per fault rather than
a full download before the guest starts.

**The disk has no equivalent row, and the asymmetry is worth stating rather than inferring.** The
hypervisor opens the root filesystem as an ordinary file, and there is no lazy-fetch path for a
block device short of serving it from userspace, which this design does not do. A layered disk is
therefore assembled in full before the VM starts, where a layered memory file need not be. That
costs less than it sounds — the base is the template's disk, which warmth-aware placement has
usually already put on the node, so assembly is a local copy plus a small diff, against a first
release that fetches the whole disk image regardless. But the property is real and it constrains
what a deep disk chain can cost: the disk's flatten is on the create path, and the memory file's
is not.

### The backend choice decides whether a memory pause can be incremental

The two paths differ in one further way, and it is invisible until a memory diff is written. It
is recorded here, next to the table that produces it, rather than under incremental snapshots,
because the table is where the constraint is actually incurred. It is a statement about the
memory file alone; the disk reaches its diff by a route that does not involve either backend.

**A zero block cannot be observed on the file backend.** Our only source of one is a removal
event from the fault handler, and the file backend registers no userfaultfd at all, so there is
no descriptor for an event to arrive on and nothing to deliver it to. That is the whole argument,
and it is worth stating in that form because the argument this document used to make was a
narrower one that upstream does not support.

The narrower version turned on what a discard *does* against a private file mapping. Upstream
describes the balloon's discard uniformly as `MADV_DONTNEED` against the guest memory region, on
every path that reclaims — inflation, free page reporting, and free page hinting alike
(`references/firecracker-docs/ballooning.md:99-109`, `references/firecracker-docs/ballooning.md:308-312`,
`references/firecracker-docs/ballooning.md:350-356`). It also states the guarantee that a
subsequent access reads zeroes, but states it about memory mapped `MAP_PRIVATE | MAP_ANONYMOUS`
(`references/firecracker-docs/ballooning.md:105-109`) — and a VM restored on the file backend is
not that. Its guest memory is a `MAP_PRIVATE` mapping of the memory file, with writes going to
copy-on-write anonymous pages over the top
(`references/firecracker-docs/snapshotting/snapshot-support.md:76-86`). A `MADV_DONTNEED` against
that shape drops the copy-on-write pages and lets the file's own bytes reappear on the next touch,
which is the opposite of a discard. **No upstream document describes a special case for the
file-backed mapping**, so either the VMM has one that is undocumented, or a warm sandbox that
balloons and then reads the range back gets the snapshot's original content instead of zeroes —
a guest-visible correctness bug, and upstream's to fix rather than ours to work around.

We do not need to know which. The conclusion below holds under both readings, because it rests
on the absence of a userfaultfd rather than on the behaviour of an advise, and a design that
turns on an undocumented branch in someone else's code is one bad release away from being wrong.
Neither dirty source catches the discard either, since the balloon paths do not mark the range
dirty.

A warm, file-backed sandbox that balloons and is then paused incrementally would therefore
publish a diff in which the discarded range is simply not mentioned, and the restore would serve
the parent's bytes for pages the guest had thrown away. That is exactly the failure the zero
state exists to prevent, reached through the backend table rather than through a missing state
in the format. Warm is the steady state, so this is the common case rather than a corner.

The resolution is a constraint, not a mechanism: **an incremental memory pause is available only
to sandboxes backed by userfaultfd, and a file-backed sandbox writes its memory in full.** The
two paths are not interchangeable at pause time and no amount of care in the writer makes them
so. Because the first release writes memory in full anyway, this is a constraint on a future
capability rather than a live defect — but it is written down now because it is the thing that
determines whether the warm path and the incremental memory path can ever coexist, and
rediscovering it after the format is deployed would be expensive.

It says nothing about the disk. A file-backed sandbox still layers its root filesystem, because
that diff is a comparison of two files at rest rather than an inference from events the backend
may or may not deliver. The constraint is on indirect observation, and it binds only the file
that is observed indirectly.

### Hugepages are off

The reason is usually given as two independent reasons. It is two reasons and one dependency, and
the difference matters because only one of the three moves if the backend does.

Say first what is being given up, because the section is more honest with it stated: hugetlbfs is
documented as reducing TLB contention, **reducing the KVM exits needed to rebuild page tables
after a snapshot restore**, and improving boot time by up to half
(`references/firecracker-docs/hugepages.md:41-47`). The second of those lands on the exact path
this subsystem is optimised for. This is not a feature with nothing to recommend it.

**The Kubernetes resource model stands on its own.** Hugepages are modelled as a fixed,
non-overcommittable resource reserved at boot, which fits badly with per-sandbox demand. An
undersized pool is not a soft failure: guest memory is mapped `MAP_NORESERVE`, so pages are
claimed from the pool on demand and a pool that cannot supply them produces erratic behaviour or
`SIGBUS` (`references/firecracker-docs/hugepages.md:49-55`). Pre-allocation is also the clean
example of the init-container conflict [overview](overview.md) records: it succeeds on a freshly
booted node and degrades as memory fragments, so nothing that reruns on pod restart can deliver
it.

**The balloon cannot reclaim hugepage-backed memory, and this reason is independent of
everything else.** The traditional balloon reports free pages at 4 KiB granularity, which leaves
it unable to drop the hugepage backing or reduce resident memory at all — it can still be
inflated to restrict the guest, but the host gets nothing back
(`references/firecracker-docs/hugepages.md:76-79`). That disables the
[pre-pause reclaim pass](#reclaim-before-capture), which this document calls the cheapest lever
available on artifact size. Unlike the sharing argument below, this one does not care which
backend is in use, and it would still hold on a platform that served every sandbox through
userfaultfd.

**The page-sharing argument is conditional on the file backend rather than independent of it —
and the exclusion is harder than "mutually exclusive" suggests.** A snapshot of a microVM backed
by huge pages **can only be restored via userfaultfd**, and there is no option to change page
size at restore time (`references/firecracker-docs/hugepages.md:58-62`). So the choice is not made
per restore; it is made once, at build time, and every sandbox from that template is committed to
the demand-paged path for the life of the template. The warm path would not degrade for those
templates, it would cease to exist, and with it the sharing that is the whole reason the warm path
is preferred. That is decisive here — but it is a property of the backend, not of hugepages, and a
platform serving every sandbox through userfaultfd could run hugepages with no contradiction at
all. A reference implementation does precisely that, for precisely that reason. Recording it as
independent would suggest the question is closed whatever else changes; it is closed because of
the backend, and it reopens with it.

Transparent hugepages are not an escape from any of this. They are documented as **not
integrating with userfaultfd**, so none are allocated while a snapshot resume is being served
through the fault handler (`references/firecracker-docs/hugepages.md:34-36`) — which is to say
they are absent from the cold path and irrelevant on the warm one. Enabling the mode would also
constrain guest memory size to a multiple of 2 MiB
(`references/firecracker-docs/hugepages.md:8-9`), which is a real constraint on what a tenant may
ask for in exchange for nothing on either path.

A further reason is sometimes offered and is wrong, so it is recorded here to stop it coming
back: dropping hugepages does **not** buy finer dirty-tracking granularity. KVM tracks dirty
pages at 4 KiB whatever the backing page size, and when dirty logging is enabled it establishes
the guest's page tables at 4 KiB granularity unconditionally, even where the host uses huge
mappings (`references/firecracker-docs/hugepages.md:71-74`). The interaction runs the other way
round — enabling dirty tracking dismantles the TLB benefit that was the reason to want hugepages
in the first place. Granularity was never the question.

### What the VMM already does at restore

A restore is not a neutral event that leaves the guest exactly as it was paused. The VMM performs
several fixups of its own, and they matter to us in three different ways: one duplicates part of
the post-restore hook, one offers an alternative to another part of it, and one **destroys the
channel the hook travels on**.

| At restore the VMM | Consequence for us |
|---|---|
| Updates the VMGenID device's 16-byte identifier and injects a notification **before resuming vCPUs**. The device is always enabled, and a guest on Linux 5.18 or later reseeds its in-kernel PRNG in response (`references/firecracker-docs/snapshotting/snapshot-support.md:573-597`). | The pool is reseeded, but **not before the guest runs** — it happens when the guest kernel gets round to handling the notification, and upstream tells users on those kernels to perform the explicit ioctl reseed anyway, in the same steps as on kernels without the device, to avoid the race completely (`references/firecracker-docs/snapshotting/random-for-clones.md:180-183`). The device settles eventual state; the agent's reseed inside the hook, ahead of the thaw, is what settles timing, and neither substitutes for the other. Everything outside the kernel pool — unique identifiers, cached random numbers, cryptographic tokens — replicates across every sandbox restored from one artifact regardless. |
| Exposes a VMClock generation counter that changes atomically, so it carries its new value as soon as vCPUs resume; guest userspace can map it or `poll()` the device to be told (`references/firecracker-docs/snapshotting/snapshot-support.md:599-641`). | A guest-side way to observe a restore that needs nothing from the host. It does not replace the hook, for the reason below, and it needs a Linux 7.0 kernel or the backported patches, so it is not available to arbitrary tenant images. |
| Can advance the guest wall clock at load time on x86_64 under kvm-clock, given a host kernel of 5.16 or newer, with the caveat that the jump may upset the guest (`references/firecracker-docs/snapshotting/snapshot-support.md:496-500`). | An alternative to correcting the clock from inside the hook, and the caveat that argues against it upstream does not apply to us: nothing is running to be upset, because the tenant cgroup is still frozen. Worth measuring against the hook's own clock step rather than assumed better. |
| Resets the vsock device — the transport-reset event goes to the guest driver during snapshot **create**, and on resume the driver closes every open connection, while listen sockets survive with their CID updated (`references/firecracker-docs/snapshotting/snapshot-support.md:643-655`). | The control channel does not survive a pause. This is developed in the [pause sequence](#pause-sequence) and it changes it. |

**None of this replaces the post-restore hook, and the reason is the freeze.** VMGenID and VMClock
are both mechanisms for telling *running code* that it has been restored, and after a restore of
ours there is no running tenant code to tell: the tenant cgroup freeze is captured into the
artifact and the hook is what releases it. That ordering is a stronger guarantee than either
device can offer, because it does not depend on the guest noticing anything. What the two devices
change is the division of labour inside the hook — the kernel pool will be reseeded eventually
rather than not at all, the clock has a second possible implementation — rather than the need for
it. Neither shortens the list of steps the hook performs, because a reseed that lands whenever the
guest gets to it is not a reseed that has landed before the thaw.

One VMM limitation belongs to whoever takes the first snapshot rather than to this document: a
snapshot captured very early in guest kernel boot can crash on resume, because the injected
VMGenID notification arrives before the guest can handle interrupts, and upstream's guidance is to
snapshot only after the kernel has finished booting
(`references/firecracker-docs/snapshotting/snapshot-support.md:657-665`). That is a constraint on
[template-builder](../components/template-builder.md)'s seal, not on pausing a sandbox that has
been running for minutes.

### Host prerequisites, and what is not in the snapshot

Restore latency is sensitive to three properties of the node itself, all of which belong in node
preparation and all of which land directly on the create budget. Two further prerequisites are
not about latency at all: without them the cold path does not work, or the restore silently
attaches to the wrong things.

**cgroup v2 is effectively required.** On a v1 hierarchy the hypervisor's own setup work during
restore is materially slower, to the point of dominating the budget the create path is being
held to; upstream lists the latency as a limitation of the feature and recommends v2 deployment
outright (`references/firecracker-docs/snapshotting/snapshot-support.md:121-124`). A v1 node is
treated as misconfigured rather than merely suboptimal, and the preflight check refuses readiness
on it, consistent with the rule that a half-prepared node takes no traffic.

**The block device stays on the synchronous IO engine, and restore latency is why it is
mentioned here.** The asynchronous engine adds up to about 110 ms to device creation, which
upstream lists as landing directly on snapshot restore time, and recommends the synchronous
engine wherever that latency matters
(`references/firecracker-docs/api_requests/block-io-engine.md:69-79`). On a create budget measured
in a few hundred milliseconds that is not a tuning question. The engine choice has two further
consequences that are [security](security.md)'s and [vm-host](../components/vm-host.md)'s rather
than this document's, and both point the same way.

**Recent kernels need a documented KVM workaround.** Newer kernels have introduced behaviour
that adds latency to VM setup unless a specific KVM parameter is applied at module load. The
exact parameter belongs in node preparation and is versioned with it rather than restated here,
but the consequence belongs in this document: a node missing the workaround restores more
slowly, silently, and uniformly, which is the hardest kind of regression to attribute because
every sandbox on the node is equally affected and none of them fail.

**The cold path needs a device node, not just a syscall.** On host kernels from 6.1 the
userfaultfd object is obtained through `/dev/userfaultfd` rather than the syscall, access is
governed by ordinary filesystem permissions, and the jailer exposes it inside the jail **only
when it is present on the host**
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:32-47`). A
node whose image omits it has no cold path: every restore that cannot take the file backend fails,
which is every restore on a cold node, which is every restore during the traffic spike that made
the node cold. It is a node-preparation row of the same kind as the others and fails the same way
they do, uniformly and with no obvious cause.

**The handler, its socket, and the memory file all have to be inside the jail**, and the socket
must be reachable by nothing except the VMM and the handler
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:71-74`). The
cache lives on a dedicated NVMe filesystem that `vm-host` owns, so the memory file reaches the
jail by being presented into it rather than by being copied — which is a second reference on the
inode and is why [artifact-store](../components/artifact-store.md) counts scheduled deletions
rather than filesystem usage when it decides whether eviction has achieved anything.

**Some configuration is not in the snapshot and must be reapplied on every restore.** Logger and
metrics configuration in particular are properties of the running VMM process rather than of the
captured VM, and are documented as not saved
(`references/firecracker-docs/snapshotting/snapshot-support.md:156-157`), so a restored sandbox has
none until `vm-host` sets it. Omitting this does not fail a restore; it produces a sandbox that
runs correctly and emits nothing, which is discovered during the first incident rather than during
the first restore. Dirty-page tracking is in the same class and matters more, because it is a
parameter of the restore call rather than a property of the artifact and is not carried across a
pause (`references/firecracker-docs/snapshotting/snapshot-support.md:486-489`) — which is the
mechanism behind the claim in [dirty tracking](#dirty-tracking-for-memory-has-three-sources) that
the log cannot be enabled retroactively.

**The device state names external host resources, and it names them by string.** This is the
prerequisite most likely to be discovered late, because it is invisible on the node that produced
the snapshot and only bites on a different one. The captured state links the tap device by
interface name, the block device by backing file path, and the vsock channel by socket name, and a
restore reopens each of them exactly as the original process did — the tap must exist under the
same name, the disk must sit at the same relative or absolute path with the same permissions, and
the socket must carry the same name
(`references/firecracker-docs/snapshotting/versioning.md:104-120`,
`references/firecracker-docs/snapshotting/snapshot-support.md:456-461`).

The consequence for us is a naming rule rather than a mechanism: **nothing a restore has to reopen
may be named after anything node-local.** A tap named for its slot index, a disk staged under a
path containing a sandbox instance or a cache generation, or a vsock socket named for the jail it
was created in all work perfectly on the node that took the snapshot and fail on the node that
resumes it — and a failed load is not a soft failure, because the VMM reports a specific error and
**then ends its own process**, on the grounds that it may be in an invalid state
(`references/firecracker-docs/snapshotting/snapshot-support.md:483-484`). So there is a diagnostic
to capture and nothing to retry in place: the error has to be read off a process that is already
gone, and recovery means another restore elsewhere rather than another attempt here. The
jail is what makes this tractable: the paths a restore reopens are relative to the chroot, so
fixed names inside it are stable across nodes by construction. The rule belongs to
[networking](networking.md) and [vm-host](../components/vm-host.md) to uphold; it is stated here
because this is the document that explains why it is not merely a convention.

## Prefetch hints

The final phase of a template build resumes the finished snapshot, records which memory pages a
fresh resume touches, and stores those ranges in the manifest. On restore, `vm-host` populates
them before or alongside the guest starting, which converts a burst of individual faults into
one sequential read. It costs a few hundred lines and directly improves cold-start p99.

**The ranges are file offsets, not guest-physical addresses**, and the manifest field is named
and documented as such. Below roughly 3 GiB of guest RAM the two are the same and the
distinction is invisible; above it the guest memory layout has more than one region, because the
range reserved for memory-mapped I/O below 4 GiB is skipped, and guest-physical addresses above
the hole sit at a different offset in the memory file than their numeric value suggests. Ranges
recorded in one space and consumed in the other therefore work perfectly on small templates and
prefetch the wrong bytes on large ones — no error, just a prefetch that stops helping and a
cold-start regression that correlates with memory size. File offsets are the right choice
because the consumer is a read against the cache file.

**Each range also carries an access type**, read or write, taken from the fault that recorded
it. Ordering is the obvious use, but the load-bearing one is that a prefetcher which installs
every page writable **poisons the dirty set for the first pause**. Pages the guest only ever
read come back indistinguishable from pages it wrote, so the first diff is inflated by the whole
prefetch list and a mechanism that exists to make the sandbox start faster makes its first pause
larger instead. Installing read-recorded pages write-protected keeps them out of the set, at the
cost of one extra ioctl per range and in the same order the zero path uses: populate, protect,
then wake.

## Pause sequence

Order matters, and each step exists for a reason. Two of those reasons are counter-intuitive
enough to state before the sequence: freezing a cgroup is asynchronous and has to be waited on,
and the guest filesystem is deliberately **not** frozen while memory is captured.

1. **`PrePause` to the guest, and the guest does the work.** The host sends `PrePause`; the
   agent stops accepting new work, flushes its own buffers, freezes the tenant cgroup by writing
   `cgroup.freeze`, and then **waits for `cgroup.events` to report `frozen=1`** under a deadline
   before acknowledging. The wait is the load-bearing part. The write returns immediately while
   the kernel stops each task at its next signal-delivery point, and the propagation races
   `fork` — a process that forks mid-freeze can leave a running child behind. A write with no
   confirmation is not a barrier, and every step after this one assumes tenant code has actually
   stopped.
2. **Leave the guest filesystem unfrozen.** This is the step that looks like an omission and is
   not. `FIFREEZE` state lives in the guest's superblock, and the guest's superblock is guest
   memory. Freezing before the capture therefore bakes a *frozen* root filesystem into the
   artifact, and every sandbox ever restored from it blocks on its first write to disk —
   permanently, from a single mistake at capture time, in a way that reproduces on every restore
   and points nowhere near its cause. A memory snapshot takes its disk consistency from the
   captured page cache instead: the guest's own view of the filesystem is captured mid-flight
   along with everything else, so the restored guest sees exactly the filesystem state its
   kernel believed it had. `FIFREEZE` is used in exactly two places, neither of which captures
   memory: filesystem-only artifacts, and the builder's generation seal.
3. **Pause the VM and write state.** The host pauses the VM, then writes memory and device state
   to node NVMe. **Writing state severs the control channel**, which is the step's second effect
   and is invisible in its name: creating a snapshot sends a transport-reset event to the guest's
   vsock driver, and every open vsock connection is closed when the VM next runs
   (`references/firecracker-docs/snapshotting/snapshot-support.md:643-655`). The `PrePause`
   exchange in step 1 completes before this and is unaffected. Everything after it needs a new
   connection.
4. **Reconnect, then resume and thaw, or release.** For a checkpoint the host resumes the VM,
   **re-establishes the control connection**, and only then sends an explicit thaw, which is what
   releases the tenant cgroup. The agent's listen socket survives the reset with its CID updated,
   so there is something to reconnect to, but the connection that carried `PrePause` is gone and
   the thaw cannot be sent on it. For a pause the resources are released instead. Note what
   deliberately persists: **the tenant-cgroup freeze is captured into the artifact**, so a sandbox
   restored from it comes up with its tenant processes still frozen, and the post-restore hook is
   what thaws them. That is the property that lets the post-restore hook correct the clock, reseed
   entropy, and re-establish the environment before any tenant instruction executes.
5. **Upload in the background**, manifest last.

Freeze and thaw are **guest-side protocol operations, not host-side cgroup writes**, for the
same reason everything else in the guest is: the host does not reach into the guest's cgroup
hierarchy. Both are idempotent, so a retried command is free. Two backstops guard the failure
mode where a freeze is never matched by a thaw. The guest carries an **auto-thaw deadline** and
releases the freeze itself if no thaw arrives, which converts "sandbox frozen forever" into
"sandbox that resumed early", a far better failure. And every abort path in the sequence runs an
explicit **thaw-on-abort**, so an error between steps 1 and 4 does not depend on the deadline to
recover.

The vsock reset in step 3 reaches into both backstops, and neither survives being written as a
bare send. A thaw-on-abort firing after step 3 has no connection to send on and has to reconnect
first, which means the abort path is itself capable of failing and needs the deadline behind it
rather than merely preferring it. And the **auto-thaw deadline now has a floor it did not have**:
it must comfortably exceed the time to resume the VM and re-establish the channel, or a checkpoint
that is behaving perfectly self-thaws before its thaw arrives — releasing tenant code during a
window the sequence exists to keep it out of, on the path that runs most often, and only under
load. A deadline chosen against "how long should a frozen sandbox wait" rather than against "how
long does reconnection take" is exactly the plausible wrong answer here.

Two things make the reconnection cheap enough to rely on. It is the same connection establishment
the create path already performs, so no new mechanism is involved, and the agent's listen socket
survives the reset rather than needing to be recreated — which is also what makes the post-restore
hook deliverable at all after a resume, since the hook travels the same way.

The whole sequence runs in a task that is never cancelled midway. Cancellation is checked at
step boundaries only — a cancellation delivered inside step 3 or 4 could leave the VM paused or
the tenant cgroup frozen with nothing scheduled to release either. Concurrency is bounded by a
per-node semaphore, because snapshot writes compete with restore reads for the same NVMe
bandwidth.

### Reclaim before capture

Inside step 1, after the agent has stopped accepting work and before it freezes the cgroup, it
runs a best-effort reclaim pass: `sync`, trim the filesystem, and drop caches. None of it is
required for correctness and all of it is allowed to fail or time out.

It earns its place on size. Everything the guest already considers free is still a page in the
memory image, and page cache holding build inputs and dead allocations is often a substantial
fraction of guest RAM. Reclaiming it before the capture is the **cheapest lever available on
artifact size** — no format change, no new machinery, and it compounds through every cost that
scales with the artifact: upload, storage, cold fetch, and the fault count on every subsequent
restore. It runs before the freeze because a frozen cgroup cannot do any of it.

**The balloon's contribution is continuous rather than a step in this sequence, and that is a
correction.** This pass used to begin by draining the balloon's free page hinting. Hinting is the
host-triggered reclaim mechanism and it is the obvious fit for a pre-pause sweep, which is
presumably why it was chosen — but it is a developer preview feature
(`references/firecracker-docs/ballooning.md:49-52`), and the reason it is one is not maturity. The
device specification permits the guest to reclaim a range before the VMM has received it for
freeing, so the VMM can free memory the guest has already taken back, **potentially corrupting
guest memory**; upstream rates the race unlikely but possible and holds the feature in preview
because of it (`references/firecracker-docs/ballooning.md:448-456`). The documented way to use it
safely requires write-protecting guest memory through userfaultfd for the duration of the run and
skipping ranges that were written (`references/firecracker-docs/ballooning.md:460-466`) — which is
unavailable on the file backend, and the file backend is the steady state. So on the common path
we would have been running a preview feature with a known memory-corruption race and no available
mitigation, to save bytes.

That is also the objection this document already raises against diff snapshots, and it cannot be
applied to one feature and not the other. Under the release policy a preview feature may receive
no patches for critical bugs or security issues and may change behaviour without a major version
bump (`references/firecracker-docs/RELEASE_POLICY.md:142-148`); a corruption race in guest memory
is precisely the class of bug that guarantee would need to cover.

**Free page reporting replaces it and is not a preview feature**
(`references/firecracker-docs/ballooning.md:46-48`). The guest reports unused ranges of its own
accord and the device discards them continuously, reducing resident memory as it goes
(`references/firecracker-docs/ballooning.md:308-314`). Three consequences, and the first is the
one that makes this a better arrangement rather than a consolation. Reclaim stops being something
the pause path has to remember to do and becomes a property the sandbox has at every instant, so
the memory image is already smaller whenever a pause happens to occur — including on the drain
path, where there is no time to run a sweep. What is genuinely lost is the barrier: there is no
way to force a final sweep and wait for it, so a page freed moments before the pause may still be
in the image. The remaining steps of the pass cover most of that gap anyway, because page cache is
the bulk of the reclaimable set and `sync` and drop-caches address it directly. And it is a
pre-boot device setting that cannot be turned on later or turned off at all
(`references/firecracker-docs/ballooning.md:312-314`), so it is a property of the template and is
frozen into the device model the artifact records — which is the right place for it, and one more
reason `runtime.devices` is a compatibility field rather than a note.

Two things about the balloon are worth stating once here, because they bound what any of this can
promise. Inflation and deflation run at a speed the guest driver dictates and the host cannot
influence (`references/firecracker-docs/ballooning.md:470-471`), which is why the pass is
best-effort under a deadline rather than a step that can be waited on. And the device depends
entirely on a cooperative driver: the VMM cannot introspect it, a compromised driver voids every
behavioural guarantee the device otherwise offers, and its statistics are the guest's own account
of itself (`references/firecracker-docs/ballooning.md:54-93`). Under invariant 2 the balloon is
therefore a size optimisation and never a memory limit — the host must remain able to survive the
sandbox using every byte it was given at boot, which is the same conclusion
[overview](overview.md) reaches from swap being disabled, arrived at from the other direction.

### The first pause of a cold sandbox is expensive

A full snapshot **faults in all guest memory**. The VMM writes every page of the memory image,
including pages the guest has never touched, which is documented behaviour and not an
implementation detail that might change
(`references/firecracker-docs/snapshotting/snapshot-support.md:143-148`).

For a sandbox that was restored on the demand-paged path, this is the dominant cost of pausing
and it is worth being blunt about. Such a sandbox may hold only a small fraction of its memory
image locally; the rest is still in object storage, reachable only through the fault handler.
The pause therefore drags **the entire memory image back across the network**, one fault run at
a time, before the VMM can write a single byte of the artifact. The cost is set by the size of
guest RAM and the bandwidth to the object store, and has nothing to do with how much memory the
sandbox actually used.

Three consequences: the pause timeout has to be budgeted against full guest memory rather than
against the resident set; a pause issued shortly after a cold create is close to the worst case
and a pause on a warm node is close to the best; and the background filler, which exists to
serve later restores, incidentally removes most of this cost by completing the file before the
pause needs it. That is a good enough reason to keep the filler running on nodes that hold
pausable sandboxes even when no further restores are expected.

**A memory diff is the only thing that would remove this cost rather than mitigate it.** It would
write only the blocks the guest actually changed, so it would neither read nor write the pages
that were never touched, and the pause would stop scaling with configured guest RAM. The first
release does not write one — the section below specifies the format and states what the
capability is waiting on — so for now the filler and the reclaim pass are the whole of the
answer, and the pause timeout is budgeted accordingly. None of this applies to the disk, which is
layered from the first release for reasons that section also gives.

## Incremental snapshots

An artifact may store only what changed against artifacts it names as sources. The source map is
per **file** rather than per artifact, and that distinction decides the scope of the first
release:

| File | First release | Why |
|---|---|---|
| `memory` | Full every time | Its dirty set can only be obtained from the hypervisor, and no stock way of obtaining it does what is needed. Gated on a VMM decision. |
| `disk.ext4` | Layered from the start | The file is on our own disk and readable at rest, so the diff is a local comparison that asks the hypervisor for nothing. |

Splitting them is not a compromise between two positions. It follows from the fact that guest
memory and a block device are known to us in completely different ways: memory is visible only
through signals the hypervisor chooses to expose, while the root filesystem is a file we already
hold, whose state after a pause is not inferred from anything — it is read. Everything difficult
about incremental memory snapshots comes from that indirection, and none of it applies to the
disk.

The format is untouched by the split, which is the point of having made it per-file. A snapshot
whose `memory` is full and whose `disk.ext4` is a diff is an ordinary artifact: one file carries
a source map, the other does not, and every rule below applies to whichever files have one.

### The root filesystem layers on a stock hypervisor

The disk's diff needs nothing from the VMM, and the reference implementations demonstrate two
independent ways of getting it. One serves the root filesystem through a userspace block device
over a copy-on-write overlay, so the overlay's write cache **is** the dirty set — exact, and free
at pause time. The other hands the hypervisor a plain file and walks it block by block once the
VM has stopped. Neither calls a hypervisor interface at any point, and the second works even
where nothing observed the writes as they happened.

**We specify the second, because it assumes least.** When the VM stops, the sandbox's disk and
the image it was created from are both local files, and the diff is the set of blocks on which
they differ. No dirty source is involved, so none has to be trusted, and the result is minimal by
construction rather than by narrowing something that over-reports. It also holds whatever
[vm-host](../components/vm-host.md) does to materialise the writable disk, which keeps this
specification independent of a mechanism it does not own.

**That the stopped file is complete is an assumption, and upstream states two things that look
like they undermine it.** Snapshot creation does not flush disk contents to their backing files
(`references/firecracker-docs/snapshotting/snapshot-support.md:149-150`), and block device
contents are guaranteed only to have reached the host filesystem rather than the underlying
storage (`references/firecracker-docs/snapshotting/snapshot-support.md:279-282`). Neither is a
problem for the comparison, and the reason is worth writing down because it will look like one
again to the next reader. The comparison reads the backing file through the same host page cache
the device wrote into, so "committed to the host filesystem" is precisely the state it observes;
what is missing is durability against host power loss, and that is answered by the upload rather
than by the file. Writes the device never executed are not missing either — they are still in the
virtqueue, which is guest memory, so they are captured in the memory image and re-issued after
the restore (`references/firecracker-docs/api_requests/patch-block.md:103-108`). Between the two
files every write is accounted for exactly once. This is the same argument as the one for leaving
the guest filesystem unfrozen, reached from the host side: disk consistency comes from the
captured memory, so the disk image is not independently meaningful and a snapshot's two files are
only ever valid as a pair.

It follows that the block device stays on the default `Unsafe` caching strategy, which does not
advertise the flush feature to the guest at all
(`references/firecracker-docs/api_requests/block-caching.md:16-19`). `Writeback` would buy an
`fsync` per guest flush (`references/firecracker-docs/api_requests/block-caching.md:21-28`) and
buy it on the wrong axis: durability of a writable disk that is discarded when the sandbox ends,
paid for on every write of every sandbox on the node. Upstream recommends `Unsafe` for exactly
this shape of workload (`references/firecracker-docs/api_requests/block-caching.md:34-41`), and
what makes it safe here is that the artifact, not the scratch disk, is the durable object.

This is the same comparison pass that [dirty tracking](#dirty-tracking-for-memory-has-three-sources)
establishes is required for memory whatever its dirty source. The difference is that here it is
the entire mechanism rather than the last step of one, because reading a local file is not
expensive in the way faulting in guest memory is. Write tracking, if the node has any, narrows
which blocks are worth comparing and changes the cost rather than the answer — exactly the
relationship residency has to memory.

**The zero problem does not arise here**, and naming why is what makes the split safe rather than
merely convenient. A guest that discards blocks leaves them reading as zeroes in the file, and
the comparison sees a block that differs from the base and records it against the zero sentinel.
There is no event to miss and no backend on which the discard is invisible, because nothing is
being inferred. The constraint that ties incremental *memory* pause to userfaultfd is a statement
about indirect observation, and the disk is not observed indirectly.

The cost is a full read of the image at each pause and each seal. It is bounded by image size,
it runs against local NVMe rather than the network, and it competes with the same device
bandwidth every other snapshot operation does, so it is governed by the same per-node semaphore.
That is a materially different cost from the memory equivalent, which is bounded by the object
store and can exceed any budget worth setting.

**What it buys is the larger half of the saving.** A template chain is mostly root filesystem. A
twenty-step recipe currently stores twenty complete filesystem images for what may be a few
hundred megabytes of real change, and every one of them is paid again on every cold fetch.
Memory diffs would cut pause latency; root filesystem layering cuts stored and transferred
bytes, which is a cost the first release is already paying.

### Incremental memory snapshots are gated on a VMM decision

The hypervisor's diff snapshots are a **developer preview**, and its documentation is explicit
rather than merely cautious about what that means: a diff is generally not resume-able and must be
merged with a base snapshot into a full one, and it may include more pages than strictly needed
because of limits on how accurately accesses can be tracked
(`references/firecracker-docs/snapshotting/snapshot-support.md:208-219`). The single exception
proves the shape of the limitation rather than softening it — a diff taken of a *booted* VM is
immediately resumable, because its base is the zeroed memory the VM started from, and a pause of a
restored sandbox is never that. That is not a stability caveat attached to a working feature. It
is a description of a feature that does not currently do what an incremental pause path needs, and
under the release policy it is also a feature that may receive no patches for critical bugs and
may change behaviour without a major version bump
(`references/firecracker-docs/RELEASE_POLICY.md:142-148`).

**What it is waiting on is named, and the name changes how good the waiting option is.** Diff
snapshots are held in preview pending how the feature should combine with `guest_memfd` support
(`references/firecracker-docs/snapshotting/snapshot-support.md:114-117`). That is guest memory as
a file descriptor — the same capability the one production system doing this forks to obtain. So
the two routes below are not independent bets on different futures: upstream is working toward the
mechanism that the fork exists to supply, which makes waiting a bet on a named piece of work
rather than on general goodwill, without making it a bet with a date on it.

What production practice shows is sharper. The only system doing incremental memory snapshots at
scale **does not use the feature, and explicitly turns off the tracking that feeds it.** It
configures the VMM with dirty-page logging disabled, takes delivery of guest memory as a shared
file descriptor handed out of the hypervisor process, tracks dirtiness itself in its fault
handler, and assembles the diff out of band. Upstream hands nothing out of the process, so that
is a fork — and it is the same fork that patches in the virtio block queue drain
[template-builder](../components/template-builder.md) records upstream as not offering. The
other reference implementation has no memory snapshots at all.

Note what that arrangement is actually buying: not a better diff algorithm, but **access to the
bytes**. The comparison against the parent is the same one the disk path performs; what the fork
supplies is a way to read guest memory cheaply enough to run it. The disk needs no equivalent,
because its bytes were never inside the hypervisor to begin with.

So there are two routes to the capability, and neither is free:

| Route | What it costs |
|---|---|
| Adopt the preview feature once it leaves preview | Only waiting, with no control over how long. Both the merge-into-a-base requirement and the over-reporting would have to be resolved upstream, and neither is on a published schedule — but the work it is blocked behind is named, and it is the same capability the other route forks to obtain. Adopting it *before* it leaves preview is a different and worse option, because that forfeits the support guarantees the [restorable window](#how-long-a-paused-snapshot-stays-restorable) depends on. |
| Carry patches that hand guest memory out of the VMM process | A fork maintained against every upstream release for the lifetime of the capability. `template-builder` already declines exactly this for the block drain, and states that carrying a VMM patch is not contemplated for v1. |

Those two positions cannot both hold: a design that requires a fork cannot sit beside a document
that rules one out. This is where that contradiction is resolved, and the resolution is that the
first release takes neither route **for memory**. Nothing here reaches the root filesystem, which
is why it is not held back with it.

**The trigger for revisiting is two numbers, not a preference.** Measured pause cost on real
hardware at the memory sizes tenants actually run, and the economics of idle sandboxes once the
first release carries load. If pauses are cheap enough, the capability is a refinement. If idle
sandboxes turn out to be a material cost and full pauses are what make reclaiming them expensive,
that is the argument for spending a fork — and it will be an argument with measurements behind it
rather than an assertion about what diffs buy. Root filesystem layering shipping first improves
that argument rather than weakening it: the machinery it exercises is the same, so by the time
the question is asked the source map, the composition, and the flatten will all have been in
production for a release.

Nothing below is deferred work, and for the disk none of it is even future work.

### The source map is the source of truth

Every file stored as a diff carries a **source map**: an ordered list of runs, each naming where
a range of blocks comes from, over a table of the artifacts those runs refer to.

| Field | Meaning |
|---|---|
| `block_start` | First block of the run, in the file's block space. |
| `block_length` | Number of blocks in the run. |
| `source_index` | Index into the map's `sources` table, or the reserved zero sentinel. |
| `source_block_offset` | The block within that source at which the run's bytes begin. |

`sources` is a table of artifact identifiers. **A null source means zero**: one reserved index
names no artifact, and a run pointing at it asserts that its blocks are zero and that no source
is to be consulted. The map tiles its file exactly — no gaps, no overlaps, ending at the file's
size — so there is no undeclared block for a reader to form an opinion about.

**The zero sentinel is mandatory, not an optimisation.** A page the guest discarded — freed,
ballooned away, advised out — is not "changed" in the sense a dirty tracker means, so an encoding
without it leaves the range covered by whatever the parent said and the restore serves the
parent's old content for a page the guest had thrown away. That is stale data resurrecting inside
a guest that was entitled to zeroes, with no error at any layer and no way to detect it after the
fact. It is a distinct answer, not a special case of inheritance.

**Offsets are in file-offset space, not guest-physical.** The memory file is the guest's memory
regions concatenated in order, and above roughly 3 GiB of guest RAM there is more than one region
because the range reserved for memory-mapped I/O below 4 GiB is skipped. The two spaces agree
below that point and diverge above it, which is the worst possible shape for a bug: a map built
in the wrong space is correct on every small template and silently misassembles every large one.
The space is recorded in the map's own header so that a reader never has to infer it, and it is
the same choice the `prefetch` ranges make, for the same reason.

Three properties follow from this shape, and each one replaces machinery that a
three-states-relative-to-one-parent encoding needed in order to work at all:

- **The read is a single lookup, at any depth.** A run names its object and its offset outright,
  so resolving a fault is a search over sorted runs and then a read. There is no state to resolve
  against a parent that might defer to a parent of its own, which is what a relative encoding
  forces and what the depth cap existed to prevent.
- **Merging is a metadata operation that cannot fail.** Composing two maps reads the previous
  *map*, never the previous blob, so there is no eviction that can break it. This is developed
  [below](#chain-depth-is-a-writer-policy-not-a-format-constraint).
- **Diff compaction comes for free.** Because a run carries its own offset into its source, a
  diff blob does not have to sit at full memory length with its unchanged regions as holes. The
  runs can be packed contiguously and the map says where each landed.
  [artifact-store](../components/artifact-store.md) currently defers compaction pending a
  measurement of whether diff blobs dominate storage; the measurement is not needed, because the
  cost it was weighing — a second offset space that every range calculation would have to get
  right — is one integer column in a structure the reader already consults on every access.

### The map is a sidecar object, not a manifest field

Each file's map is a **separate binary object under the artifact prefix**, named and digested
from the manifest rather than embedded in it.

The reason is that it is the one part of an artifact's metadata that grows with the image. A
2 GiB image at 4 KiB blocks is 524,288 blocks, and a genuinely fragmented dirty set is tens of
thousands of runs, not the handful an illustrative example shows. Inline as JSON, that is a
multi-megabyte document parsed and tile-validated on the sandbox-start path — and
[artifact-store](../components/artifact-store.md)'s rule that unknown top-level keys are rejected
outright is written for a small document that can be read strictly and cheaply. Putting the
structure that scales inside the document that must stay cheap gets both of them wrong. Split
apart, the manifest stays small and human-readable, and strictness costs nothing.

The sidecar carries **its own format byte and its own version ladder**, independent of the
manifest's `format` integer, because the two change on different clocks: the manifest's shape
changes when the platform gains a concept, the map's when its encoding needs to get smaller.
Coupling them would mean a manifest version bump, and a coordinated roll across three workloads,
for every encoding change.

That the encoding will need to get smaller is not speculative. A reference implementation
carrying the same structure has already moved to a columnar varint encoding with a per-map table
so an artifact identifier is stored once rather than once per run, and keeps a packed in-memory
representation besides — because on snapshot-heavy nodes the merged maps, not the page data, are
what dominate host RAM. None of that is needed on day one. The version ladder is what makes
arriving at it a routine change rather than a format migration.

### Sparse-file semantics do not survive object storage

The hypervisor's native diff is a sparse file at **full memory length** in which a hole means
"unchanged". That representation is fine on a local filesystem and is destroyed by storage: a
hole becomes a zero byte on upload, so a stored diff is byte-indistinguishable from a full image
of a mostly-zeroed guest. Nothing about the object says which of the two it is.

The upstream tooling makes the dependency concrete rather than theoretical. Merging a native diff
onto a base is documented as copying the diff's content over the base, performed by
`snapshot-editor edit-memory rebase`
(`references/firecracker-docs/snapshotting/snapshot-support.md:220-229`,
`references/firecracker-docs/snapshotting/snapshot-editor.md:15-43`) — which is to say the only
supported consumer of a native diff is an operation whose correctness rests entirely on which
bytes are holes. There is no reading of that tool that survives a round trip through object
storage, and none of it is our doing: the format is right for the local filesystem it was designed
against. Layering onto that toolchain also carries an ordering rule with no analogue in our
format, since the device-state file has to be the one produced by the same call as the last memory
layer merged (`references/firecracker-docs/snapshotting/snapshot-support.md:237-240`).

Hence the rule, which is absolute: **the source map is the source of truth, and a diff is never
interpreted by inspecting the file's allocated extents.** No reader calls `SEEK_HOLE`, consults
`st_blocks`, or infers anything from what the filesystem has allocated. Those answers are
correct on the node that produced the diff and meaningless one round trip later, which makes
this exactly the kind of mistake that passes every local test.

### Chain depth is a writer policy, not a format constraint

The hypervisor resets its dirty bitmap at **every snapshot create and every load**
(`references/firecracker-docs/snapshotting/snapshot-support.md:283-285`,
`references/firecracker-docs/snapshotting/snapshot-support.md:467-469`). A second
pause of the same sandbox therefore produces a dirty set relative to the *first pause*, not to
the base, and publishing that as a child of the base would silently omit everything that changed
in between.

Under an encoding that describes blocks relative to exactly one parent, this forces a merge on
the write side: fetch the previous diff, pin it, and rewrite its bytes into the new one so that
the published artifact is always base plus exactly one diff and the read path never walks a
chain. That machinery is gone, because the source map makes it unnecessary rather than cheaper.

Composing two maps is a merge over two sorted lists. Runs the new pause did not touch keep
pointing wherever the previous map pointed them — at the base, at the previous diff, or at the
zero sentinel — and runs it did touch point into the new blob. The result names both artifacts
in its `sources` table and still resolves in one lookup, because a run names its object and its
offset directly rather than deferring to a parent that might defer again.

Two consequences, and the second is why this is a better shape rather than merely a tidier one:

- **No bytes move, so the merge cannot fail.** The composition reads the previous *map* — a
  sidecar measured in kilobytes — and never the previous blob. There is no merge input to hold
  locally, nothing to pin, and **no way for a pause to be broken by an eviction**. The
  full-snapshot fallback that the old mechanism needed, the manifest field that recorded why it
  fired, the metric that counted it, and the pin class that existed to avoid it all go with it.
- **Depth stops being a format concern.** No reader walks a chain at any depth, so the format
  states no limit. The writer still bounds how many distinct sources it will name, because each
  one is a collection reference and an object a flatten has to fetch, but that is a policy in the
  pause path — changeable without touching a single stored artifact — and a reader that meets a
  deeper map handles it correctly rather than rejecting it.

### Restoring a layered file flattens it

A restore **flattens each layered file into a local image** before the VM uses it,
assembling each run from the source its map names or from zeroes. There is no chain to walk,
because the map resolved it when it was written.

Three consequences, and all of them need stating rather than discovering:

**When the flatten has to finish differs by file.** A layered memory file may be assembled in the
background, because userfaultfd serves the guest through the map meanwhile; a layered disk may
not, because the hypervisor opens it as an ordinary file and no lazy path exists for a block
device. The disk's flatten is therefore on the create path and the create waits for it. Since the
first release layers the disk and not memory, the blocking case is the one that actually runs.

**The flattened file has no stored object and therefore no manifest digest.** It is a local
construction, and no digest in any manifest describes it. The warm-path gate cannot key on the
manifest digest for these files, so it keys instead on a **locally computed digest recorded in
the node cache index**, written when the flattening completes. The gate's property is unchanged
— the file backend is used only for a file whose contents have been verified against a digest
computed over them — but the digest's provenance is local rather than published, and the cache
index becomes the authority for that class of file.

**A flattened image is private to its restore, so page sharing does not apply to it.** Two
sandboxes restored from the same layered memory file do not share physical pages the way two
sandboxes from one template do, because each has its own assembled file. This is an acceptable
loss rather than a regrettable one: the sharing argument was always about **templates**, which
back many sandboxes at once, whereas a paused sandbox has essentially one consumer — the resume
of that sandbox. Paying for privacy on a one-consumer artifact costs nothing that was ever being
collected. It does mean the property that "the cache file and the memory file are one file"
holds for a memory file **stored whole**, and the sections above are written with that
qualification. A layered disk gives up nothing here, because a writable root filesystem was
always private to its sandbox.

### Dirty tracking for memory has three sources

This section is about the memory file. The disk does not appear in it because the disk has no
dirty source at all and does not need one — its diff is the comparison pass on its own, as the
[section above](#the-root-filesystem-layers-on-a-stock-hypervisor) sets out.

Identifying what changed in memory has three possible sources, and the premise that used to
choose between them is false. The hypervisor does **not** require its dirty-page log in order to
produce a diff: with logging off it falls back to `mincore` to decide which pages to include,
which upstream documents as producing larger memory files while avoiding the runtime cost of
dirty-page logging, and as working **only where swap is disabled**, since a page written to swap
is not in core (`references/firecracker-docs/snapshotting/snapshot-support.md:317-328`). Swap
disabled is a precondition [overview](overview.md) already imposes on sandbox nodes, for the
stronger reason that guest memory paged to host disk is tenant data left somewhere we did not
intend. So "tracking cannot be enabled retroactively, therefore it must be on for every sandbox in
the fleet" was never the choice on offer — and the fallback is the VMM's own documented behaviour
rather than something inferred.

| Source | Available on | What it costs |
|---|---|---|
| The hypervisor's dirty log | Either backend, if enabled at every restore | KVM establishes the guest's page tables at 4 KiB entries and write-protects them, and each sandbox pays the resulting TLB pressure for its entire life (`references/firecracker-docs/hugepages.md:71-74`). It cannot be enabled retroactively, because it is a parameter of the restore call that a pause does not carry forward (`references/firecracker-docs/snapshotting/snapshot-support.md:486-489`), so the tax falls on every sandbox in order to make a minority of pauses cheaper. |
| Page residency | Either backend, requires swap disabled | Nothing at runtime. Over-reports: residency flags every page the guest merely read, so the result is the working set rather than the write set. |
| Asynchronous write protection in the fault handler | userfaultfd only | Derives the set from faults on write-protected pages rather than from a continuously maintained bitmap, so the cost lands on workloads that actually write. This is not an open question — a reference implementation runs it, in the fault handler rather than in the VMM. |

**The default is residency, narrowed by a comparison pass against the parent's bytes.** The
comparison is not a price residency pays; it is required whatever the source, because no dirty
set is narrowed by whether the new content actually *differs* from the old. The hypervisor's log
is the union of the KVM bitmap with the VMM's own record of pages it wrote, and neither half
checks. A minimal diff therefore needs the comparison in every design, its input is already local
because the flatten needs the same bytes, and once it runs, an over-reporting residency set
narrowed by it produces the same output as a dirty log narrowed by it. The log's only real
contribution is a smaller set of blocks to compare, bought with a fleet-wide cost paid by every
sandbox whether or not it is ever paused.

Handler-side write protection is what to reach for if the comparison pass becomes the bottleneck,
and the constraint from the [backend table](#the-backend-choice-decides-whether-a-memory-pause-can-be-incremental)
applies to it unchanged: it exists only on the userfaultfd path, which is the only path that may
pause incrementally in any case.

## The root filesystem is probably the wrong kind of device

This is a finding rather than a change, and it is recorded because it is the largest unexamined
assumption in this document and because the argument for it is the argument this document already
makes for guest memory.

Everything above treats the root filesystem as a block device: the hypervisor opens it as an
ordinary file, there is no lazy-fetch path for it, a layered disk must be flattened before the VM
starts, and each sandbox gets its own private copy. That last property is stated twice as an
acceptable cost, on the grounds that a writable root filesystem was always per-sandbox. It is
worth noticing what it costs anyway. Fifty sandboxes from one template on one node share nearly
all of their *memory* through the page cache and share none of their *root filesystem*, even
though the overwhelming majority of that filesystem is the template's immutable bytes and
identical in all fifty. The sharing argument that justifies the whole warm path stops at the
memory file for no reason other than the device type.

`virtio-pmem` is the device that does not stop there. It is backed by a memory-mapped file on the
host and exposed to the guest as a region of guest physical memory, so the guest reaches host
pages with ordinary loads rather than through a driver round trip, and it presents as an ordinary
block device that can be booted from
(`references/firecracker-docs/pmem.md:11-20`). Two properties follow that bear directly on this
subsystem. **Backing files shared between VMs amortise**: upstream's worked example is two 128 MiB
VMs with a shared 100 MiB device costing 356 MiB rather than 456 MiB, because the shared region is
counted once (`references/firecracker-docs/pmem.md:296-305`). And under DAX the guest does not
duplicate the device's contents into its own page cache, which upstream measures as a 128 MiB VM
booting at roughly 96 MiB resident rather than 120 MiB — about what the same VM costs on
`virtio-block`, but now with the filesystem itself shared rather than private
(`references/firecracker-docs/pmem.md:22-34`, `references/firecracker-docs/pmem.md:288-295`).

The shape that fits is a read-only pmem device holding the template's root filesystem as the lower
layer of an overlay, with the writable upper layer staying per-sandbox exactly as it is now. That
arrangement is not a compromise to make the device usable; it happens to neutralise both of the
device's sharp edges. Writes to a read-only pmem device are discarded with a warning on x86_64 and
stop the VM outright on aarch64 (`references/firecracker-docs/pmem.md:86-104`), which is
disqualifying for a writable root and irrelevant for a lower layer nothing writes to. And the
region must be 2 MiB aligned, with the VMM filling any gap past the end of the backing file with
anonymous pages that are never written back — a silent data-loss trap that upstream notes does not
arise in read-only mode (`references/firecracker-docs/pmem.md:106-115`).

What it would cost is real and is why this is not a change today. The guest kernel needs a
substantial set of configuration options it does not currently carry
(`references/firecracker-docs/pmem.md:36-65`). The memory accounting model moves, because the
device's contents sit on top of guest RAM in the worst case rather than inside it
(`references/firecracker-docs/pmem.md:287-291`) — the shared part amortises across the node, but
`vm-host`'s resource requests are computed per sandbox and would have to learn the difference, on
nodes where [overview](overview.md) has already established that memory pressure is fatal. A
mapped backing file inherits every rule this document imposes on the memory file, including the
prohibition on truncating or hole-punching it while mapped and the hazard that a full-length
sparse file reads zeros, and it inherits them **without** the userfaultfd escape, since there is no
lazy path here either. Backing files must be present at the same paths at restore, like every
other external resource (`references/firecracker-docs/pmem.md:254-261`). And a hostile guest gets
a new lever: a flush request causes `msync` over the whole mapped region, so flushes must be rate
limited, which the device supports natively (`references/firecracker-docs/pmem.md:160-182`).

**The security objection is the interesting one, because we have already accepted it.** Upstream
advises against pointing several VMs at one backing file, since it maps the same physical pages
into different VMs and could be exploited as a side channel
(`references/firecracker-docs/pmem.md:152-158`). That is a description of the warm memory path.
Every sandbox restored from one template on one node already maps the same physical pages, and
this document treats that as the central benefit rather than as a risk; the mitigations are the
ones [security](security.md) already relies on, with simultaneous multithreading disabled at the
top of the list. So the objection is not a new exposure but the same accepted one on a second
surface — which is a materially different thing from a blocker, and which is
[security](security.md)'s judgement to make rather than this document's.

None of this is v1 work. It changes the boot path, the guest kernel, the template format, and the
memory accounting model together, and root filesystem layering already captures the storage and
transfer half of the benefit. But the resident-memory half is not captured by anything we have
planned, it grows with sandbox density on a node, and density is the metric the whole architecture
is built to serve. When the root filesystem's representation is next opened, this is the candidate
to beat.

## Cold nodes

Autoscaling makes empty caches routine rather than exceptional, so the cold path is a
first-class concern rather than an edge case.

- **Placement prefers nodes that already hold the artifact.** This is the cheapest mitigation
  by a wide margin and it makes the warm path dominate in steady state.
- **New nodes pre-warm.** An init container fetches the currently popular templates before
  `vm-host` reports ready. The fetch has a deadline and failure is not fatal: a node with a
  partial cache is far better than a node stuck in a restart loop.
- **Readiness is graded, not binary.** `vm-host` reports which artifacts it holds, and placement
  treats warmth as a weight. A cold node still accepts work when nothing warm has capacity —
  slow beats refused.
- **Background warming continues** as the popular set drifts, rate-limited so it never competes
  with a live restore.

Peer-to-peer transfer between nodes is deliberately deferred. Warmth-aware placement captures
most of the benefit, and the remaining case — resuming a snapshot whose upload has not finished
— is narrow enough to wait for evidence that it hurts.

## Guarantees

| Property | Mechanism |
|---|---|
| No partially readable artifact is ever visible | Manifest written last |
| A cached artifact is never stale | Artifacts are immutable |
| A live sandbox's backing file is never removed | Pin set consulted on eviction; a mapped file is never truncated or hole-punched |
| A restore never silently reads zeros | File backend used only for a complete, digest-verified file; file length never encodes progress |
| A crash never leaves a sandbox frozen or paused | Pause runs in a non-cancellable task with bounded steps, thaw on every abort path, and a guest-side auto-thaw deadline behind both |
| A snapshot is never restored onto an incompatible host | The `runtime` block recorded in the manifest and applied by placement, because the VMM only warns on a CPU mismatch and restores anyway; the VMM version selects a binary on the node rather than filtering nodes |
| A restore never reopens the wrong tap, disk, or socket | Nothing a restore reopens is named after node-local state, because the device-state file links all three by name and path |
| A paused sandbox never restores on an unsupported VMM | Restorable age is bounded by the support window of the build its snapshot format requires; past it the sandbox is refreshed by a pause on a current build, or expired |
| Tenant code never runs between restore and the post-restore hook | The tenant-cgroup freeze is captured into the artifact and released only by the hook, which the VMM's own restore-time notifications do not weaken because nothing tenant-side is running to receive them |
| A checkpoint never thaws before its thaw arrives | The auto-thaw deadline is floored above resume-plus-reconnect time, because creating the snapshot resets vsock and the thaw travels on a connection established afterwards |
| A blocked fault is never a silent hang | Handler liveness is monitored directly; the handler also signals the VMM on its own exit, using the peer credentials of the handshake socket; a fault whose fetch exhausts its retry budget kills the sandbox, a deferred fault is requeued and re-signalled by the handler itself, and a panic in the fault path is fatal rather than a zero return |
| A failed restore never leaks a waiting handler | The handler bounds both waits on the VMM — for the connection and for the memory layout — since the handshake is the only communication it will ever receive |
| A fault is never left unwoken | Every install outcome has a defined disposition, and "already present" wakes the faulting thread rather than returning early |
| A slow object-store read never stalls the whole VMM | The event-read path holds a lock disjoint from the workers, so a blocked worker cannot delay the removal event a discard is waiting on |
| A collected artifact is never paged from | Manifest deleted first, blobs only after a grace period exceeding the maximum sandbox lifetime |
| A discarded page never resurrects its parent's content | The source map's zero sentinel is a distinct answer from any real source; for memory, incremental pause is restricted to the userfaultfd backend, which is the only one that registers a descriptor a removal event could arrive on, and for the disk the discarded blocks are read back rather than inferred |
| Reclaim never depends on a feature outside the support policy | The balloon contributes through free page reporting, which is a supported feature and runs continuously, rather than through host-triggered hinting, which is a developer preview with a documented memory-corruption race whose only safe use requires userfaultfd |
| A layered root filesystem never depends on the hypervisor | Its diff is a comparison of two local files after the VM has stopped, which is why it ships in the first release and memory diffs do not |
| A diff is never misread as a full image | The source map is the source of truth; no reader consults the file's hole structure |
| A restore never walks a chain | A run names its source object and offset directly, so any map resolves in one lookup |
| A merge is never broken by an eviction | Composing two maps reads maps, never blobs |
| A source is never collected while something references it | Membership checked against the source maps that name it |
| A flattened image is never mapped unverified | The warm-path gate keys on a locally computed digest in the cache index, since no manifest describes that file |

## Open measurements

These need real hardware and are not answerable from design:

1. **Sharing ratio.** Restore N sandboxes from one template and confirm host memory grows by
   what each sandbox writes rather than by full guest memory. Stated in terms of writes rather
   than of the "dirty set", which this document uses for whatever the chosen source reports.
2. **Cgroup accounting of shared page cache.** Page cache is charged to whichever cgroup faults
   it first, so one sandbox may be billed for pages its neighbours read, and may reclaim them
   under pressure. The likely mitigation is pre-faulting from a node-level cgroup; it needs
   confirming.
3. **Cold-path p99.** Real fetch-and-restore latency against our object store, which sets the
   pre-warm budget. The tail matters more than the median, because autoscaling makes cold
   nodes correlate with demand spikes.
4. **Memory pause cost, which is what gates incremental memory snapshots.** The first release
   writes memory in full, and the decision to revisit that turns on measured numbers rather than
   on argument: full-pause duration against configured guest RAM at the sizes tenants actually
   run, how much of it the reclaim pass and the background filler already remove, and what idle
   sandboxes cost when their memory can only be reclaimed by a full write. Those figures are what
   would justify spending a VMM fork, and nothing else should.
5. **What the disk comparison pass costs at pause and at seal.** Layering the root filesystem
   trades a full read of the image for a much smaller upload, and the read is the part that has
   not been measured. It matters most in the builder, where a long recipe seals repeatedly and
   the reads multiply by step count, and it is the number that decides whether write tracking
   under the disk is worth asking for or whether the comparison is simply cheap enough.
6. **The source map's size in practice.** Disk layering exercises this from the first release, so
   the run counts a real fragmented dirty set produces stop being an estimate sooner than
   expected. The number decides when the sidecar's encoding has to move from the simple one to a
   columnar coded one, and how much host RAM composed maps occupy on a snapshot-heavy node —
   which is the resource a reference implementation found dominant, and the reason the sidecar
   has a version ladder of its own.
7. **Resume-plus-reconnect time, which floors the auto-thaw deadline.** The vsock reset makes this
   a correctness number rather than a latency one: set the deadline below it and a healthy
   checkpoint releases tenant code during the window the pause sequence exists to protect. It
   wants measuring at the tail and under node load, not at the median.
8. **Whether the reclaim pass is worth its place now that it is three steps rather than four.**
   Free page reporting runs continuously, so the question is what `sync`, trim, and drop-caches
   still remove at pause time on top of it, against the deadline they are allowed to consume.
   If the answer is little, the pass simplifies further.
9. **Resident memory per sandbox at density, with and without a shared root filesystem.** This is
   the number that decides whether the [pmem question](#the-root-filesystem-is-probably-the-wrong-kind-of-device)
   is worth reopening. It is measurable today without building anything: restore N sandboxes from
   one template and attribute host memory between guest RAM, the shared memory file, and each
   sandbox's private copy of a root filesystem that is identical in all N.
