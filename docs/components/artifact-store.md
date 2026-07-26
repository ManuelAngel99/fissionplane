---
type: Component
title: artifact-store
description: The library that owns the artifact manifest format and the source map sidecar, the object layout, chunked ranged reads into a local sparse file, the only integrity check any artifact byte receives, and the node cache with its eviction and pinning policy.
tags: [component, storage, artifacts, cache, s3]
timestamp: 2026-07-27T07:33:00Z
---

# artifact-store

`artifact-store` is a **library plus an object storage bucket**, not a service. It is linked
into [vm-host](vm-host.md), [template-builder](template-builder.md), and
[control-plane](control-plane.md), and it is the only code in the system permitted to read or
write artifact bytes.

The format it enforces, the three storage tiers it moves bytes between, and the two restore
paths it feeds are specified in [snapshots](../architecture/snapshots.md). This document
describes the implementation.

## Purpose

Give every component one correct way to name, publish, fetch, cache, pin, and delete
artifacts, so that the invariants which make the snapshot subsystem safe are implemented once
rather than three times.

Being a library rather than a service is a deliberate choice with a clear rationale. Artifact
reads sit directly on the sandbox-start critical path and, in the cold case, inside the
userfaultfd fault loop — a page fault in a running guest waits on them. Inserting a local
service between `vm-host` and the bytes it needs would add a hop, a serialisation boundary, a
process to supervise, and a new failure mode to the most latency-sensitive path in the
product, in exchange for nothing: object storage is already the service, and the node cache is
already node-local state that exactly one process owns.

The second reason is enforcement. "The manifest is written last" and "unknown format versions
are rejected" are only invariants if there is one implementation of them. A shared library
plus the rule that no other code touches artifact bytes makes both checkable by reading one
crate.

The cost, stated honestly: a library ships by redeploying its consumers, so a format change
must be rolled out across three workloads and they will run mixed versions during the roll.
That is precisely why the format is versioned by an integer that readers check and refuse
rather than interpret optimistically.

## Responsibilities

| Responsibility | Notes |
|---|---|
| Define, parse, and validate the manifest | Including refusal of unknown format versions. |
| Define, encode, and validate the source map | The sidecar object, on its own version ladder, separate from the manifest's. |
| Own the object layout | Everything under `artifacts/<artifact-id>/`. |
| Implement publication | Blobs first, manifest last, idempotent on retry. |
| Serve reads | Whole-artifact fetches and byte ranges, via the chunked reader. |
| Own the local cache | Presence records, watermark eviction, the pin set, startup reconciliation. |
| Verify integrity | Checksums verified when materialising. |
| Support collection | The mechanics of identifying and removing orphans and deleted artifacts. |
| Abstract the backend | Any S3-compatible endpoint, behind a deliberately small surface. |

## Explicit non-responsibilities

- **Deciding what to cache.** Warmth-aware placement is `control-plane`'s job. The store
  caches what it is asked to fetch and evicts by policy; it never prefetches on its own
  initiative.
- **Deciding what to delete.** `control-plane` records lifecycle state in PostgreSQL. The
  store provides the mechanism; the policy lives with whoever owns the rows.
- **Authorization.** By the time the store is asked for an artifact, `control-plane` has
  already decided the caller may have it. The store does not know what a tenant is.
- **The fault loop.** `vm-host` owns the userfaultfd handler, the fault-fill sizing, and the
  choice of memory backend. The store owns the bytes underneath, which includes resolving a
  layered file's source map: the handler asks for an offset and receives bytes, and which
  source they came from, or that they are zeroes, is on this side of the boundary.
- **Producing artifacts.** The builder and the pause path produce; the store publishes.
- **Metadata as a service.** There is no artifact metadata service. Object storage is the
  registry and PostgreSQL holds ownership and aliases.

## Public surface

Small on purpose. Every operation below carries a guarantee that callers are entitled to rely
on, and the guarantees are the interesting part.

| Operation | Guarantee |
|---|---|
| `fetch(artifact_id)` | Returns only when every file of the artifact is present locally and its whole-file digest has been verified. For an artifact that declares a content dependency, this includes its source map and every artifact that map names, each fetched and verified on the same terms. Concurrent fetches of the same artifact are single-flighted: fifty sandboxes starting from one cold template cause one download, not fifty. |
| `flatten(artifact_id, file) -> path` | For a file stored as a diff, assembles a local image from the sources its map names and from zeroes, computes a digest over the result, and records it in the cache index. Pins every source for the duration. Per file, not per artifact, because an artifact's disk may be layered while its memory is not. What it returns is node-local state: no stored object, no manifest, and no life beyond the sandbox that asked for it. |
| `fetch_range(artifact_id, file, range)` | Returns the artifact's bytes for that range or an error. Never returns zeros for absent bytes. A range hitting present bytes is served from the local mapping; a miss fetches the containing chunks first. |
| `publish(staged)` | Atomic. On success the artifact is visible in full; on any failure it is not visible at all. Republishing an existing artifact ID is a success, not a conflict. |
| `pin(artifact_id) -> Pin` / `drop(pin)` | While a pin is held, no file of that artifact can be evicted. Pins are derived from durable node state, so a process restart cannot release a pin belonging to a live sandbox. |
| `evict(target_bytes)` | Removes only complete, unpinned artifacts with no fetch in flight, least-recently-used by access time. Never removes a file that is being written or mapped, and never truncates or hole-punches one. The pin is re-checked at deletion, not only at selection. Progress is measured against bytes scheduled for deletion, since `unlink` frees no blocks while a mapping is live. |
| `collect()` | Removes prefixes that have no manifest, no live publisher lease, and no in-progress multipart upload, and that have been untouched for longer than the grace period; and artifacts marked deleted, no longer referenced by an alias or a paused sandbox, and named as a source by no other artifact's source map. For a deletion, the manifest goes first and the blobs only after a second grace period exceeding the maximum sandbox lifetime. Never removes a prefix that is being written to now, and never one that a sandbox may still be paging from. |

