---
type: Component
title: template-builder
description: Converts an OCI image reference plus a recipe into a bootable template artifact by unpacking layers and executing recipe steps inside microVMs, with content-hash-keyed layer caching. Also the component that fixes everything a sandbox cannot change later — its device model, its kernel command line, and the guest kernel whose support window the template inherits.
tags: [component, build, oci, templates]
timestamp: 2026-07-27T07:33:00Z
---

# template-builder

A sandbox does not boot; it resumes from a snapshot that was booted once, at build time. This
component is where that one boot happens. It takes an OCI image reference and a recipe, and
produces a `template` artifact — an immutable bundle of guest memory, VM device state, and a
root filesystem, described in [snapshots](../architecture/snapshots.md).

## Purpose

Turn a declarative description of an environment into an artifact that
[vm-host](vm-host.md) can restore in a few hundred milliseconds. Everything expensive about
starting an environment — unpacking a filesystem, installing packages, booting a kernel,
starting an interpreter, warming a service — is paid once here so that it is never paid on the
create path.

**That claim is the reason the pipeline has the shape it has, so it is worth being exact about the
mechanism.** The artifact carries the work as *state* rather than as instructions: a warm process
tree already resident in a memory image, which a restore maps instead of re-executing. This is why
the pipeline ends in a boot and a warm-up rather than in a finished filesystem, and why its last
phase is the expensive one. A builder that produced only a root filesystem would have moved the
work rather than removed it, and every sandbox would pay the startup cost the tenant came here to
avoid.

`template-builder` runs as a Deployment scheduled onto the sandbox node pool, with the same
host privileges as the node daemon. This is not a packaging convenience. The builder boots
real Firecracker microVMs: it needs `/dev/kvm`, the jailer, per-VM network namespaces,
userfaultfd, and the ability to attach block devices. Those requirements are identical to
`vm-host`'s, and the reasoning in [security](../architecture/security.md) about confining
privilege applies unchanged — the builder lives in the same privileged namespace on the same
tainted node pool, so the platform's privileged surface remains one node pool rather than two.

## Responsibilities