Eviction operates on **whole artifacts**, not individual files. Evicting `vmstate` while
retaining a two-gigabyte `memory` file would free forty kilobytes and leave the remainder
unusable — cache space occupied by something that can no longer serve a restore.

## Manifest handling

The manifest is defined in [snapshots](../architecture/snapshots.md) and is not restated here.
The implementation applies four rules.

**Parse into a typed structure, never a loose map.** Once parsed, the rest of the system works
with a value whose invariants have already been checked, so no downstream code has to ask
whether a field is present.

**Validate beyond well-formedness.** The checks are cheap and each one corresponds to a way an
artifact could be unusable at restore time rather than at parse time:

| Check | What it prevents |
|---|---|
| `format` equals a known version | Interpreting bytes under the wrong rules. |
| Files required by `kind` are present, and files forbidden by it are absent | A `template` or `snapshot` without memory or device state; an `fs-layer` claiming to have them. |
| Sizes non-negative, consistent with `chunk_size` | Chunk arithmetic that silently reads past the end. |
| Digests well-formed and of the expected length | A truncated digest that appears to verify. |
| `runtime` present and complete in every field | A restore attempted on a host that cannot serve it. |
| `parent_id` null for templates | A template that cannot stand on its own. |
| A `source_map` reference appears only on a file stored as a diff, and names an object under this artifact's own prefix | A diff with nothing to resolve against, which restores as a mostly-zero guest rather than as an error; or a manifest pointing at another artifact's map. |
| Every file stored as a diff carries a `source_map` reference with a well-formed digest | A diff whose map is unnamed, which is a file nothing can interpret. |

The `runtime` check is a completeness check rather than a compatibility check, and the
distinction is the point. Deciding whether *this* node can restore *this* artifact is
placement's job and happens against the live node; the store's job is to refuse to publish or
accept a manifest that does not carry enough information for that decision to be made at all.
Every field of the block described in [snapshots](../architecture/snapshots.md) is required —
host CPU architecture and identity or template, **host microcode revision**, host kernel version,
VMM version, snapshot format version, guest kernel identity, boot args, the device model set, and
the sealed agent's build identifier and capability set. The microcode revision is required on the
same terms as the rest and is the one most likely to be argued about, since an artifact that omits
it parses cleanly, restores cleanly, and is indistinguishable from a complete one until a host
somewhere has been patched. A missing field is rejected rather than defaulted, because a
default here is an assertion about hardware the writer never made, and the failure it produces is
a guest faulting on an instruction long after the restore succeeded. The agent's build identifier
is required on the same terms even though nothing filters on it: it is the key the capability
quarantine list is consulted by, and an artifact that omits it is one whose advertised
capabilities can never be corrected. `vmm_version` and `snapshot_format` carry a second
obligation of the same shape: they are what a paused snapshot's
[restorable age](../architecture/snapshots.md#how-long-a-paused-snapshot-stays-restorable) is
evaluated against, so an artifact missing either cannot be aged out on any principled basis. The
policy is `control-plane`'s; making it expressible is this component's.

**Reject unknown format versions rather than parsing best-effort.** The `format` integer gates
the entire document, and unknown top-level keys within a known format are also refused. This
strictness is uncomfortable and correct: a reader that skips what it does not understand
cannot distinguish a field it may safely ignore from a field that changes the meaning of the
bytes it is about to map into a guest. New information is added by defining an optional field
in the current format or by bumping the version — both of which are explicit acts that show up
in review. The strictness is affordable because the manifest is small and stays small: the one
structure that grows with the image is the source map, and it lives outside the document under a
version ladder of its own.

**Verify checksums when materialising.** A whole-file `blake3` is computed as the file
completes and compared against the manifest. This verification is also the gate for the warm
path: a file is only eligible for the hypervisor's file backend once its digest has been
confirmed, which closes the failure mode where a full-length but partially populated sparse file
is mapped and silently reads zeros. The one class of file the manifest cannot speak for is a
flattened file stored as a diff, which is gated on a locally computed digest instead; that case
is developed under [flattening](#flattening-a-file-stored-as-a-diff) below.

**Nothing downstream repeats this check, and that is by design rather than by omission.** The
hypervisor's threat model trusts snapshot files outright and makes securing them across a trust
boundary — provisioning them to a host from a repository over a network, which is precisely this
component's job — the integrator's responsibility
(`references/firecracker-docs/snapshotting/snapshot-support.md:90-98`). What it does verify is one
CRC64 embedded in the device-state file, checked before the load and fatal to the process if it
fails, and upstream describes even that as a partial measure against accidental corruption while
naming the memory file and the disk as files the integrator still has to secure
(`references/firecracker-docs/snapshotting/snapshot-support.md:100-107`). So for the two largest
files in an artifact, and the two whose contents become guest memory and a guest root filesystem,
**the digests in this component are the only integrity check that happens anywhere.** That is
worth knowing before reading the limitation below, because it decides how the limitation should be
weighed.

One limitation is worth recording rather than hiding. The manifest carries a whole-file digest
and a chunk size, but no per-chunk digests, so an individual ranged read cannot be verified
incrementally against anything. In the interim, chunks are protected by transport integrity,
by the backend's own checksums on the ranged GET, and by the fact that published objects are
immutable and therefore cannot drift after the digest was computed. The natural fix — a chunk
digest vector in a future format version — is exactly the kind of change the version integer
exists to make safe.

**Cold-path bytes are therefore unverified by construction, and this should be said plainly.**
A whole-file digest cannot be checked until the whole file exists, and the entire point of the
cold path is that the guest starts consuming bytes long before that. Every page faulted in
during the fill is served to a running guest on the strength of transport integrity and object
immutability alone; the digest confirms afterwards what was already used. That is an acceptable
position — the alternative is waiting for a multi-gigabyte download before the sandbox starts,
which is the product — but it is a real gap and it is the concrete argument for per-chunk
digests when the format next moves.

**Verification is recorded durably and happens once per node per artifact.** When the digest is
confirmed, a marker is written next to the presence record and made durable. Without it, the
choice is between re-hashing gigabytes on every create — which puts a full sequential read of
the artifact on the critical path of a *warm* start, the path that is supposed to be fast — and
keeping the answer only in memory, where a `vm-host` restart discards it and every artifact on
the node becomes unverified again. The marker is written after the digest is confirmed and is
invalidated by anything that writes to the file, which under the immutability rule in
[snapshots](../architecture/snapshots.md) means only the fill and the replace-on-mismatch path.

## Source map handling

The map is a sidecar object rather than a manifest field, so it is a separate document with a
separate validation, under its own format byte and its own version ladder. The manifest-level
checks establish only that a map is named and digested; these establish that it can be used.

| Check | What it prevents |
|---|---|
| The format byte is a known version | Interpreting a run table under the wrong rules — the manifest's `format` argument, applied to the document that will actually change. |
| The digest matches the value the manifest recorded | A map paired with the wrong artifact, which misassembles rather than failing. |
| The map tiles its file exactly — no gaps, no overlaps, ending at `size` | A block whose source nobody declared, leaving the restore to guess. |
| Every `source_index` resolves to an entry in `sources` or to the reserved zero sentinel | A run pointing at nothing, which has no correct interpretation. |
| Every run's `source_block_offset` plus `block_length` lies within the source it names | Arithmetic that reads past the end of a source object, or silently short. |
| The space is file-offset | A map built in guest-physical space, which restores correctly on small images and misassembles large ones. |

**This validation is deliberately not folded into manifest parsing**, and that is the one place
the component departs from the pattern that a document validates itself on sight. Reading the map
means fetching a second object, so folding it in would put a network round trip inside the
cheapest operation in the component and make it fail from someone else's outage. It runs instead
at the two moments the map has to be read anyway: at publication, where the writer has just
produced it, and at restore, where the flatten and the fault path both consume it.

The tiling check earns its place for a reason worth naming. A map with a gap is not a map that
fails to load; it is a map that loads and leaves the restore to decide what an undeclared block
means. Whatever it decides — take it from somewhere, zero it, or refuse — is a guess about guest
memory, and two of the three answers are silently wrong. Requiring exact coverage means the
format has no undeclared state to have an opinion about.

The map is published as an ordinary blob under the artifact prefix, before the manifest, so
manifest-last covers it exactly as it covers the memory image: an artifact whose manifest is
readable has a readable map, and a crash between the two leaves an orphan the collector removes.

**Its version ladder moves independently of the manifest's, and will move sooner.** The manifest
changes when the platform gains a concept; the map changes when its encoding has to get smaller,
which [snapshots](../architecture/snapshots.md) records as a matter of when rather than whether.
Coupling the two would mean a manifest version bump — and a coordinated roll across three
workloads — for every encoding change, which is the specific cost the split was made to avoid.

## Publication is manifest-last

Publication is the mechanism that makes an artifact atomic.

1. Stage the artifact locally and compute every digest.
2. Upload each blob under `artifacts/<artifact-id>/`, multipart and in parallel for large
   files, verifying size and digest as each completes.
3. Upload `manifest.json` **last**.

The manifest is the commit marker. Nothing in the system considers an artifact to exist until
its manifest is readable, so there is no moment at which a partially uploaded artifact is
partially usable.

This imposes one rule on every reader, and it is easy to break by accident: **existence is
determined by reading the manifest key, never by listing the prefix.** A listing that shows
blobs proves only that an upload started. Listings are also eventually consistent on some
backends, which would make an inference from them wrong in both directions.

### The failure window and what the collector does

From the first blob upload until the manifest lands, the prefix exists and contains real bytes
while remaining invisible. A crash, a node loss, or a cancelled pause anywhere in that window
leaves **orphaned blobs**: objects that cost storage and nothing else. No reader can see them,
no restore can trip over them, and no reference counting is needed to reason about them,
because content is never shared between prefixes.

The collector deletes any prefix that has no manifest and whose newest object is older than
the grace period. Both conditions are required. Deleting on the absence of a manifest alone
would race a live upload — a multi-gigabyte memory image uploading over a constrained link
looks exactly like an abandoned one — and the collector would then delete blobs out from under
a publisher that is still writing, producing a manifest referencing objects that no longer
exist. Keying the second condition on the newest object's age makes the rule self-correcting:
an upload that is still progressing keeps refreshing its own protection, and one that has
genuinely stopped ages out.

### Manifest-last does not protect a multipart upload

The age rule has a hole, and it opens on exactly the case it was written for. **A multipart
upload creates no object under the prefix until it is completed.** Parts are held by the
backend against an upload ID, not as listable objects, so a single multi-gigabyte blob going up
over an hour contributes nothing to "newest object age" for that entire hour. The prefix looks
older and older while real work is in flight, and if the blob is the first or only file, the
prefix may contain no objects at all.

The failure that follows is the worst one available. The collector deletes the earlier blobs;
the multipart upload then completes and the manifest lands on top of a prefix that is missing
files. The result is not an invisible orphan — it is a **visible artifact, referenced by a
readable manifest, permanently broken**, and it fails at restore time on whichever node
unluckily draws it. Everything manifest-last is supposed to guarantee is defeated, because the
protection was keyed on a signal the upload does not emit.

Two fixes, and they compose:

- **A lease object under the prefix**, written by the publisher when the upload starts and
  refreshed on a period well inside the grace period. It restores the property the age rule
  assumed: a live upload keeps refreshing its own protection, whatever shape the underlying
  transfer takes. It needs only PUT, so it works on every backend and does not widen the
  required surface.
- **Consulting in-progress multipart uploads** for the prefix as a second condition. This is a
  direct answer rather than a proxy and it costs one listing per collection pass, but it leans
  on a part of the multipart API whose behaviour varies more across S3-compatible endpoints
  than the object operations do, which is why it is the cross-check and the lease is the
  mechanism.

The same listing earns its place for an unrelated reason: **abandoned multipart uploads bill
storage invisibly.** Their parts occupy space and appear in no object listing, so a crash rate
inside the publication window shows up as a bill rather than as an orphan count. The collector
aborts uploads older than the grace period and reports what it aborted.

Publication is idempotent. A retry that finds the manifest already present treats the artifact
as published, because artifacts are immutable and an existing manifest means an earlier attempt
committed.

## The chunked reader

The reader is the piece that lets a restore begin before the bytes have arrived. It is a
**local sparse file plus a record of which ranges are present**.

- **Hit.** A read whose bytes are all present is served directly from the mapping.
- **Miss.** The containing chunk or chunks are fetched with a ranged request, written into the
  sparse file, marked present, and then served.

Chunks are megabyte-scale, as declared in the manifest, so that request overhead is amortised
across a useful amount of data. Concurrent misses on the same chunk are coalesced into a
single request, which matters under the fault loop where many faults land in one chunk within
microseconds of each other.

**Ordering of the presence record is a correctness requirement.** The chunk is written and made
durable *before* its presence bit is set, never the reverse. A crash between the two costs a
re-fetch, which is bandwidth. A crash in the other order would leave a presence bit standing
over absent bytes, and the next read would serve zeros into a guest's memory — the exact
silent-corruption failure the two restore paths are designed to avoid. The record is kept
explicitly rather than inferred from the file's hole structure, because a chunk of legitimately
zero bytes and a hole are indistinguishable to the filesystem.

A low-priority, rate-limited background filler completes the file so that later restores can
take the warm path. Its requests are deprioritised behind fault-path fetches, because it must
never compete with a guest that is currently blocked.

**The local file is uncompressed, and the reason is that the hypervisor maps it directly.**
Once complete, the same file is handed to the VMM's file memory backend, so it must be a plain
image at plain offsets: a compressed file cannot be mapped, and a repacked one would need
converting before it could be.

Two things that would soften the cost of that do not work, and recording why is more useful
than repeating the conclusion.

**Compression cannot be a transport concern.** On S3-compatible endpoints, content encoding is
a property of the *stored object*, fixed when it is written, not something negotiated per
request the way an origin server negotiates it. There is no ranged GET that compresses on the
wire and hands back plain bytes at the offsets the caller asked for. Storing the object
compressed instead breaks the reader outright rather than costing it anything: an offset in the
compressed object's space has no fixed relationship to an offset in the image, so the
arithmetic that turns a guest page into a byte range stops meaning anything.

**Sparseness saves almost nothing once the bytes are stored.** It saves a great deal on a local
filesystem image, where large regions are genuinely unallocated, and that is where the intuition
comes from. It does not transfer to either kind of memory blob:

- A **full** snapshot writes every byte of every guest memory region, including pages the guest
  never touched, so there are no holes to elide in the first place.
- A **diff** is mostly holes as the hypervisor writes it — full memory length, with a hole
  meaning "unchanged" — and a hole becomes a zero byte on upload. Sparseness buys nothing on the
  way out; what shortens the object is compaction, below, which is a property of the map rather
  than of the filesystem.

The second case carries a correctness rule, not just a sizing one, and it is stated in
[snapshots](../architecture/snapshots.md) and enforced here: **the source map is the source of
truth about a diff, never the file's hole structure.** No code in this component calls
`SEEK_HOLE`, reads `st_blocks`, or infers a run's meaning from what the filesystem allocated.
Those answers are right on the node that produced the diff and meaningless one round trip later,
which makes the mistake invisible to every local test.

The temptation this rule guards against is concrete rather than hypothetical, which is why it is
worth an absolute prohibition rather than a preference. The hypervisor's own way of consuming a
diff is to copy its contents over a base, using the `snapshot-editor` tool shipped alongside it
(`references/firecracker-docs/snapshotting/snapshot-support.md:220-229`), and that operation is
correct only because it can distinguish a hole from a written zero. Anyone reaching for the
obvious tool is reaching for a hole-structure reader.

So the real choice is between two positions, and it is worth stating both rather than implying
there is a free one:

| Option | What it costs |
|---|---|
| Accept full size at rest and on every cold fetch | Storage and egress scale with guest RAM, not with what the guest used. A 2 GiB template is 2 GiB in the bucket and 2 GiB over the wire on every cold node. |
| A seekable frame-table format — compressed frames plus an index mapping image offsets to frames | Smaller objects and smaller cold fetches, at the price of **the cache file no longer being the stored object**, for every artifact rather than only for files stored as diffs. The cold path gains a decompression step, the whole-file digest describes the image rather than the object so publication and fetch stop being symmetric, and the file the VMM maps has to be produced by a conversion rather than by having arrived. |

**v1 takes the first.** The cost of the first option is bandwidth and storage, which are
elastic, measurable, and reducible by other means — warmth-aware placement removes most cold
fetches, and the pre-pause reclaim pass described in
[snapshots](../architecture/snapshots.md) attacks the size itself. The cost of the second is a
correctness surface: a second offset space, a conversion step on the cold path, and a digest
that no longer describes the bytes it was checked against. Bandwidth is the cheaper thing to
spend. This is a decision to revisit with measurements, not a permanent one, and the format
version integer is what keeps it revisitable.

**Diffs are the one place that choice does not apply, and they are compacted.** A diff's runs are
packed contiguously into a shorter object rather than left at full memory length, and each run's
`source_block_offset` records where it landed.

This was previously deferred pending a measurement of whether diff blobs dominate storage, and
the measurement is not needed, because the cost it was weighing does not exist. That cost was a
second offset space — the blob's offsets no longer being the image's, with every range
calculation in the reader obliged to get it right, the same class of hazard as the
guest-physical-versus-file-offset confusion the map's recorded space exists to prevent. But the
source map already carries that offset, as a column the reader consults on every access. There is
no second space to introduce and no new arithmetic to get wrong; there is one integer to read
from a structure that is already in hand. Deferring compaction would mean paying full length at
rest and on every cold fetch in order to avoid a field the format has anyway.

The elegant consequence, developed in [snapshots](../architecture/snapshots.md), is that for a
memory file **stored whole** the sparse cache file and the complete memory file are the same file.
The reader does not produce an intermediate format that later needs converting; it produces the
final image incrementally. Templates always store memory whole, so the property holds for every
artifact that backs more than one sandbox.

### Flattening a file stored as a diff

A file stored as a diff cannot be handed to the hypervisor as it stands. The store assembles it
run by run according to the source map, reading each run from the source it names at the offset
it gives, and writing nothing for runs pointing at the zero sentinel beyond leaving the
already-`ftruncate`d file's zeroes in place. Every source is pinned while it runs, and any of
them may itself still be filling, so flattening is a consumer of the chunked reader rather than a
separate path to the bytes.

**When it has to finish differs by file, and that is the one place the two are not symmetric.**
A layered memory file may be flattened in the background, because userfaultfd serves the guest
through the map in the meantime. A layered disk has no such escape: the hypervisor opens the root
filesystem as an ordinary file and there is no lazy path for a block device, so the disk's
flatten sits on the create path and the create waits for it. This is why `flatten` is per file —
the caller needs to block on one and not on the other — and why flatten concurrency is bounded
against fault-path reads rather than treated as background work.

The first release makes the disk the common case and the memory file the unused one, which is the
reverse of how this section reads if you assume both layer together.

Three properties of the result differ from every other file this component manages, and each one
breaks an assumption that holds everywhere else:

- **It corresponds to no stored object.** Nothing was uploaded and nothing will be. It is not an
  artifact, it has no manifest, and the collector has no opinion about it.
- **The path it is written to is part of the contract, not an implementation detail.** A restore
  reopens the block device at the path recorded in the captured device state, exactly as the
  original process opened it
  (`references/firecracker-docs/snapshotting/versioning.md:104-120`), so `flatten` returning "a
  path" understates the constraint: the caller needs a *particular* path, fixed relative to the
  jail root and identical on every node. This component chooses where inside the cache the
  assembly happens and `vm-host` chooses where it is presented, and neither may derive that name
  from a slot, a generation counter, or anything else that differs between the node that paused
  and the node that resumes.
- **No manifest digest describes it.** The manifest's digest for the file covers the *diff*, not
  the assembled image, so the warm-path gate cannot use it. The gate instead keys on a **digest
  computed locally over the flattened file and recorded in the cache index**, written when
  assembly completes. The guarantee is unchanged in substance — no file reaches the hypervisor's
  file backend without a digest computed over its actual contents — but the cache index, rather
  than the manifest, is the authority for this class of file, and it is durable for the same
  reason the verification marker is.
- **Its lifetime is the sandbox's.** It is materialised for a restore and removed with it,
  which is also why it does not participate in LRU eviction: there is nothing to reuse it for.

That last point is the honest cost, and it applies to the memory file. A flattened memory image
is private, so two sandboxes restored from one layered artifact share no physical pages, where
two sandboxes from one template share nearly all of them. This is acceptable because of what the
two kinds of artifact are for: a template backs many sandboxes at once and is exactly what the
sharing argument was about, whereas a paused sandbox has one consumer — its own resume. Privacy
costs nothing that was being collected. A flattened disk gives up nothing at all, because a
writable root filesystem was always per-sandbox.

## The cache

A directory on the node's dedicated NVMe filesystem, owned by exactly one process.

| Mechanism | Detail | Reason |
|---|---|---|
| Watermarks | Evict from a high mark down to a low mark, plus an absolute cap | Hysteresis avoids evicting continuously at the threshold; the cap makes one configuration behave the same on a small and a large node. |
| LRU by **access** time | Ordered by last read, not last write | A popular template is written once and read constantly. Ordering by write time would evict exactly the artifacts that are working hardest. |
| Access time tracked internally | Not filesystem `atime` | `atime` is commonly disabled or coarsened by mount options, and page faults against a mapping do not update it at all — so the warm path, which is the important one, would be invisible. |
| Pin set | Eviction skips artifacts mapped by live sandboxes, and also the sources being read by a flatten | Removing a memory file out from under a running VM is unrecoverable, which makes this the highest-consequence rule in the component. The unmapped case fails more gently — a failed restore — but it is still an expensive failure produced by an eviction that had cheaper victims available. A pause is not on this list: composing source maps reads maps rather than blobs, so no pause depends on an artifact staying resident. |
| In-flight protection | An artifact with a fetch in progress or a waiter is not evictable | Otherwise memory pressure produces thrash: fetch, evict mid-download, re-fetch. |
| Admission guard | An artifact above a fraction of the cap is refused or flagged | One outsized artifact must not be able to force out everything else on arrival. |

Pins are **derived from `vm-host`'s lease file rather than kept as an independent durable
record**. Two durable answers to "which sandboxes are live" would eventually disagree, and the
disagreement would be discovered by evicting a live sandbox's backing file. One record, one
answer.

### Eviction frees space later than it deletes files

`unlink` frees nothing while a reference to the inode survives. A memory file that a running VM
has mapped keeps every one of its blocks after its directory entry is gone, and keeps them until
the last mapping and the last descriptor are closed — which for a mapped artifact means until
the sandbox ends. Deletion and reclamation are separate events, sometimes separated by hours.

**A cached memory file has at least two references, not one.** The fault handler, its handshake
socket, and the memory file all have to live inside the jail
(`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:71-74`), so
a file the cache holds reaches the VMM by being presented into the jail root rather than by being
read from the cache directory. That presentation is a second link to the same inode, and removing
the cache's own directory entry does not remove it. The consequence is not a new rule — the
accounting below already handles it, because it counts bytes scheduled for deletion rather than
asking the filesystem — but it is the reason the gap between the two figures is structural rather
than a symptom of something being held too long, and it is why the exported discrepancy metric is
read against the count of live sandboxes rather than against zero.

That has a specific and violent consequence for the watermark loop. A loop that deletes a victim
and then re-measures usage from the filesystem sees the same number it saw before, concludes
that eviction achieved nothing, selects another victim, and repeats — **evicting the cache to
empty in response to pressure that a single eviction would have relieved.** The node then serves
every subsequent create cold, under exactly the load that caused the problem.

**Usage is therefore measured as bytes on disk minus bytes already scheduled for deletion**, and
the loop's stopping condition is evaluated against that figure. Space that is spoken for counts
as freed for the purpose of deciding whether to keep going, and the discrepancy against the real
filesystem figure is exported as a metric, because a persistent gap means references are being
held longer than anyone expects.

### Deletion is deferred, and the pin is re-checked when it happens

Selecting a victim and removing it are separate steps with a deliberate delay between them.
Victims go on a deletion queue; the close-and-remove happens afterwards.

The delay exists to make the second rule possible: **the pin is re-checked at deletion time, not
only at selection time.** The window between the two is precisely where a starting sandbox loses
its backing file. A create arriving just after the selection scan pins an artifact the evictor
has already decided to remove, and an evictor that trusts a selection made microseconds earlier
removes a file out from under a restore that has already begun — the highest-consequence failure
in the component, reached through a race rather than through a missing check. Re-checking at
deletion turns the pin set from a filter applied once into a condition that holds at the moment
it matters.

### Startup reconciliation

On startup the store reconciles local state before the node is allowed to serve:

1. **Partial downloads are deleted.** After an unclean shutdown the store does not attempt to
   prove that a file and its presence record still agree; it removes them and re-fetches. The
   asymmetry justifies the waste — a re-fetch costs bandwidth, while a presence record that is
   wrong by one bit costs a silently corrupted guest.
2. **Staging directories from interrupted publishes are deleted.** They were never visible and
   have no claim on the disk.
3. **Stale pins are released**, by rebuilding the pin set from the lease file. Pins held by
   sandboxes that no longer exist would otherwise make their artifacts permanently
   unevictable, and the node would fill until every cold create failed.
4. **Files not corresponding to any known artifact ID are deleted.**

## Key flows

| Flow | Path |
|---|---|
| Cold create | `fetch_range` misses, chunks are pulled by ranged request into the sparse file and served under the fault loop; the background filler completes the file; the digest is verified; subsequent restores take the warm path. |
| Warm create | The complete, verified file is already local. The store pins it and hands the path to `vm-host`, which maps it. No request leaves the node. |
| Resume a snapshot | Its disk is a diff, so the map and every source it names are fetched and the image is assembled before the VM starts. Its memory is stored whole in the first release and takes the ordinary cold or warm path. |
| Restore a layered memory file | Not produced in the first release. The fault loop serves through the map while flattening assembles the image in the background, and the warm path becomes available once the locally computed digest is recorded in the cache index. |
| Publish after a pause | The pause path stages memory, device state, and the disk diff on NVMe; the store uploads blobs — source maps among them — and then the manifest, in the background, while the node continues serving. |
| Compose maps across repeated pauses | The previous map is composed with the new one, reading maps rather than blobs, so it needs nothing resident and cannot be defeated by an eviction. Exercised from the first release by the disk, whose second pause layers against the first. |
| Build output | Identical publication path, invoked by [template-builder](template-builder.md). One implementation, so pauses and builds cannot diverge. |
| Collection | A periodic job applies the two rules against object storage. |

## Concurrency and failure model

Concurrency belongs to the caller; the store is safe to share across tasks and threads and
maintains internal single-flight maps keyed by artifact and by chunk.

Backend request concurrency is bounded **per process, shared across all callers**, and split
into priority classes. A fault-path chunk fetch outranks a whole-artifact fetch, which outranks
the background filler. Without this, a burst of cold creates would saturate the node's link and
network bandwidth would be consumed by prefetching for a sandbox that has not started yet while
a running guest's vCPU sits parked on a fault.

**Concurrent cold restores carry their own stated maximum, and the quantity it is derived from
is in-flight faults rather than handlers.** A handler is not a serial resource: it serves faults
from a bounded worker pool, and a reference implementation runs pools measured in thousands.
Serialising to one outstanding fault per handler would be far worse than a conservative bound —
it would put one object-store round trip on the critical path of every single page of every cold
guest, turning a multi-vCPU guest into a single-threaded consumer of a network with latency
measured in milliseconds. The concurrency is the point of the design, not an excess to be
trimmed.

So the bound is a ceiling on **the node's total in-flight fault-path requests**, and the
admission figure for cold restores is derived from it: how many faults a cold guest keeps
outstanding while it starts, against how many the node can carry before the queue behind them
becomes latency nobody can see. Bounding backend requests alone is not enough, because the fault
path is where backpressure stops being a queue and becomes **a stopped vCPU**: a fault waiting
its turn behind other faults is not a slow request, it is a guest that is not executing, and the
guest cannot be told why. Queueing there converts a capacity problem into an invisible
availability problem spread across every cold sandbox on the node.

The maximum is configured, exported, and consulted at create admission rather than discovered
inside the fault loop. A create that would exceed it is refused so that placement can put it on
another node, which is a cheap answer; the alternative is accepting it and delivering a sandbox
whose vCPUs stall for reasons nothing on the node reports. Enforcement of the refusal belongs
to `vm-host`, which owns admission; the number and the accounting behind it belong here,
because this is the component that knows what a cold restore actually costs.

| Failure | Handling |
|---|---|
| Backend 5xx or throttling | Retry with jittered exponential backoff under a total time budget, then fail the operation. The caller decides whether the sandbox create can be retried elsewhere. |
| Manifest absent | Reported as "does not exist", not as a retryable error. Manifest-last means an absent manifest is an unpublished artifact, and retrying will not change that. |
| Digest mismatch on completion | Re-fetch once into a **new** file and swap; never repair the existing one in place, because it may be mapped and the hypervisor requires the memory file to be immutable while it backs a guest, with external modification documented as corrupting guest memory (`references/firecracker-docs/snapshotting/snapshot-support.md:472-476`). A second mismatch fails hard and marks the artifact suspect rather than retrying indefinitely, because a reproducible mismatch means the stored object is corrupt and silent retries would hide it. |
| Local disk full | Evict to the low watermark and retry once. If still full, fail the fetch. Pinned data is never sacrificed to make room. |
| Partial or misranged backend response | Treated as a failed chunk. The presence bit is never set, so a short read cannot become a permanent hole. |
| Crash during publish | Nothing becomes visible; the collector removes the remains. |

## Configuration

| Setting | Purpose |
|---|---|
| Endpoint, region, bucket, path-style flag, credentials | Backend selection. |
| Artifact prefix and build-context prefix | Keeps inputs out of the artifact namespace. |
| Cache directory and filesystem | Must be the dedicated NVMe mount, not the kubelet's filesystem, and must be presentable into a jail root without copying, since the memory file has to be visible inside the jail the VMM and its fault handler run in. |
| High watermark, low watermark, absolute cap | Eviction behaviour. |
| Chunk size default | Overridden per artifact by the manifest. |
| Backend concurrency limits per priority class | Protects the fault path. |
| Filler rate limit | Keeps completion off the critical path. |
| Collection grace period | Must exceed the longest plausible upload. |
| Publisher lease refresh interval | Comfortably shorter than the collection grace period, so a live upload never lapses. |
| Deletion grace period | Between removing a manifest and removing its blobs. Must exceed the maximum sandbox lifetime. |
| Eviction deletion delay | The window in which a selected victim's pin is re-checked before it is removed. |
| Flatten concurrency | Bounds parallel assembly of files stored as diffs, which competes with fault-path reads for the same NVMe bandwidth. A disk flatten is on the create path rather than in the background, so this bound is a create-latency knob and not only a bandwidth one. |
| Maximum in-flight fault-path requests per node, and the cold restores admitted against it | Consulted at admission. The ceiling is on outstanding faults, not on handlers; the restore count is derived from it. |
| Retry budgets | Bounds how long a cold create can spend failing. |

The backend is **any S3-compatible endpoint**, so an in-cluster object store and a managed one
are both supported without code changes. This is an operational choice an operator should be
able to make on their own terms: someone installing into their own cluster may not want an
external dependency, while at scale a managed endpoint is usually the right answer.

Keeping that promise means depending on a small surface — ranged GET, PUT and multipart upload
including listing and aborting in-progress uploads, HEAD, LIST by prefix, and DELETE — and
deliberately not using provider-specific features such as lifecycle rules, object tagging,
versioning, or conditional writes.

The manifest-last protocol is what makes that narrow surface sufficient, and it is worth being
exact about the guarantees it does still assume rather than claiming it assumes none:

- **Read-after-write consistency on the manifest key.** Existence is defined as a successful
  read of `manifest.json`, so a backend that can serve a 404 for a key it has already
  acknowledged will report a published artifact as absent. That is a benign failure — the
  caller sees "does not exist" and the artifact appears shortly after — but it is a real
  assumption, and on a backend without it the window is a source of spurious create failures
  rather than of corruption.
- **Listings good enough for the collector, which is not the same as trustworthy.** The
  collector's age rule is computed from a prefix listing, and this document tells every *reader*
  not to infer existence from listings because they are eventually consistent. Both positions
  are defensible together only because the collector's grace period is orders of magnitude
  longer than any listing lag, and because the lease object gives a live upload a protection
  that does not depend on the listing being complete. It is a tolerance, not an exemption, and
  it is the reason the grace period is configured conservatively rather than tuned down.

Neither assumption requires conditional writes or a strongly consistent listing, which is what
keeps the store portable. Portability is verified rather than asserted: the backend conformance
suite below is what keeps "S3-compatible" from meaning whatever the next endpoint decides.

## State owned

| State | Location | Nature |
|---|---|---|
| Artifact bytes and manifests | Object storage, under the artifact prefix | Durable truth. |
| Local cache files and presence records | Node NVMe | Disposable. A cold node is slow, not broken. |
| Verification markers and locally computed digests of flattened images | Node NVMe, in the cache index | Durable across restarts so verification is paid once per node per artifact. Losing them costs a re-hash, never correctness. |
| Flattened images of files stored as diffs | Node NVMe | Not artifacts. No manifest, no stored object, no participation in eviction; removed with the sandbox that asked for them. |
| Pin set | In memory, derived from the lease file | Rebuilt at startup. |
| Single-flight and priority state | In memory | Per process. |

The store owns no rows in PostgreSQL. Ownership, aliases, and lifecycle state belong to
`control-plane`; the cache key index belongs to `template-builder`.

## Observability

| Metric | Why it matters |
|---|---|
| **Hit ratio** | Effectively the sandbox-start latency distribution. A miss puts an object-store round trip inside the create path, so this single ratio predicts start latency better than any timing metric collected elsewhere. It belongs on the main dashboard. |
| **Bytes resident** against the cap | Whether the cache is working within its budget or living permanently at the high watermark. |
| **Pinned bytes** | The early warning nobody expects to need. Pinned bytes approaching the high watermark means eviction has nothing left to take: the node will begin failing cold creates while appearing to have cache space. That is a node oversubscription signal, not a cache problem, and it is only visible here. |
| **Evictions**, count and bytes | With re-fetch-within-window as a thrash indicator. Thrash means the cap is too small for the working set, which is a capacity decision rather than a tuning one. |
| **Fetch latency distribution** | The distribution, not the mean, split by whole-artifact and chunk fetch. The tail sets the pre-warm budget, and cold nodes correlate with demand spikes, so the tail is when it hurts. |
| Flatten duration and bytes assembled | The interval between a parented restore starting and its warm path becoming available. Growth here means diffs are accumulating faster than they are being collapsed. |
| Source map size, in runs and in bytes | The one part of an artifact's metadata that scales with the image, and the input to the decision about when its encoding has to become a coded one. Composed maps are also what dominates host memory on a snapshot-heavy node, so this is a memory signal as well as a storage one. |
| Read amplification | Bytes fetched against bytes served, which is how a wrong chunk size makes itself visible. |
| Publish duration and orphaned prefixes collected | A rising orphan count means crashes inside the publication window. |

## Testing

| Test | What it protects |
|---|---|
| Golden-file manifests | A checked-in corpus with expected parse results, covering every `kind`, both parentage cases, and every validation failure. Format changes must update goldens in the same commit, which makes the change visible in review. |
| **Unknown format version is refused** | An explicit, separately named test asserting that a manifest declaring a future format is rejected outright rather than parsed best-effort. It is called out on its own because the tempting failure — reading the fields it recognises and hoping — would pass every other test in the suite. |
| The recorded snapshot format matches the bytes | Publish an artifact and assert `runtime.snapshot_format` equals the version embedded in the device-state file, which `snapshot-editor info-vmstate version` reads independently of anything we wrote (`references/firecracker-docs/snapshotting/snapshot-editor.md:78-97`). This is the one `runtime` field the hypervisor hard-fails on, and it is otherwise only ever written by us from context, so a writer that took it from the wrong place produces artifacts that publish cleanly and fail on restore. |
| Publication crash injection | Kill at each point in the sequence and assert that no artifact is visible without a manifest, that the collector removes the remains, that the grace period protects a slow upload, and that republishing is idempotent. |
| Reader property tests | Random read patterns against a reference image over a fake backend, asserting served bytes always equal the reference. Includes an explicit assertion that no read ever returns a hole. |
| Fault-injecting backend | Short reads, wrong ranges, truncated bodies, 5xx, and throttling, asserting no presence bit is ever set for an unverified chunk. |
| Warm-path gate | Assert the file backend is only selected after a digest has been verified over the file's actual contents — the manifest digest for a stored image, the cache index's locally computed digest for a flattened one. The second case is the one a test written against the manifest alone silently skips. |
| Source map round trip through storage | Publish a diff produced as a sparse file, fetch it back from a backend that materialises holes as zeroes, and assert the flattened result is byte-identical to the source image. This is the test that fails if any code path infers a run's meaning from allocated extents, and it cannot fail on a purely local fixture. |
| The zero sentinel | Have the guest discard a page whose parent holds content, then assert the restored image reads zeroes there rather than the parent's bytes. A map that folds the discard into inheritance passes every other test in the suite. |
| Composition over repeated pauses | Compose three pauses of one sandbox. Assert the final map tiles exactly, that every source it names is still referenced and therefore uncollectable, that the flattened image matches guest memory, and that the composition completed with **no source blob resident on the node** — which is the property that removed the full-snapshot fallback. |
| Deeper maps are read, not rejected | Hand the reader a map naming more sources than the writer would ever produce and assert it flattens correctly. The depth bound is a writer policy, and a reader that enforces it turns a future format decision into a fleet-wide incident. |
| Compacted diff offsets | Flatten a diff whose runs are packed contiguously rather than laid out at image offsets, and assert the result matches. Every range calculation in the reader has to use `source_block_offset` rather than the run's position in the image, and a fixture built at full length cannot tell the difference. |
| Collector against a live multipart upload | Start a large multipart upload under a prefix that already holds older blobs, advance the clock past the grace period, run the collector, then complete the upload and write the manifest. Assert nothing was deleted and that no manifest is ever readable over a missing blob. This is the case the newest-object-age rule alone does not cover, so it needs its own test rather than a variation of the crash-injection one. |
| Abandoned multipart uploads are aborted | Start and abandon an upload; assert the collector aborts it after the grace period and reports it. Otherwise the only signal is a bill. |
| Eviction accounting under a live mapping | Map a memory file, then drive the cache above the high watermark. Assert the loop frees to the low mark and stops, rather than re-measuring unchanged filesystem usage and evicting to empty. |
| Pin acquired between selection and deletion | Select a victim, acquire a pin on it before the deletion delay elapses, and assert the file survives. The selection-time check alone passes this scenario while deleting the file. |
| Verified marker survives restart | Verify an artifact, restart, and assert the warm path is taken without re-hashing the file. |
| Eviction | Watermark behaviour, LRU ordered by access rather than write, and a pinned artifact surviving pressure that would otherwise remove it. |
| Reconciliation | Leave partial downloads, staging directories, and stale pins on disk; restart; assert all are handled. |
| Backend conformance suite | Run against both an in-cluster object store and a managed endpoint. "S3-compatible" varies in practice, and this suite is what keeps the abstraction honest instead of aspirational. |

## Rules that must not be violated

1. **The manifest is uploaded last**, and its presence is the only definition of existence.
2. **Existence is checked by reading the manifest key, never by listing a prefix.**
3. **An unknown `format` value is refused**, never parsed best-effort.
4. **A presence bit is set only after its chunk is durable**, never before.
5. **The file backend is used only for a complete, digest-verified file** — the manifest digest
   for a stored image, the cache index's locally computed digest for a flattened one.
6. **A diff's source map is the only authority on where its bytes come from.** No reader
   consults the file's hole structure, and the zero sentinel is always distinct from a real
   source — folding it into one resurrects that source's content.
7. **A reader never enforces the writer's depth policy.** The bound on distinct sources lives in
   the pause path; a map naming more of them is read correctly.
8. **A pinned artifact is never evicted.** Pins derive from one durable record, cover flatten
   sources as well as mappings, and are re-checked at deletion rather than only at
   selection.
9. **A file that is mapped is never truncated, hole-punched, or rewritten in place.**
10. **Published artifacts are never mutated.** A new pause produces a new artifact ID.
11. **No component other than this library reads or writes artifact bytes.**
12. **The collector never deletes a prefix that is still being written to**, including one whose
    only sign of life is a publisher lease or an in-progress multipart upload.
13. **An artifact is never collected while another artifact's source map names it**, and a
    deletion removes the manifest before the blobs.
14. **The background filler never competes with a fault-path fetch.**