| Responsibility | Notes |
|---|---|
| Resolve an image reference to an immutable per-platform digest | Tags are resolved once, at the start, with an explicit platform, and never consulted again during the build. |
| Materialise image layers into a checked, right-sized ext4 filesystem image | Performed inside a disposable microVM, including the integrity checks and the shrink and grow. See [Phase 1](#phase-1-resolve-pull-and-unpack). |
| Execute recipe steps against that filesystem | In a single long-lived build VM, sealing an immutable generation at each caching boundary. |
| Maintain the layer cache and its index | Content-hash keys mapping to `fs-layer` artifact identifiers. |
| Strip per-machine identity and entropy before capture | Seeds, machine identity, and baked host keys. Unconditional, never a recipe step. |
| Boot, warm, snapshot, and profile the finished environment | In a fresh VM, never the build VM. Producing memory, device state, and prefetch hints intersected across several recorded resumes. |
| Publish the result | Through [artifact-store](artifact-store.md), manifest last. |
| Stream build logs and report build state | Logs are tenant data; build state is a row in PostgreSQL. |

## Explicit non-responsibilities

- **Authentication, authorization, and quota.** [control-plane](control-plane.md) decides
  whether an organisation may start a build and how many it may run. The builder is never
  reachable by a tenant directly.
- **Naming.** Aliases such as `python:3.12` are rows in PostgreSQL owned by `control-plane`.
  The builder produces an artifact identifier and nothing else; pointing a name at it is a
  separate, atomic act.
- **Serving traffic or running tenant sandboxes.** The VMs it boots exist only for the
  duration of a build.
- **Defining the artifact format.** That belongs to [artifact-store](artifact-store.md), which
  is also the only code that writes artifact bytes.
- **Deciding where templates are cached.** Warmth-aware placement is `control-plane`'s
  concern.
- **Garbage-collecting published artifacts.** The builder writes; the registry collector
  described in [snapshots](../architecture/snapshots.md) deletes. The one exception is build
  context, which the builder owns end to end.

## Internal structure

The builder is a single Rust binary. Its interesting internal boundaries are:

| Module | Role |
|---|---|
| `registry` | Platform-explicit reference resolution, token refresh, rate-limit handling, and digest-verified blob transfer. Moves bytes; never interprets them. |
| `factory` | Boots and destroys the disposable unpack VM, and owns the in-guest integrity-check, shrink, and grow operations. |
| `buildvm` | Owns the long-lived build VM: boot, device attach, quiesce, teardown. |
| `steps` | Canonicalises recipe steps, computes keys, executes, and seals. |
| `cacheidx` | Reads and writes the key-to-artifact index. |
| `finalise` | Start and readiness commands, identity and entropy hygiene, cold boot, snapshot, prefetch recording and intersection. |
| `logs` | Durable log sink plus live tail. |
| `lease` | Build ownership, heartbeats, and startup reclamation. |

Two shared pieces are reused rather than reimplemented: the Firecracker client and snapshot
sequencing library that `vm-host` uses, and the [artifact-store](artifact-store.md) library.
Reuse matters here beyond code economy — the pause sequence has ordering constraints that are
easy to get subtly wrong, and a second implementation would be a second place to get them
wrong.

The builder ships its own **guest kernel and initramfs**. The initramfs contains
[vm-init](vm-init.md), [vm-steward](vm-steward.md), the unpacker, the filesystem toolchain every
in-guest disk operation needs, and a small step shim. Its contents are part of the builder's
release, not of any image it builds.

## The pipeline

The build is a sequence of ordered phases. Each phase has a defined input, a defined output,
and a defined place where it executes.

| Phase | Input | Output | Executes in |
|---|---|---|---|
| 1. Resolve, pull, unpack, size | Image reference | Checked, right-sized ext4 filesystem image | Host (transfer only) and disposable factory VM |
| 2. Provide guest programs | Builder initramfs | Bootable build VM | Host and build VM |
| 3. Execute recipe steps | Filesystem image, recipe, context | Sealed `fs-layer` generations | Build VM |
| 4. Finalisation | Final generation | Proof that the environment starts and reaches readiness — or an early build failure. **No memory image.** | Build VM |
| 5. Hygiene, cold boot, warm-up, snapshot, profile | Final generation | `template` artifact, whose memory image is the *capture* VM's warm process tree | Host and fresh VMs |

**The warm process tree that ships is Phase 5's, not Phase 4's**, and the table is explicit about
it because the other reading is the natural one and the shortcut it suggests looks like free build
time. Phase 4 starts the environment in the build VM to establish that the recipe produced a
filesystem which can come up, and to fail the build early and attributably if it did not. Phase 5
then boots the finished root filesystem cold in a fresh VM, starts it again, waits for readiness
again, and captures *that*. The warm-up is performed twice, on purpose, and only the second one
becomes an artifact.

### Phase 1: resolve, pull, and unpack

#### Resolution

The reference is resolved to a digest immediately, and the digest is what the rest of the
build uses. A tag consulted twice can name two different images; resolving once makes the
whole build describe one input.

Resolution has a step that is easy to skip and that produces a wrong build rather than a failed
one. **A tag on a multi-architecture repository resolves to an index, not to an image.** The
index digest names a list of manifests; it is not a filesystem and cannot be unpacked. So the
builder resolves with an **explicit platform** rather than accepting whatever the registry
offers by default, and then **verifies the architecture declared in the resolved image's own
config** before unpacking it. The second check is not redundant with the first: the platform
recorded in an index entry and the architecture recorded in the image config are two separate
assertions by whoever published the image, and nothing forces them to agree. Skip it and the
build succeeds, producing a template full of binaries for the wrong architecture that fails at
the first execution inside a sandbox — one phase and one artifact away from the mistake, with
nothing in between to name it.

**The image config is applied rather than ignored.** An OCI image declares environment
variables, a working directory, a user, and an entrypoint, and a recipe step that runs as
though none of them existed is not running in the environment the image describes. `PATH` is the
routine case and the painful one: it is commonly set by the config and commonly load-bearing for
the first package-manager invocation in a recipe. Environment, working directory, and user are
therefore applied as each step's defaults, overridable by the recipe. The entrypoint is
**recorded as the template's default start command and not executed during the build** — a
recipe's own start command takes precedence — which keeps the start command the only thing that
launches a long-lived process, in the two phases that deliberately run it.

**Layer media types are checked rather than assumed.** gzip is the common case and increasingly
not the only one; `zstd` layers are ordinary now. The unpacker supports both and refuses
anything else by declared media type rather than by sniffing the bytes, since sniffing is
parsing and parsing is the thing being kept out of the host. **Foreign layers**, which name an
external URL instead of being served by the registry, fail the build with that as the stated
reason. The digest would still guarantee the bytes, but it guarantees nothing about whether the
operator intended this builder to contact that host, and a base image should not be able to
choose the builder's network peers.

**A long pull outlives its credentials.** Registry bearer tokens expire in minutes; a
multi-gigabyte base image over a constrained link does not finish in minutes. The builder
refreshes on a 401 and retries the request rather than failing the pull, and it treats 429 and
`Retry-After` as first-class rather than as generic errors: concurrent builds of a popular base
image are exactly the traffic shape a registry rate-limits, and a builder that retries without
honouring the backoff turns a slow pull into a blocked account for every tenant at once.
Per-registry request concurrency is bounded for the same reason.

#### Transfer and unpacking

Blob transfer happens on the host: the builder fetches each layer over HTTPS and verifies it
against its declared digest. This is safe because it is byte-shuffling and hashing — the host
never parses the archive. It then creates a blank, formatted ext4 image, boots a **factory
VM**, attaches the layer blobs read-only and the target image read-write, and the unpacker
inside the guest decompresses and extracts the layers onto the target.

**The unpacking happens inside a VM, and this is the single most important decision in the
component.** Image layers are attacker-controlled archives. An archive can carry path
traversal, absolute or looping symlink targets, hardlinks pointing outside the extraction
root, device nodes, setuid bits, sparse-entry metadata that expands to terabytes, and
compression that expands by orders of magnitude. An unpacker is an ordinary amount of parsing
code and will therefore have bugs. If it runs in the privileged host namespace, a malicious
archive only has to defeat the unpacker to gain code execution on a node that has `/dev/kvm`,
the sandbox network, and the artifact store's credentials. If it runs inside a VM, the same
archive must defeat the unpacker *and then* defeat the hypervisor — the same boundary the
entire product already rests on for hostile tenant code.

The cost is usually quoted as one microVM boot per build, and the boot is the least of it. A
microVM boot is tens of milliseconds against a build measured in minutes. **The real cost is
that every host-side operation on the resulting filesystem inherits the same problem.** Checking
the image's integrity, shrinking it, growing it, injecting a file, reading a path back out —
each is an operation on a filesystem whose contents an attacker populated, so each must either
move into the guest as well, or be performed by mounting attacker-populated filesystem content
on the host. The second option is worse than the archive parsing this decision was made to
avoid: kernel filesystem drivers are not written as hostile-input parsers, and a deliberately
corrupted superblock aimed at one is a shorter path to a privileged node than a tar bomb ever
was.

So the decision is not "pay one boot". It is that **the guest is the only thing that touches
this filesystem's contents, for the whole pipeline** — which is what the disk sizing sub-pipeline
below actually costs, and it is still the right trade.

It has to be budgeted as such. Every filesystem operation the pipeline needs has to exist inside
the guest, so the builder's initramfs carries a **filesystem toolchain** — create, integrity
check, resize in both directions, and the file injection and extraction the later phases use —
and that toolchain is part of the builder's release surface: it is versioned with the initramfs,
it enters the cache key through the unpacker and recipe format versions when its behaviour
changes, and it grows whenever the pipeline needs an operation it does not already have. Counting
only the boot understates the decision by the size of that toolchain, which is the part that has
to be maintained rather than merely paid for once.

The factory VM is bounded and disposable: fixed vCPU and memory, a hard cap on the target
image size, a wall-clock deadline, and no network. A decompression bomb therefore exhausts a
disposable VM's disk and fails the build, rather than filling the node.

#### Disk sizing

Sizing the root filesystem is a sub-pipeline rather than a step, and each part of it exists
because omitting it produces a specific, badly-attributed failure. Every part runs **inside a
guest**, per the rule above.

| Step | Why it is there |
|---|---|
| Create at the maximum permitted size | Nothing knows in advance how far a set of layers expands. An image created at a guessed size fails partway through extraction with a filesystem error rather than a size error. |
| Extract the layers | The unpacking described above. |
| Integrity-check | The extraction has just been driven by attacker-controlled input. Nothing downstream should trust the filesystem before it has been checked. |
| Shrink to the used size plus headroom | **Without this every template ships at the maximum size**, which is paid on every upload, every cold fetch, every eviction decision, and every node's cache budget, forever, for a template that may use a tenth of it. |
| Integrity-check again | A shrink rewrites filesystem metadata. Checking only before it verifies the state of something that no longer exists. |
| Guarantee free space before recipe steps run | A recipe that installs packages needs room to do it. Without a grow phase, the failure is an out-of-space error raised from inside a package manager — the most confusing diagnostic the builder can produce, because the recipe is correct, the message names a tool that is not at fault, and nothing points at the disk. |

The shrink and the grow are the same mechanism pointed in two directions, and neither is
optional: dropping the shrink makes every template maximal, and dropping the grow makes every
substantial recipe fail obscurely.

The resulting filesystem image is sealed as an `fs-layer` artifact and keyed like any other
step, so a second build from the same base image skips this phase entirely.

### Phase 2: provide the guest programs

`vm-init` and `vm-steward` come from the **builder's own initramfs**, never from the image
being built. `vm-init` mounts the built filesystem, places the agent on a tmpfs populated from
the initramfs, and pivots. The agent is therefore resident in the guest without ever being a
file in the tenant's filesystem.

Two consequences follow, and the second is the reason for the design.

First, an image cannot shadow the platform's agent. A tenant image containing a file at the
agent's path changes nothing, because the agent is not resolved from the tenant filesystem.

Second, and more importantly: **cached filesystem layers stay inert.** An `fs-layer` artifact
is a filesystem and nothing more. It carries no sealed agent, no init, and nothing that
executes on a later build's behalf. So when the agent is updated — a fix in `vm-steward`, a
new capability, a kernel bump in the initramfs — no cached layer needs patching, rewriting, or
invalidating. The new agent is simply what the next build boots. The alternative, baking the
agent into the layer, would make every agent release a fleet-wide cache rewrite: either every
cached layer is edited in place, which violates artifact immutability, or every cached layer
is rebuilt, which discards the cache exactly when the platform is mid-rollout.

The agent *is* sealed into the final template, because a template contains a memory image with
the agent running in it. That is unavoidable and is the invariant recorded in
[index](../index.md): the sealed surface stays small precisely because it cannot be
redeployed.

**The builder is the writer of the `runtime` block**, and it records the full compatibility key
described in [snapshots](../architecture/snapshots.md), not merely the parts it finds
interesting: the host CPU architecture and its family and model, or the identifier of the CPU
template the build VM ran under; the host kernel version; the VMM version and the snapshot
format version; the guest kernel identity and its boot arguments; the device model set; and the
sealed agent's build identifier and capability set. Every one of those is consumed by something
at restore time — most as a placement filter, the VMM version as the key that selects which build
on the node runs the artifact, the agent's build identifier as the key the capability quarantine
list is consulted by — so a field the builder omits is not a looser constraint but a check that
silently stops happening.

Two of those fields are consumed by something other than a restore, and are recorded to a standard
that only makes sense once that is known. The **guest kernel identity** is what an operator queries
to find templates whose kernel is leaving support, so it carries a version and not only a digest —
see [the guest kernel's expiry date](#the-guest-kernel-a-template-seals-has-an-expiry-date). The
**device model set** is a compatibility field at restore and a permanence record everywhere else,
because the devices it names were all installed before the capture VM booted and none of them can
be added to a sandbox afterwards.

The agent's build identifier is the one the builder is uniquely placed to get right, because the
agent it seals comes from **its own initramfs** rather than from anything the recipe names. It is
recorded as the build that was actually sealed, never as the build the builder was configured to
seal, since the two diverge exactly during a rollout — which is the window a quarantine list
exists to clean up after. This is worth stating as an obligation rather than as a data flow, because the
builder is the only component in a position to know most of it: by the time a node is considering
a restore, the machine that produced the artifact is gone.

The CPU entry is the one where omission is most expensive, and the reason is not obvious from
this side of the boundary. The hypervisor **does not refuse a CPU mismatch** — it logs a warning
and restores anyway, and the guest faults on a missing instruction arbitrarily later. The field
the builder writes is therefore the only thing standing between a rolling upgrade and a class of
failure with no attribution at all.

The CPU entry deserves a note. A template captured on whatever CPU the build happened to land
on is restorable only on that CPU model, which fragments the fleet along a dimension nobody
chose. Running builds under an explicit **CPU template** normalises the feature set the guest is
told about and makes the resulting artifact restorable across the whole pool, at the cost of
masking features from tenant workloads. That is a platform-level decision rather than a
per-build one, and whichever way it goes, what the build ran under is what the manifest records.

### Phase 3: execute recipe steps

Recipe steps run in **one long-lived build VM**, not one VM per step. At each caching boundary
the writable disk delta is sealed as an immutable filesystem generation while the VM keeps
running.

The reason is arithmetic and threat modelling in combination. A recipe of twenty steps under
a VM-per-step scheme pays twenty boots, twenty disk attach and detach cycles, and twenty
teardowns; boot cost is small but it multiplies, and it multiplies against the recipe length
rather than against anything the tenant gets value from. The isolation a fresh VM would buy is
isolation *between steps of the same tenant's build*, which is not a boundary anyone needs:
the steps are all supplied by the same tenant, run with the same privileges, and write to the
same filesystem. The boundary that matters — tenant build code against the host — is provided
by the one VM, and reusing that VM across steps does not weaken it at all.

Reusing the VM is not free, and two requirements follow directly from it.

**A real flush barrier before every seal.** The host must not read a disk that the guest is
still writing. The barrier is built from what the hypervisor actually offers, which is worth
spelling out because the obvious formulation reaches for a capability that does not exist:

| Step | What it accomplishes |
|---|---|
| Stop the step's processes | Freeze the step's cgroup and confirm it, on the same terms as the pause sequence in [snapshots](../architecture/snapshots.md). Nothing new is submitted from here on. |
| Guest `sync` | Pushes the guest's dirty page cache into the virtio device. |
| `FIFREEZE` the guest filesystem | Quiesces the filesystem and puts its superblock in a consistent state. Correct **here**, unlike in the memory pause sequence, for the reason below. |
| Pause the VM | The stock stand-in for a device-queue drain: with vCPUs stopped, no further requests are submitted and the device emulation quiesces. |
| `fsync` the backing file on the host | The writes the VMM has issued still sit in the *host's* page cache. Without this the seal can capture a file whose tail exists only in memory on a node that is about to lose power. |
| Seal, then thaw and resume | |

**There is no stock virtio block queue drain**, which is why the barrier is assembled this way
rather than around one. The hypervisor exposes no interface that waits for every outstanding
block request to retire and then reports quiesced, so a design that assumes one has a step it
cannot implement. The sequence above reaches the same place by a different route: `FIFREEZE`
stops the filesystem issuing new writes, the VM pause stops the vCPUs submitting anything
further, and the host-side `fsync` covers the layer the guest cannot see.
If a genuine drain is ever wanted, **it is a patch to the VMM and must be adopted as an explicit
decision**, with the cost of carrying a fork against every upstream release stated at the time
rather than discovered later. It is not contemplated for v1.

That position is load-bearing beyond this barrier. [Snapshots](../architecture/snapshots.md)
gates incremental snapshots on the same question, because the only production system doing them
reads dirty pages out of the VMM process through endpoints that do not exist upstream — the same
fork, carrying this drain among its patches. Whoever revisits one of these decisions is
revisiting both, and the honest way to price a fork is against everything it would be asked to
carry rather than against the feature that prompted it.

Skipping any part of the barrier produces a sealed generation with a torn tail — a filesystem
that mounts, mostly works, and fails later on some machine that got a cache hit. That failure is
maximally expensive to diagnose, because it appears far from its cause and only under cache
hits.

**Why freezing is right here and wrong during a memory pause.** The pause sequence in
[snapshots](../architecture/snapshots.md) deliberately does *not* freeze the guest filesystem,
because `FIFREEZE` state lives in the superblock, the superblock is guest memory, and a memory
snapshot taken over a frozen filesystem restores into a guest that blocks on its first write.
The seal has no such problem: it captures a **block device and no memory**, so the frozen state
exists only for the duration of the barrier and is thawed before anything is captured that could
remember it. Same primitive, opposite conclusion, and the difference is entirely whether memory
is being captured alongside.

**The build VM's non-root-filesystem state is never sealed, and this is the sharpest limitation
in the design.** Sealing captures the root block device and nothing else. Anything a step writes
somewhere the root filesystem cannot see — a tmpfs, `/run`, `/dev/shm`, a sysctl, a loaded
kernel module, the state of a running service — is invisible to the cache entry. So a build that
gets a cache hit at step *i* resumes from a filesystem that is byte-correct and an environment
that is not, and the divergence is silent in both directions: the fresh build works and the
cached build fails, or worse, both work and produce different templates.

This is precisely what a VM-per-step design gets for free, and it is the cost of reusing one VM.
It is paid down rather than eliminated:

- **PID, IPC, UTS, and network namespaces per step, not merely process and mount.** A background
  process must not survive into the next step, but neither must a SysV semaphore, a POSIX
  message queue, a hostname change, or a listening socket — all of which are step-visible state
  that a process-and-mount boundary leaves entirely intact.
- **An enumerated reset of kernel-visible state between steps.** Enumerated, because the set
  cannot be derived: tmpfs contents, `/run` and `/dev/shm`, non-namespaced sysctls the step may
  have written, and the service state the shim is responsible for. A list that is written down
  can be reviewed and extended; a general intention cannot.
- **Steps whose effect is not in the root filesystem are documented as unsupported.** Loading a
  kernel module, tuning a non-namespaced sysctl, or leaving a daemon running and expecting it in
  the next step are all things a recipe can do and none of them survive a cache hit. Saying so is
  better than the alternative, which is that they work until the day the cache is warm.
- **A cache-hit-versus-fresh-build test aimed specifically at this.** The existing test compares
  the resulting *filesystems*, so it cannot catch a class of bug defined by state that is not in
  the filesystem. The test that catches it builds a recipe fresh, builds it again from a cache
  hit at each step position, and compares what the steps *observed* — environment, namespace
  identity, visible processes, mounts, and the reset surface above — rather than what they wrote.

Environment, working directory, and umask are re-established per step from the recipe rather
than inherited, for the same reason.

Steps are launched through the ordinary process interface, executing a small step shim
supplied by the builder's initramfs, which establishes the namespaces and then execs the step.
Namespace policy therefore lives in the builder, where a redeploy can change it, rather than in
the sealed agent, where it could not be changed at all.

**Sealing mechanism.** The build VM's root device is backed by a host-side file on the node's
cache filesystem. Sealing takes a reflink copy of that backing file after the barrier and
registers the copy as an `fs-layer` artifact, while the VM continues writing to the original.
A reflink is metadata-only, so seal latency is dominated by the barrier rather than by the
copy, and the VM stalls for milliseconds rather than for the size of the disk. Where the cache
filesystem does not support reflinks the builder falls back to a full copy and the seal becomes
proportional to disk size; this is supported but is a materially worse operating point and is
reported as such at startup.

**A sealed generation is a complete image locally and a diff in the bucket.** The reflink is what
makes it complete on disk, and it is why the seal is cheap. What gets published is the set of
blocks on which it differs from the preceding generation, described by a source map, per
[snapshots](../architecture/snapshots.md). Both inputs are local files at the moment the
comparison runs, so this needs nothing from the hypervisor and nothing that a build does not
already have in hand.

This is where the largest saving in the component is. A twenty-step recipe on a two-gigabyte base
previously published twenty complete filesystem images — forty gigabytes stored, and forty
gigabytes fetched by any node that later needed the chain — for what is often a few hundred
megabytes of real change. Publishing diffs collapses that to roughly the change itself. It also
compounds with the space problem below rather than relieving it: the local generations still
diverge extent by extent as the build proceeds, so the build filesystem budget is unchanged and
only the upload, the storage, and the cold fetch get smaller.

**The comparison is a full read of the image at every seal, and that is the cost to weigh.** It
scales with image size times step count rather than with what the step wrote, so a long recipe
over a large base reads a great deal from local NVMe. It never touches the network and it is
bounded and predictable. Crucially it runs **against the reflink, after the barrier has been
released**, so it does not extend the interval during which the build VM is stalled — it belongs
to the upload side of the seal, not to the barrier side. What it does compete for is the NVMe
bandwidth the build itself is using, which is why it is bounded by the same concurrency limit as
the uploads. Narrowing it would need write tracking under the build disk, which the builder does
not have and does not currently ask for; [snapshots](../architecture/snapshots.md) records the
measurement that would decide whether to.

**Chain depth matters more here than it does for memory**, because a recipe generates one
generation per caching boundary and a long recipe generates many. Reads are unaffected — a source
map resolves any depth in one lookup — but every distinct source is an object a materialisation
must fetch and an artifact the collector must keep alive. So the builder **composes each
generation's map against its predecessor's at seal time** rather than letting the chain
accumulate, which bounds the number of sources a generation names by how much of the base it
still shares rather than by how many steps preceded it. The bound is a builder policy and is not
encoded in the format, exactly as the pause path's is not.

**A reflink is cheap at the moment it is taken and expensive for the rest of the build.** The
two files share extents only until something writes to one of them, and the build VM writes to
the live disk continuously from that point on. Every such write allocates a new extent rather
than overwriting a shared one, so the sealed generation and the live disk diverge for as long as
the build continues. A twenty-step recipe therefore holds **every sealed generation plus the
live disk on one filesystem**, and the space consumed grows with the total volume of writes
across the whole recipe rather than with the size of the disk.

Where that lands is the problem. The host filesystem fills, and the failure surfaces **inside
the guest as a mid-step out-of-space error** on a disk the guest can see has free space —
because the space the guest is short of is not the space it is looking at. Nothing in the
diagnostic points at the host, at the seal, or at the recipe length that caused it. Three things
follow: the node's build filesystem is budgeted against the expected write volume of a whole
recipe rather than against disk size; sealed generations are uploaded and released as the build
proceeds rather than accumulated until the end; and host filesystem headroom is monitored during
a build so that exhaustion fails the build with an attributable error before the guest ever sees
an I/O failure it cannot explain.

### Phase 4: finalisation

The recipe's start command is executed, and then its readiness command is polled until it
succeeds or the phase deadline expires. Only then does the build proceed to capture.

**What this phase produces is a verdict, not a memory image.** It establishes that the filesystem
the recipe built can actually come up: the start command runs, the service reaches readiness, and
the environment is one somebody could use. Nothing about the build VM's memory at the end of it is
kept. Readiness failing is therefore a **build failure**, not a warning — and failing it *here*,
rather than discovering it in Phase 5, is the point of running the environment in the build VM at
all. This is the last place in the pipeline where a failure can still be attributed to a recipe
step, because the build VM still holds the filesystem, the logs, and the process that failed. The
same failure found after the cold boot is a template that will not warm, with the recipe two
phases behind it.

The product claim this serves is stated in [purpose](#purpose) and is worth restating where the
work happens: a template captured before its services are warm pushes their entire startup cost
onto every sandbox ever created from it — an interpreter loading its standard library, a server
opening its socket and filling its caches, a runtime doing first-call compilation. Paid once at
build time, that cost is absent from the create path permanently, and it is absent for every
sandbox rather than amortised across them. **The phase that pays it into the artifact is
[Phase 5](#phase-5-hygiene-cold-boot-and-warm-up-snapshot-and-prefetch-recording), not this one.**

### Phase 5: hygiene, cold boot and warm-up, snapshot, and prefetch recording

#### Identity and entropy hygiene, before anything is captured

Every sandbox created from a template is a clone of one boot. Anything unique-per-machine that
exists in the filesystem when the template is captured is therefore **shared by every sandbox
that template will ever produce**, and for a shared public template that means shared across
tenants. The security framing is [security](../architecture/security.md)'s; the removal is the
builder's, because this is the only point in the system where these things can still be removed.

The strip runs on the final generation, after finalisation and before the cold boot. After
finalisation specifically, because a service started in Phase 4 can create exactly these files —
a first run that generates host keys or a self-signed certificate looks like correct behaviour
and is how they get in. What the builder strips:

| Stripped | Consequence of leaving it |
|---|---|
| The systemd random seed file | It is read at boot to credit entropy into the pool. One seed baked into a template seeds every clone of it identically, which is the failure this whole section is about. Upstream names the path and recommends deleting it before any snapshot is taken (`references/firecracker-docs/snapshotting/random-for-clones.md:145-149,159`). |
| `machine-id` | A stable per-machine identifier that other identities derive from. Absent, it is regenerated on first boot; present, every clone claims to be the same machine. |
| Baked SSH host keys | Every sandbox presents the same host key, so no client can distinguish one sandbox from another, and anyone holding a copy of the template holds the private key. |
| TLS private keys and certificates left by the image or by a step | The same failure with a worse blast radius, and easy to leave behind because a recipe step that generates a certificate looks like it is doing the right thing. |

`boot_id` is the exception that cannot be stripped, and the reason is sharper than "it lives in
`/proc`". The kernel initialises `/proc/sys/kernel/random/boot_id` with a random string at boot
and makes it **read-only afterwards**, so it can be neither deleted, nor emptied, nor written,
and every clone of a captured boot reads the same value. The only thing that changes what a
reader sees is a bind mount of another file over it
(`references/firecracker-docs/snapshotting/random-for-clones.md:150-155`). That mount is
[vm-init](vm-init.md#mounts)'s and is made at boot, not at restore; the per-sandbox value is
written into the file underneath it by the post-restore hook. Two obligations remain here
because only the builder can meet them: **the mount must be present in the captured image**,
which is asserted against the published template rather than assumed from a successful boot, and
nothing in the template may have cached a copy of the original value.

**The strip covers files. The capture covers memory, and the two are not the same surface.**
Every row in that table is something on a disk, and every one of them is removable because it is
a file. What no strip reaches is state a warmed process holds in its address space at the moment
of capture — and the warm-up below exists precisely to put processes in that condition. A
userspace pseudorandom generator seeds itself once, from the kernel or from a hardware
instruction, and then stretches that seed deterministically; a process that seeded one while
running the start command or answering the readiness probe carries that generator into the memory
image, where it
is bit-identical in every sandbox the template will ever produce and untouched by any reseed the
post-restore hook performs. Both sources say directly that nothing at this layer repairs it.
Brooker et al. state that a platform reseeding kernel randomness combined with a customer using a
cryptographically secure PRNG "is not secure" (*Restoring Uniqueness in MicroVM Snapshots*, §2),
and upstream, having scoped itself to the kernel interfaces, says of userspace pools that all it
can do is "recommend against their use in pre-snapshot logic"
(`references/firecracker-docs/snapshotting/random-for-clones.md:6-12`).

That recommendation lands here, because this component owns the only moment at which anyone can
act on it. **Consuming randomness in a start or readiness command is documented as
unsupported**, joining the Phase 3 steps whose effects do not survive a cache hit, and for a
worse reason than any of them: it works, it looks correct, and what it produces is shared across
every tenant of a public template for the life of that template. A service that needs a key
generates it on first use after restore rather than during finalisation — which is the rule the
host-key and certificate rows above already state for the filesystem, applied to memory. The
builder cannot detect a violation, which is why it is written down rather than checked.

Two pipeline consequences, and both are the kind of thing that is obvious once broken:

- **Hygiene is not a recipe step, and must not be.** A recipe step is content-keyed and
  therefore skippable on a cache hit, and hygiene that can be skipped is hygiene that is absent
  on exactly the builds that run most often. It is a phase, it runs unconditionally, and it runs
  last because anything before it can recreate what it removes.
- **`virtio-rng` must be in the device set the builder configures and records.** The post-restore
  reseed described in [snapshots](../architecture/snapshots.md) needs a source, and the device
  set is a hard placement filter, so a template built without it produces sandboxes that cannot
  be reseeded and no error says so. Stripping the seeds without providing the device makes
  entropy worse rather than better. The device is an *additional* entropy source and not the
  reseed itself — the guest kernel decides when to draw from it and nothing outside can force
  that to happen when a restore completes
  (`references/firecracker-docs/snapshotting/random-for-clones.md:166-167,191-193`) — which is
  why the hook's explicit reseed exists alongside it. Attaching it also obliges the guest kernel
  to carry the front-end driver (`references/firecracker-docs/entropy.md:61-64`), so the device
  and the kernel have to be checked together, which they are, because the builder chooses both.

#### Cold boot, warm-up, and capture

The finished filesystem is booted exactly once, from cold, in a fresh VM. That VM then **runs the
recipe's start command and waits for readiness a second time**, and the process tree this produces
is what the memory image captures. A cold boot of the final disk produces a minimal, reproducible
memory image that reflects the environment as specified rather than the history of how it was
assembled, and warming it here is what puts the product's central saving inside the artifact
instead of inside a build log.

**The build VM is never snapshotted, and the reason has to be written down because the shortcut is
attractive.** Its memory contains everything every recipe step did — page cache full of build
inputs, package managers, compilers, downloaded archives, dead allocations, and the recipe's own
scratch. Capturing it would bake all of that into the memory image of every sandbox ever created
from the template, which is the exact inverse of what this pipeline exists to produce: minimal and
specified rather than large and incidental. It would also be *faster*, because it skips a boot and
a second warm-up — which is why someone optimising build time will eventually propose it, and why
the answer is recorded here rather than rediscovered. The warm-up is performed twice on purpose.
The first one is a test; the second one is the product.

**Hugepages are asserted off on the capture VM rather than assumed off.** The memory backend
configuration is restored from the snapshot's own configuration, so a capture VM configured with
hugepages yields a template that demands them at every restore — and
[snapshots](../architecture/snapshots.md) establishes that hugepages are off precisely because
the file backend and hugetlbfs are mutually exclusive, and the file backend is what makes many
sandboxes from one template share physical memory. One misconfigured build VM therefore produces
a template that can never take the warm path, on every node, forever. The builder checks the
setting before capture rather than letting a restore discover it.

**The balloon is a template property, not a runtime one, and that is the general case rather than
a quirk of one flag.** The device can only be installed before the microVM starts
(`references/firecracker-docs/ballooning.md:120-123`), and every option it carries is fixed for
the life of that microVM — only the target size can be changed afterwards
(`references/firecracker-docs/ballooning.md:10-11`). Statistics are the sharpest illustration,
because they are frozen in *both* directions: a balloon configured without them cannot have them
enabled later, and one configured with them cannot have them turned off
(`references/firecracker-docs/ballooning.md:300-305`). So the runtime owns one integer and this
component owns everything else about the device, permanently, for every sandbox the template will
ever produce. A template built without a balloon can never gain one, and the pre-pause reclaim
pass in [snapshots](../architecture/snapshots.md#reclaim-before-capture) depends on there being
one.

**Free page reporting is the option that matters most, and it is enabled here.** Reporting is what
makes a sandbox's resident memory fall continuously as the guest frees pages, and reclaim rests on
it rather than on the host-triggered alternative: free page hinting is a developer-preview feature
whose device specification permits the guest to reclaim a range before the VMM has received it for
freeing, with corruption of guest memory as the documented consequence and no mitigation available
on the file backend (`references/firecracker-docs/ballooning.md:448-466`). Reporting therefore
carries the whole of the balloon's contribution to artifact size, and like the rest of the device
it is pre-boot only — no way to turn it on later, and no way to turn it off at all
(`references/firecracker-docs/ballooning.md:308-314`). A template built without it produces
sandboxes that can never acquire it, which is the same permanent shape as the hugepage mistake
above and worse in one respect: hugepages at least make every restore take the slow path, where a
missing reporting flag makes nothing fail anywhere and simply costs bytes in every artifact for
the life of the template.

**The device drags guest kernel configuration along with it**, and the builder is the only
component positioned to check the two together, because it chooses the device set and the kernel
in the same act. Ballooning needs `CONFIG_MEMORY_BALLOON` and `CONFIG_VIRTIO_BALLOON`
(`references/firecracker-docs/ballooning.md:113-115`,
`references/firecracker-docs/kernel-policy.md:64`), and reporting additionally needs
`PAGE_REPORTING` (`references/firecracker-docs/ballooning.md:312-314`). This is the same shape as
the entropy device's front-end driver and fails the same way: the host attaches a device, the
guest kernel has no driver for it, and **neither half reports anything**. The device is present in
the recorded model, the placement filter is satisfied, restores succeed, and the feature is simply
absent for the life of every template built that way.

**A recipe's boot arguments are composed onto the defaults, never passed through.** Supplying
`boot_args` **replaces the entire default command line** rather than appending to it
(`references/firecracker-docs/kernel-policy.md:188-211`), and those defaults are not incidental
to us. Two of them are the whole mechanism by which a guest kernel panic becomes something the
host can see: `panic=1` makes the panicking kernel reboot after a second instead of spinning
forever, and `reboot=k` makes the VMM treat that reboot as termination and exit — which is exactly
the behaviour [vm-init](vm-init.md#what-a-kernel-panic-actually-does) rests its "never exit" rule
on, and the difference between a sandbox that dies reportably and one that hangs with its memory
still allocated. A third, `8250.nr_uarts=0`, is the disabled serial device
[security](../architecture/security.md) requires.

What makes this a footgun rather than a setting to get right is that **we contribute none of those
three**. They arrive from the VMM's own defaults, so nothing in our configuration mentions them,
nothing in a diff shows them being removed, and a recipe that sets a single unrelated boot argument
drops all three at once. The result is a template that builds, publishes, validates, and produces
sandboxes that leak on panic and carry a console the tenant can re-enable, with no artifact
anywhere naming the boot argument responsible.

So the builder owns the command line and a recipe contributes to it: the VMM defaults are the base,
the platform's own required arguments go on top, and a recipe's arguments merge last and can
override neither. This is the same treatment Phase 1 gives the image config — what the input
supplies is a modifier on a known-good environment rather than a replacement for one — and it
prevents the same class of outcome, a build that succeeds while producing something nobody
specified.

**The capture must not begin before the guest kernel has finished booting.** On resume the VMM
writes a new generation identifier and injects an interrupt *before* the vCPUs run, so a snapshot
taken very early in guest kernel boot restores into a kernel whose interrupt handling is not yet
established, which cannot handle the notification and **crashes**; upstream's guidance is to
snapshot only after the kernel has completed booting
(`references/firecracker-docs/snapshotting/snapshot-support.md:657-665`).
[Snapshots](../architecture/snapshots.md) hands the constraint here because this is where the
first snapshot of any template is taken, and pausing a sandbox that has been serving for minutes
cannot reach it.

It needs a gate rather than a note, and the resolution follows from the cold boot above. The VM
that gets snapshotted is not the build VM that spent minutes executing recipe steps; it is a fresh
VM, so the interval between its kernel's first instruction and the capture is short **by
construction**. The warm-up does not reliably widen it either: a recipe with no start command and
no readiness command is a valid recipe, and for that template the capture follows the boot with
nothing in between. Every incentive in this component runs toward shortening the interval further,
since it is build latency on one side and pages in the artifact on the other, which makes this the
one place in the pipeline where the pressure points straight at the constraint. **So the gate is
the sealed agent's handshake rather than elapsed time:** a userspace process answering is proof
that the kernel got far enough to handle interrupts, which is precisely the capability it will need
for the notification it is sent on resume. A timer would be a guess about the same fact. The
failure this prevents is also the least attributable one this phase can produce — the build
succeeds, the template publishes, the manifest validates, and every sandbox ever created from it
dies on resume.

That VM is then paused and snapshotted following the standard sequence in
[snapshots](../architecture/snapshots.md), including the property that the tenant cgroup freeze
persists into the artifact — which is what gives the post-restore hook a window to reseed
entropy and re-establish identity before any tenant instruction runs.

#### Prefetch recording

A short **prefetch-recording pass**: the snapshot is resumed with the userfaultfd memory backend
and the offsets the guest faults on during a fresh resume are recorded until readiness succeeds
or a short deadline expires. The fault log is close to the answer being sought, so recording
costs little beyond the resumes themselves.

**One run is not the answer, because a single run is noisy.** Two resumes of the same snapshot do
not fault on the same set of pages: timer-driven work fires or does not, lazily initialised
structures are touched in a different order, address-space and hash randomisation move things,
and whatever the readiness probe happens to exercise varies. A list recorded from one run
therefore contains pages that only that run needed. The builder records **several runs and
intersects them**, which keeps the pages every resume needs and discards the incidental ones,
and it **keeps ordering** from the recorded sequence rather than sorting — the value of a
prefetch list is that it turns scattered faults into a sequential read, and sorting by offset
would optimise for the file layout instead of for what the guest asks for first. Ordering is
taken as the **average of a page's position across the runs it survived in**, not from whichever
run happened to be recorded first: the same noise that puts different pages in different runs
puts shared pages in different places, and one run's sequence is as arbitrary as one run's
membership.

**Each page is recorded with its access type**, read or write, taken from the fault that produced
it. Access type is intersected alongside membership, and a page recorded as written in any run is
recorded as written. This is not bookkeeping. A prefetcher that installs everything writable
**poisons the dirty set for the first pause** — pages the guest only reads become
indistinguishable from pages it wrote, and a mechanism that exists to make the sandbox start
faster makes its first pause larger. The consumer needs the access type to install read-recorded
pages write-protected, so the builder has to record it; nothing downstream can recover it.

Adjacent offsets of the same access type are coalesced into ranges under a gap threshold and
written into the manifest's `prefetch` block, **in file-offset space** as that block requires.
The threshold is a genuine tradeoff: too fine and the manifest bloats while the restore issues
many small reads; too coarse and the node prefetches pages no guest ever touches, paying I/O for
nothing.

**Prefetch installs race the fault path, so the consumer needs a protocol rather than a list.**
A prefetcher installing a range and a guest faulting on a page inside that range are concurrent
by design — that is the whole point of prefetching alongside a running guest — so an install can
find the page already populated, or can be told to retry. The rules that follow are unglamorous
and all of them are needed: an install reporting a page already present is a **success**, not an
error, because the fault path won the race and the outcome is the one wanted; a transient retry
code is retried a bounded number of times; and a prefetch install that ultimately fails **never
fails the restore**, because prefetch is an optimisation and a sandbox that starts slightly
slower is categorically better than one that does not start. A prefetcher written as "install
these ranges and check for errors" turns a benign race into a create failure whose frequency
scales with how well the prefetch is working.

The recording VMs are then destroyed, and nothing they did enters the artifact except the ranges.

The artifact is published through [artifact-store](artifact-store.md), manifest last.

## The guest kernel a template seals has an expiry date

This component chooses a guest kernel, boots it once, and captures it into a memory image where it
stays for as long as the template exists. The memory image *is* that kernel, mid-execution. Its
support window is therefore a property of the template rather than of any node, and support
windows end.

Upstream validates two or three guest kernel versions at a time, supports each for a minimum of
two years, and when a third is added deprecates the oldest and removes it in a following release
after its minimum end-of-support date (`references/firecracker-docs/kernel-policy.md:12-15`). The
dated fact is worth recording as a fact, because a policy on its own would not have prompted
anyone to check the table: **guest 6.1's minimum end of support is 2026-09-02**
(`references/firecracker-docs/kernel-policy.md:34-38`), which is five weeks after this document's
timestamp. The other validated version alongside it is 6.18, added in v1.16.1. Any template sealed
on 6.1 is a template whose kernel leaves support within the quarter.

What that means here is narrower and worse than "an old kernel". A sandbox restored from such a
template is running an unpatched kernel with hostile code inside it, which is the one combination
this platform exists to prevent, and **the only remedy is a rebuild**. A kernel that exists as a
captured memory image cannot be patched, cannot be upgraded in place, and has no node-side setting
that substitutes for either. [Snapshots](../architecture/snapshots.md#how-long-a-paused-snapshot-stays-restorable)
bounds a paused snapshot's restorable age by the support window of the VMM build its format
requires; this is the same argument on a different axis, and it binds harder. Keeping an
unsupported VMM build on a node is at least a decision somebody can make, priced in exposure. An
out-of-support guest kernel is not a decision at all — it is already inside every artifact built
on it, and the only operation that changes it is building a new one.

The obligation this places on the builder is to make the expiry **actionable rather than
discovered**, and most of the mechanism already exists: the `runtime` block records the guest
kernel identity on every artifact. What that identity has to be is a **version that resolves
against the support table**, not a digest alone — a digest tells an operator which bytes ran and
nothing about when they stop being supported, and an expiry nobody can query is an expiry
discovered by an auditor or by a CVE. With the version recorded, "which templates are on a kernel
leaving support this quarter" is a query against the artifact catalogue, answerable before the
date rather than after it.

Which version to build on is an operational decision and is deliberately not made in this
document, because it would be stale within two releases of being written. What is fixed is the
shape: the builder pins a guest kernel explicitly rather than accepting whatever a node happens to
carry, records the version it sealed, and a template whose kernel has left support is rebuilt
rather than tolerated. Kernel upgrades already invalidate the layer cache fleet-wide and are
therefore scheduled rather than incidental (see [cache keying](#cache-keying)), which means the
rebuild this section calls for is an event the pipeline is already designed to absorb.

## Cache keying

Each step's cache key is a content hash chaining the previous step's key with the step
definition and the step's inputs:

```
k₀ = H(base image digest ‖ guest kernel id ‖ unpacker version ‖ recipe format version)
kᵢ = H(kᵢ₋₁ ‖ canonical(stepᵢ) ‖ H(inputsᵢ))
```

The key resolves through an index from hash to artifact identifier — a table in PostgreSQL,
which is the source of truth, with the bytes living under the artifact ID in object storage.
A build begins by walking the chain and finding the longest cached prefix, materialising that
generation, and executing the remainder. Because each key incorporates its predecessor, a
miss at step *i* guarantees a miss at every subsequent step, so the lookup is a single walk
rather than a search.

**Materialising a cached generation is a flatten**, since generations are published as diffs. Its
source map names the objects that supply each block, and the builder assembles them into the
build VM's backing file before the VM starts — which is a fetch of the changed blocks rather than
of a whole filesystem image, and is the point of publishing diffs in the first place. The walk is
still a single walk: the map has already resolved the chain, so finding the longest cached prefix
does not mean fetching every generation that preceded it.

**Keying on a mutable name or tag is wrong, and the wrongness is silent.** A tag can be
re-pointed at different content at any time. A cache keyed on it answers the question
"something with this name exists", when the question actually being asked is "this exact
content was built". The two answers diverge the moment anything upstream is republished, and
the divergence surfaces as a build that succeeds while producing the wrong filesystem — no
error, no warning, just an environment that does not match its recipe. Hence: base images
enter the key as digests, and any input named by path enters as a hash of its contents.

What is in the key and what is deliberately not:

| In the key | Why |
|---|---|
| Base image digest, resolved per platform | The content the build starts from. This must be the digest of the resolved **image manifest**, never of a multi-architecture **index**: an index digest is one name for several different filesystems, so keying on it makes one cache entry answer for all of them and hands an `arm64` build the `amd64` result. The platform is therefore in the key implicitly, and correctly, because a per-platform digest already names exactly one filesystem. |
| Canonicalised step definition | Whitespace, key order, and defaults normalised so cosmetic edits do not miss. |
| Content hashes of the step's inputs | Files from the build context, and build arguments the step references. |
| Guest kernel identity | Steps execute against it, so it can change what they produce. |
| Unpacker and recipe format versions | Named semantics markers, bumped when output semantics change. |

| Not in the key | Why |
|---|---|
| Agent version | The agent is not in the layer (Phase 2), so including it would invalidate every entry on an agent release that changes no content. |
| Builder release version | Bumping on every deploy would empty the cache for no content change. Content-affecting behaviour is versioned explicitly instead. |
| Wall-clock time, build ID, tenant | Not properties of the content. |

Including the kernel identity means a kernel upgrade invalidates the layer cache fleet-wide.
That is accepted deliberately: the alternative is a cache that may return a filesystem produced
under a kernel whose behaviour differed from the one now in use. Kernel upgrades are rare and
scheduled, so the invalidation can be pre-warmed rather than discovered.

The key structure also gives tenants a real lever. A recipe that copies its entire source tree
before installing dependencies will miss its dependency step on every source edit, because the
copy's input hash changed. Ordering slow-changing inputs first is what makes the cache
effective, and the chaining is what makes that ordering matter.

## Build context

The tenant's files are uploaded before the build and stored **content-addressed in object
storage, under a prefix separate from published artifacts**.

Separation is structural, not organisational. Context blobs are inputs: they have no manifest,
are not restorable, and do not participate in the artifact lifecycle. Keeping them out of the
artifact prefix means the registry collector's rule — a prefix without a manifest after the
grace period was a failed upload and is removed — stays exactly that simple, and never has to
distinguish a context blob from a torn artifact.

Contexts are garbage-collected on a **shorter horizon** than artifacts, measured in hours to
days rather than indefinitely: a context is needed only while a build could still be retried
against it. Content addressing means repeated builds of an unchanged tree upload nothing, and
the context hash is a natural input to the cache key.

## Determinism

The builder does not promise bit-identical filesystems, and claiming otherwise would be
dishonest: recipe steps run arbitrary code that can read the clock, resolve names, fetch from
the network, and consume randomness. What is promised is narrower and useful:

- **The key is honest about everything observable.** Every input the builder can see is hashed
  into the key. When a key matches, the recorded result is reused rather than rebuilt, so
  reuse is self-consistent even where the underlying step is not reproducible.
- **The environment is normalised where normalising is free.** Fixed hostname, fixed guest
  addressing (see [networking](../architecture/networking.md)), a fixed source-date value
  exposed to steps, and a fresh namespace per step remove the cheapest sources of variance.
- **Network fetches inside steps are not fought.** A step that downloads from a mutable URL has
  a key that does not describe its content. This is documented rather than prevented; pinning
  is the tenant's decision, and a builder that tried to make arbitrary steps hermetic would
  break far more recipes than it fixed.

## Retry and resume

A failed build leaves its already-sealed generations in the cache and in the index, because
each was sealed at a caching boundary and is complete and valid on its own. A retry therefore
resumes at the first uncached step. There is no separate resume path — retry is just the cache
doing its normal job — which is exactly why it can be trusted.

The generation for the step that failed is never reused, because it was never sealed and
therefore never entered the index. **There is no such thing as a half-cached step.**

| Failure class | Examples | Policy |
|---|---|---|
| Transient | Registry 5xx or rate limiting, expired registry token, object storage unavailable, node preemption | Retried automatically with jittered backoff and a bounded attempt budget. A 429 honours `Retry-After` rather than applying our own schedule. |
| Deterministic | Step exited non-zero, readiness never succeeded, resolved image architecture did not match the requested platform, foreign layer encountered, manifest validation refused the result | Not retried. The same inputs produce the same failure, and retrying only delays the report. |
| Ambiguous | Build VM crashed, flush barrier timed out, seal failed, build filesystem exhausted by accumulated sealed generations | Retried once, then surfaced with the failing phase named. Exhaustion is here rather than under deterministic because it depends on what else the node was building. |

## Concurrency and failure model

A build is one task tree owning one build VM. Builds are concurrent with each other, bounded
at two levels:

- **Per organisation**, so one tenant's queue cannot consume the fleet's build capacity.
- **Per replica**, so a single node's KVM, NVMe bandwidth, and memory are not oversubscribed
  by co-scheduled builds.

A global limit alone would be insufficient: it bounds total load but permits one organisation
to occupy all of it and starve every other tenant behind an unordered queue.

**Ownership** is a lease on the build row in PostgreSQL, claimed by whichever replica accepts
the call and refreshed by heartbeat. Redis is not used for this, because ownership is
correctness and Redis is a rebuildable cache. If a replica dies, the lease expires and another
replica retries the build, resuming from cache.

Two replicas racing the same step is safe rather than merely unlikely. Both produce
content-equivalent generations under different artifact identifiers; the index insert is
first-writer-wins, and the loser's artifact is unreferenced and collected. No lock is needed
because the cache is content-keyed and artifacts are immutable.

On crash, nothing is published — publication is manifest-last and happens only at the end. On
startup the builder reclaims: VMs, namespaces, and staging files are matched against the lease
file, and anything unaccounted for is destroyed.

### Timeouts and cancellation

| Level | Bound |
|---|---|
| Step | Per-step timeout from the recipe, with a platform ceiling. |
| Phase | Separate deadline for readiness, applied to both warm-ups, since waiting for a service to come up is the work most likely to hang. |
| Build | Whole-build deadline, enforced regardless of per-step progress. |

Cancellation is honoured at step boundaries, and within a step by killing the step's process
group. It is **never honoured inside a seal**. The seal — barrier, reflink, index insert —
runs in a task that is not cancellable, because a cancellation delivered midway could leave
the guest filesystem frozen or the index pointing at a torn image. A cancellation arriving
during a seal is deferred until the seal completes, and the build then stops at that boundary
with the completed generation retained. A cancelled build still improves the next one.

All of these are enforced from the host side. The build VM cannot delay or veto its own
deadline, which is the same invariant that governs sandboxes.

## Interfaces

| Direction | Transport | Purpose |
|---|---|---|
| `control-plane` → builder | gRPC over mTLS with workload identity | Start, cancel, and query builds; tail logs. |
| Builder → `vm-steward` in build VMs | vsock, the [vm-protocol](vm-protocol.md) contract | Spawn steps, stream output, quiesce, freeze. |
| Builder → Firecracker | Unix socket, shared client library | VM lifecycle, device attach, snapshot. |
| Builder → object storage and PostgreSQL | [artifact-store](artifact-store.md) library and SQL | Artifacts, contexts, build rows, cache index. |

`control-plane` reaches the builder through an ordinary ClusterIP Service. This differs from
how it reaches `vm-host`, and the difference is principled: a sandbox lives on one specific
machine, so it must be addressed by node, whereas a build that has not started yet can run
anywhere, so any replica is a correct destination.

Registry credentials for private base images are passed per build, held in memory, redacted
from logs, and never written into an artifact or into a guest. The guest never needs them,
because the pull is a host-side digest-verified byte transfer.

## State owned

| State | Location | Lifetime |
|---|---|---|
| Build rows and leases | PostgreSQL | Retained with build history. |
| Cache key index | PostgreSQL | Until entries are pruned with their artifacts. |
| Build context blobs | Object storage, separate prefix | Short horizon; builder-owned collection. |
| Sealed `fs-layer` artifacts | Object storage | Ordinary artifact lifecycle. |
| Build logs | Durable sink, keyed by build | Retention policy per organisation. |
| In-flight disks, generations, VMs | Node NVMe and the node | Destroyed at build end or at startup reclamation. |

Aliases, artifact ownership, and quota rows are `control-plane`'s and are only read here.

## Observability

Build logs are streamed from the build VM through the ordinary process-output mechanism — no
build-specific channel exists — and are written to the durable sink first, with the live tail
served as a read of that sink. This ordering matters: a client reading slowly, or disconnecting
entirely, must never apply backpressure to the build VM. Logs are tenant data and are retained
with the build record rather than shipped into platform log aggregation, consistent with the
handling of sandbox output in [security](../architecture/security.md).

| Signal | Why it is worth an alert or a dashboard |
|---|---|
| Cache hit rate by step position | The most diagnostic number the component has. A recipe whose early steps never hit has an input missing from its key, or an input that genuinely changes every build. Distinguishing the two is the main tuning conversation with a tenant. |
| Build duration by phase | Locates regressions. A slowdown in Phase 1 is a registry or network problem; in Phase 3 it is the recipe; in Phase 5 it is the warm-up or the snapshot path, which is why the two are timed separately — Phase 5 is the expensive phase by design, so an undifferentiated figure for it reports nothing. |
| Seal latency and barrier duration | The only interval during which the build VM is stalled. Growth here usually means the reflink fallback is active. The diff comparison is deliberately outside this figure, since it runs against the reflink after the stall has ended. |
| Diff comparison duration and published bytes against image size | What layering actually saved on this build, and what it cost to find out. A ratio near one means the step rewrote most of the filesystem and the comparison bought nothing; a comparison duration that dominates the step it follows is the signal for asking whether write tracking under the build disk is worth having. |
| Build filesystem headroom during a build | Sealed generations diverge from the live disk as the build continues, so a long recipe's space consumption grows with its total write volume rather than with disk size. This is the metric that turns a confusing in-guest out-of-space failure into a capacity signal. |
| Queue depth and wait time per organisation | Distinguishes "builds are slow" from "builds are queued", which have opposite remedies. |
| Outcomes by failure class | A rising deterministic-failure rate is a product problem; a rising transient rate is an infrastructure problem. |
| Recorded prefetch range count and bytes | Feeds directly into cold-start p99 on the restore side. |

Traces carry a span per phase and per step, tagged with the cache key and whether it hit.

## Testing

| Test | What it protects |
|---|---|
| Golden cache keys | A recipe corpus with expected key sequences. Key stability is a compatibility surface: an unintended hashing change shows up as a fleet-wide cache miss, which is expensive and easy to miss in review. A deliberate format bump updates the goldens in the same commit. |
| Hostile archive corpus | Path traversal, absolute and looping symlinks, hardlinks escaping the root, device nodes, setuid bits, sparse-entry inflation, and compression bombs. Each must either produce a sanitised filesystem or fail the build, and none may affect the host. |
| Multi-architecture resolution | A tag resolving to an index; assert the build resolves with an explicit platform, and that an image whose config declares a different architecture from its index entry fails the build rather than being unpacked. |
| Sealed generations are diffs | Seal a recipe, then assert each published generation stores only the blocks that differ from its predecessor, that its source map tiles the image exactly, and that materialising the last generation reproduces the same filesystem a full image would. The saving is the point of the change, so a test that only checks correctness would pass on a builder that quietly published full images. |
| Long chains do not fan out | Seal a twenty-step recipe and assert that composition at seal time keeps the number of distinct sources any one generation names bounded, rather than growing with step position. Reads are unaffected either way, so this fails only as a materialisation that fetches from twenty objects. |
| Disk sizing | Assert the image is integrity-checked before and after the shrink, that the shrink actually reduces the published size, and that a recipe installing more than the base image's slack succeeds because the grow phase ran. |
| Step leakage | A step leaves a background process, a mount, a SysV semaphore, a hostname change, and a listening socket; the next step asserts it sees none of them. The last three are what a process-and-mount boundary alone lets through. |
| Flush barrier under load | Seal while the guest is writing continuously, then kill the VM immediately after the seal, mount the sealed image, and assert cleanliness and the step's output. This is the test that actually catches a missing barrier; a quiescent test will not. |
| Cache correctness, by filesystem | Build a recipe fresh, build it again from cache, and compare the resulting filesystems modulo declared non-determinism. A mismatch means an input is missing from the key. |
| **Cache correctness, by observed environment** | The same comparison for state that is *not* in the filesystem, forced by taking a cache hit at each step position in turn: what each step observes of tmpfs, `/run`, `/dev/shm`, sysctls, loaded modules, service state, namespace identity, and visible processes must match the fresh build. Called out separately because the filesystem comparison above structurally cannot catch this class, which is the one the single-build-VM design creates. |
| Build filesystem exhaustion | Run a long recipe whose steps write heavily, and assert the build fails with an attributable host-side error before the guest observes an out-of-space condition it cannot explain. |
| Template hygiene | Inspect a published template and assert no random seed, `machine-id`, SSH host key, or TLS private key survives, that `virtio-rng` is present in the recorded device set, and that the boot identifier is served by a bind mount rather than by the kernel's own read-only file. Asserted against the artifact rather than against the builder's intent, because the intent is what a cache hit skips. |
| The memory image is the capture VM's | Build a recipe whose steps leave a distinctive long-running process and a large page cache behind, restore the published template, and assert that neither is present and that the start command's process tree is. This is the assertion that fails if anyone short-circuits the cold boot to save a second warm-up — the one optimisation in this component that looks free and is not. |
| Kernel command line composition | Build a template whose recipe sets one unrelated boot argument, then assert the published artifact's recorded command line still carries `panic=1`, `reboot=k`, and `8250.nr_uarts=0`. The recipe value must be present too, so this fails both ways round. It is a separate test from the capture-VM row because the mechanism it guards is a merge rather than a setting, and because nothing we write mentions the three defaults it protects. |
| Guest kernel version is queryable | Assert the `runtime` block's guest kernel identity resolves to a version against the support table, not merely to a digest. The point of the field is answering "which templates expire this quarter" before the date rather than after it, and a digest-only identity passes every schema check while making that question unanswerable. |
| Capture VM invariants | Against the published artifact: hugepages off, a balloon device present with free page reporting on, and `CONFIG_MEMORY_BALLOON`, `CONFIG_VIRTIO_BALLOON` and `PAGE_REPORTING` in the recorded guest kernel configuration — the device and its driver together, since either alone is silent. Separately, that a capture never starts before the agent has answered its handshake — asserted by building a template whose recipe has no start command, which is the only shape that can reach the early-boot hazard. Grouped because all three are pre-boot or ordering properties that are permanent in the artifact and that no restore reports as its own cause. |
| Prefetch recording | Assert several runs are intersected rather than one being taken, that order is averaged across the surviving runs rather than lifted from one, that ranges are in file-offset space, that each range carries an access type and a page written in any run is recorded as written, and that an install colliding with a guest fault is treated as success. |
| Resume | Kill the builder mid-recipe; assert the retry resumes at the first uncached step and reaches the same result. |
| Concurrent identical builds | Two replicas building one recipe simultaneously; assert one index entry, one referenced artifact, and the other collected. |
| Manifest refusal | The produced manifest is validated by the same code that will read it, including the unknown-format-version refusal described in [artifact-store](artifact-store.md). |

Phases that need real hardware — boot, snapshot, prefetch recording — run in an integration
suite on the sandbox node pool. Everything above them is testable without KVM against a fake
registry serving fixed digests and the VM fakes shared with `vm-host`'s tests.

## Rules that must not be violated

1. **Never interpret image layer content on the host**, and never mount a filesystem the guest
   populated on the host. The host verifies digests and moves bytes; a guest does the parsing and
   every filesystem-level operation that follows.
2. **Never take `vm-init` or `vm-steward` from the image being built.** They come from the
   builder's initramfs, and cached layers stay inert.
3. **Never key the cache on a mutable name or tag, or on a multi-architecture index digest.**
   Resolve to a per-platform image digest first, and verify the resolved architecture.
4. **Never seal a generation without a completed flush barrier**, including the host-side
   `fsync`.
5. **Never let one step's residue reach the next step.** Fresh process, mount, PID, IPC, UTS,
   and network namespaces every time, plus the enumerated reset of state the root filesystem
   cannot hold.
6. **Never cancel inside a seal.** Defer to the boundary.
7. **Never capture a template without the hygiene phase having run**, and never implement
   hygiene as a recipe step, because a recipe step is skippable on a cache hit.
8. **Never snapshot the build VM.** The memory image is always a fresh cold boot of the finished
   filesystem, warmed by running the start command again. Capturing the build VM would skip a
   boot and a warm-up, and would bake every recipe step's residue into every sandbox forever.
   The warm-up is performed twice on purpose.
9. **Never capture with hugepages enabled, or without a balloon carrying free page reporting.**
   Both are pre-boot properties of the capture VM that the snapshot carries, so both follow the
   template to every node forever and neither can be corrected afterwards. The balloon is the
   general case: every option it has is fixed before boot, and the runtime owns only its target.
10. **Never pass a recipe's boot arguments through as the kernel command line.** Supplying them
    replaces the VMM's defaults wholesale, and three of those defaults are load-bearing for us
    without appearing anywhere in our own configuration. Compose; never substitute.
11. **Never capture before the guest kernel has finished booting.** The generation-identifier
    interrupt is injected before the vCPUs run, and a half-booted kernel crashes on it — a
    template that publishes cleanly and fails in every sandbox created from it. Wait on the
    agent's handshake, not on the recipe having been slow.
12. **Never record an incomplete `runtime` block.** A field the builder omits is a check that
    silently stops happening, and the hypervisor does not perform it either. The guest kernel
    identity additionally carries a version and not only a digest, because it is the field a
    support expiry is queried against.
13. **Never publish a template unless every phase succeeded**, readiness included.
14. **Never write tenant credentials or build context into a published artifact or a log.**
15. **Never let a build VM veto its own deadline.**
16. **Never write artifact bytes except through [artifact-store](artifact-store.md).**
