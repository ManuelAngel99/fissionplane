---
type: Architecture
title: System overview
description: The component map, the four planes, lifecycle and request flows, and how fissionplane is deployed into a shared Kubernetes cluster.
tags: [architecture, overview, kubernetes, topology]
timestamp: 2026-07-27T07:33:00Z
---

# System overview

fissionplane turns a pool of Kubernetes nodes into a fleet of Firecracker microVMs that can be
created, driven, paused, and resumed through an API. This document defines the components,
what each is responsible for, how they interact, and how the whole thing installs into a
cluster that is already running unrelated workloads.

## Product surface

A tenant can:

- Create a sandbox from a template, in a few hundred milliseconds on a warm node.
- Run processes inside it, with a PTY, streaming stdout and stderr, signals, and stdin.
- Read, write, upload, download, and watch files.
- Publish a guest port at `https://<port>-<sandbox-id>.<domain>`.
- Pause a sandbox to durable storage and resume it later with its processes still running.
- Build custom templates from an OCI image plus a recipe.

## The four planes

The system separates concerns by *plane*, and the separation is load-bearing: a failure in one
plane must not take down the others.

```
                          ┌──────────────────────────────────────────┐
   tenant SDK / browser   │            CONTROL PLANE                 │
            │             │  control-plane (Deployment, N replicas)  │
            │  REST       │  admission · placement · catalog ·       │
            ├────────────►│  templates · token minting               │
            │             └───────────────┬──────────────────────────┘
            │                             │ gRPC (control-plane dials)
            │  HTTPS                      │
            ▼                             ▼
   ┌──────────────────┐        ┌──────────────────────────────────────┐
   │   EDGE PLANE     │        │            NODE PLANE                │
   │  gateway         │───────►│  vm-host (privileged DaemonSet)      │
   │  TLS · routing   │  mTLS  │  FC lifecycle · snapshots · netns ·   │
   │  token check     │        │  artifact cache · sandbox API        │
   └──────────────────┘        └───────────────┬──────────────────────┘
                                               │ vsock
                                               ▼
                                 ┌──────────────────────────────────┐
                                 │           GUEST PLANE            │
                                 │  vm-init (PID 1)                 │
                                 │   └─ vm-steward                  │
                                 │        └─ tenant processes       │
                                 └──────────────────────────────────┘
```

**Control plane** decides *what should exist* and *where*. It is off the data path entirely: if
every `control-plane` replica is down, running sandboxes keep serving traffic and only
lifecycle operations stop. The property is bounded by the maximum sandbox lease, because
deadlines are enforced on the node and extended only from here — a node whose control link is
down suspends enforcement, and past the suppression bound resumes it. See
[control-plane](../components/control-plane.md) for the mechanism.

**Edge plane** turns a public hostname into a connection to the right node. Stateless and
horizontally scalable.

**Node plane** owns everything about the microVMs on one machine. `vm-host` is the only
component with host privileges and the only one that talks to Firecracker.

**Guest plane** is inside the isolation boundary and is assumed hostile.

## Components and responsibilities

| Component | Responsibility | Explicitly not responsible for |
|---|---|---|
| [control-plane](../components/control-plane.md) | Authenticate callers, enforce quotas, choose a node, record sandboxes and public-port exposure in PostgreSQL, mint capability tokens, own the template registry. | Proxying traffic. Touching Firecracker. Being on the data path. |
| [gateway](../components/gateway.md) | Terminate TLS, parse the sandbox subdomain, check explicit public exposure or private credentials, and proxy to the owning node including WebSocket upgrades. | Business logic. Knowing anything about templates or quotas. Observing whether a sandbox is idle. |
| [vm-host](../components/vm-host.md) | Create, pause, resume, and destroy sandboxes. Manage per-sandbox networking, cgroups, and disks. Serve the sandbox API by translating to `vm-steward`, stripping credentials before the guest. Report per-sandbox capacity, usage, and traffic liveness. Own the node artifact cache. | Deciding *which* node a sandbox runs on. Storing durable state. |
| [template-builder](../components/template-builder.md) | Convert an OCI image plus a recipe into a bootable template artifact, with hash-keyed layer caching. | Serving traffic. Running tenant sandboxes. |
| [artifact-store](../components/artifact-store.md) | Define the manifest format; move artifacts between object storage and node NVMe; evict. | Deciding what to cache. That is placement's job. |
| [vm-init](../components/vm-init.md) | Be PID 1 in the guest: mounts, zombie reaping, supervise `vm-steward`, never exit. | Anything else. It is deliberately ~400 lines. |
| [vm-steward](../components/vm-steward.md) | Execute inside the guest: spawn processes with PTY, stream I/O, filesystem operations, inotify, localhost port relay, and the post-restore lifecycle hook. | Authentication. Public API shape. Anything not requiring a guest syscall. |

Supporting libraries — the [vm-protocol](../components/vm-protocol.md) contract, the
Firecracker client, per-sandbox networking, snapshot sequencing, capability tokens, telemetry,
and the test fakes — are described inside the component that owns them.

## Lifecycle flows

### Create

1. Tenant calls `POST /sandboxes` on `control-plane`.
2. `control-plane` authenticates, checks quota, and resolves the template alias to a concrete
   artifact ID.
3. **Placement** first applies the hard compatibility filter. Upstream requires an identical
   hardware and software configuration for a restore and does not recommend crossing host kernel
   versions in production, so host CPU model and host kernel are both filtered on — the filter is
   ours to relax only against measurements we have not taken. Placement then prefers nodes that
   already hold the artifact, draws a small random sample of
   the survivors, and takes the best of that sample by a score over CPU, memory, sandbox count, and
   creates already in flight. Sampling before scoring, rather than randomising among a fleet-wide
   top few, is what stops replicas stampeding the same node as the fleet grows. The VMM version is
   deliberately *not* a filter: nodes carry several builds and the artifact names the one it needs,
   so a restore selects a binary rather than restricting the node set. Filtering on it would strand
   paused sandboxes for the duration of every rolling upgrade, which is the most common way the
   compatibility constraint is met in the first place.
4. `control-plane` **writes the sandbox row in `creating`**, with the chosen node, and only then
   calls `CreateSandbox` on that `vm-host`.
5. `vm-host` allocates a network slot, materialises the disk, restores the VM (see
   [snapshots](snapshots.md) for cold versus warm paths), and waits for `vm-steward` to answer.
6. `vm-host` returns success. `control-plane` moves the row to `running` and publishes it to the
   routing cache.
7. The tenant receives the sandbox ID, its hostname, and a capability token.

The row is written **before** the node is called, and the ordering is worth more than it looks.
With it, "a sandbox the node reports that has no row" is unambiguously an orphan and is destroyed
on sight, and a row stuck in `creating` past the cold-create bound is a failed create. Written
after, neither statement is decidable: the only way to tell an orphan from a create still in
flight is a grace period longer than the slowest create in the system, whose failure mode is
destroying live sandboxes, preferentially on cold nodes, which is to say preferentially during the
traffic spike that caused the fleet to scale out.

If the node rejects, `control-plane` retries elsewhere, and the two refusal classes are handled
differently: *resource exhausted* deprioritises the node without spending the retry budget, since
a busy fleet answering honestly is the expected case, while a hard failure excludes it and costs
one of a bounded budget. A wall-clock create deadline, derived from the caller's own timeout, is
what bounds the exhaustion loop. The node — not the control plane — is the authority on its own
capacity, so replicas never need to lock against each other.

### Pause

1. `control-plane` calls `PauseSandbox`.
2. `vm-host` sends `PrePause`, and **the guest does the quiescing**. `vm-steward` stops accepting
   work, flushes its buffers, freezes the tenant cgroup, and **waits for the kernel to confirm the
   freeze** before acknowledging. Both halves matter. The cgroup lives in the guest's own
   hierarchy, so the host drives the operation rather than performing it; and freezing is
   asynchronous, so a write with no confirmation is not a barrier and every later step assumes
   tenant code has actually stopped.
3. **The guest filesystem is not frozen.** Freeze state lives in the guest superblock, which is
   guest memory, so freezing before a memory capture bakes a frozen root filesystem into the
   artifact and every sandbox ever restored from it blocks on its first write to disk. Filesystem
   freeze is reserved for artifacts that capture no memory.
4. Firecracker pauses the VM and writes memory and device state to node NVMe.
5. `vm-host` releases the sandbox's runtime resources and uploads the artifact in the
   background, manifest last.
6. The sandbox leaves the routing cache; its PostgreSQL row moves to `paused`.

The tenant-cgroup freeze is deliberately captured *into* the artifact, which is what guarantees no
tenant instruction runs between a restore and the post-restore hook.
[Snapshots](snapshots.md) carries the full sequence, its abort paths, and the reclaim pass that
runs before the freeze.

### Resume

Identical to create, except placement prefers the node that produced the snapshot, since that
node's cache almost certainly still holds it — subject to the same compatibility filter as any
other restore. After restore, `vm-host` sends the post-restore hook, and its order is
load-bearing: the guest clock is corrected, entropy is reseeded and machine identity regenerated,
the environment is re-applied, and **only then** is the tenant cgroup thawed. Everything that must
not be observed by tenant code has to happen before that last step, because the thaw is what lets
tenant code run at all. Any host-held state from before the pause is gone — the new sandbox
instance gets a new epoch, and stale tokens referencing the old epoch fail closed.

### Destroy

`control-plane` calls `DeleteSandbox`; `vm-host` kills the VM, tears down the cgroup and
network slot, releases cache pins, and removes the routing entry. Deadline expiry is enforced
by `vm-host` from outside the guest, so a hung or hostile sandbox cannot outlive its lease.

## Request path

```
client
  │ https://3000-abc123.sandboxes.example.com
  ▼
cloud load balancer  ──►  gateway
                            │ parse Host → (port 3000, sandbox abc123)
                            │ read the per-port exposure record
                            │ public: admit anonymously
                            │ private/default: verify capability token or cookie
                            │ resolve sandbox → node (cached; PostgreSQL is truth)
                            │ forward the credential when one was required
                            ▼
                          vm-host on the owning node   (mutually authenticated hop)
                            │ public: verify the active exposure record
                            │ private/default: verify token, epoch, and scope
                            │ strip any platform credential
                            ▼
                          sandbox: guest port 3000 via vm-steward's relay
```

Three properties matter. The destination is encoded in the hostname, so `gateway` is stateless and
replicable. `vm-host` re-verifies rather than trusting the edge, so a routing mistake cannot become
an authorization bypass. Private traffic follows **verify twice, strip once**: the edge
forwards it, because the node's check is the authoritative one and it cannot verify a credential it
never receives, and the node removes it before anything reaches the guest, because the guest is
hostile and a forwarded token is a token handed to it. The edge check is a filter that keeps
forged and expired credentials off the node; the node check is the one that decides. Since that
middle hop now carries a bearer credential, it is mutually authenticated rather than plain traffic
on the host network. Public traffic has no client credential: both hops instead check the explicit
`public` exposure record for that exact sandbox and tenant port. The agent port is reserved and
can never receive such a record.

## Control connectivity

`control-plane` **dials** `vm-host`, not the other way around. Commands are ordinary unary RPCs
multiplexed over one persistent connection per replica per node; a single server-streaming call in
the other direction carries node state — capacity, cache warmth, sandbox inventory, per-sandbox
traffic liveness, and full state on connect.

The split matters because the two directions have different needs. gRPC already gives the command
path request-response correlation, per-command deadlines, cancellation propagation, backpressure,
and a status taxonomy; carrying commands on a bidirectional stream means reimplementing all five
by hand, which is a protocol we would then own. Node state genuinely wants push — a control plane
that polls learns about capacity late and cannot tell a quiet node from an absent one — and one
subscription supplies that, along with the link-liveness signal that deadline suppression keys on.

Dialling outward is what makes multiple control-plane replicas work. Every replica watches the
`vm-host` DaemonSet through the Kubernetes API, keyed by node name, and holds its own
connection to every node. There is no connection ownership, no shared bus, and no failover
dance. Node readiness is the Kubernetes readiness probe — `vm-host` reports unready until its
cache is warm enough to serve — so no bespoke registration protocol exists.

The alternative, having nodes dial in, is only necessary when nodes cannot be addressed, which
inside a single cluster they can. Should the product later support nodes outside the cluster,
the node transport is behind an interface and the direction can be inverted then.

## State and storage

| Store | Contains | Consistency role |
|---|---|---|
| **PostgreSQL** | Organisations, quotas, templates, artifacts, sandboxes, port exposures, paused snapshots, API keys. | Source of truth. |
| **Redis** | Sandbox routing and active public-port view, rate limits, short-lived locks. | Rebuildable cache. Never authoritative. |
| **Object storage** (S3-compatible) | Every artifact: templates, snapshots, filesystem layers. | Durable truth for artifacts. |
| **Node NVMe** | LRU cache of artifacts, plus per-sandbox writable disks. | Disposable. A cold node is slow, not broken. |

Because Redis is only a cache, a reconciler rebuilds it from PostgreSQL, and a metric counts
repairs. In steady state that metric reads zero; if it does not, something upstream is wrong.

## Kubernetes deployment

One Helm chart. No CRDs, no operator, no mutating webhooks, and no cluster-wide configuration
changes.

**Read this section knowing that nothing outside this installation validates it.** Every
comparable system runs its node component outside Kubernetes — as a bare host process under
another scheduler, or as a root service on the machine — so there is no prior art for a privileged
DaemonSet owning microVMs, and the claims below about mount propagation, host PID namespaces,
eviction, and autoscaler behaviour rest on reasoning rather than on anyone else's operational
experience. That is a different and more tractable risk than being wrong, but it is a real one,
and it is why `vm-host` verifies each of these properties at startup instead of assuming them.

| Workload | Kind | Placement |
|---|---|---|
| `vm-host` | DaemonSet, privileged, `hostNetwork`, `hostPID` | Sandbox node pool only |
| `template-builder` | Deployment, same privileges | Sandbox node pool (it boots real VMs) |
| `control-plane` | Deployment + HPA | Ordinary nodes |
| `gateway` | Deployment + HPA, `Service type=LoadBalancer` | Ordinary nodes |

### Coexisting with other microservices

This is a hard requirement, and it shapes several decisions.

- **Privilege is confined to one node pool and one namespace.** The sandbox node pool is
  labelled and tainted, so no other workload is *scheduled* there — with the exception of
  cluster-level DaemonSets that tolerate every taint, which land on these nodes like any other and
  which [security](security.md) accounts for. Only that namespace carries the `privileged` Pod
  Security Admission label; the rest of the installation runs Restricted.
- **Surviving a daemon restart takes three separate mechanisms, not one.** A restarting container
  kills the processes inside it three different ways, and defeating only the famous one leaves
  the sandboxes just as dead.

  | Mechanism | What it kills | What answers it |
  |---|---|---|
  | The container's PID namespace is torn down, and the kernel kills every process in a namespace whose init has died | Every VMM on the node | `hostPID`, which is therefore a correctness requirement and not a convenience |
  | The container runtime kills every process in the container's control group | Every VMM on the node | Firecracker processes are placed in a cgroup **outside** the pod's subtree — at least as load-bearing as `hostPID`, and much easier to forget |
  | The runtime tears down the container's mount namespace and root filesystem | Anything still reading from the container image | Host-path volumes, below |

  The third has a consequence nothing else in this bundle states: **the VMM binary, the jail
  roots, and the snapshot and memory files must live on host-path volumes rather than inside the
  container image.** A resumed VM keeps its memory file mapped for its entire lifetime, and an
  image layer that gets unmounted underneath a live mapping is not a degradation — the next guest
  access to those pages takes a bus error and takes the sandbox with it. The same reasoning covers
  the binary and the chroot: a running VMM must not depend on any filesystem that disappears when
  its pod does.

  It also has a fourth consequence, which is a volume in its own right and the reason the pod is
  privileged at all. **Per-sandbox network namespaces are bind-mounted into the host's namespace
  directory**, and that directory is a host-path volume mounted with bidirectional propagation so
  the bind mounts outlive the pod. Propagation is a per-mount setting and is *not* implied by
  running privileged; a chart that sets the privilege and omits the field produces namespaces that
  live only in the container's mount namespace and evaporate on the next restart, silently
  removing the survival property this whole section is about. The same applies to anything the
  init container mounts. `vm-host` verifies propagation at startup by making a bind mount and
  confirming it is visible from outside, rather than assuming it.
- **No per-sandbox Kubernetes objects.** Sandboxes churn far too fast to be Ingresses, Services,
  or custom resources; the routing table lives in our own datastore. This keeps our load off
  the API server and etcd, which other tenants of the cluster share.
- **Sandbox network CIDRs must not overlap** the cluster pod or service CIDRs, and our nftables
  rules live in a dedicated, uniquely named table so they neither collide with nor are flushed
  by the CNI. This is the highest-risk integration point and is covered in
  [networking](networking.md).
- **`vm-host` holds no Kubernetes write permission.** Its service account reads; it never patches
  a node, a pod, or anything else. This is what keeps the blast-radius argument honest, because
  the permission it would otherwise want — writing node annotations — has no per-object scoping
  available and therefore means writing *every* node in the cluster. The annotation it wanted is
  static and belongs on the node pool at install time. [Security](security.md) has the reasoning.
- **Node-level state is mostly a property of the machine image**, with an init container of the
  `vm-host` pod handling the idempotent, runtime-settable remainder. `vm-host` verifies all of it
  at startup and stays unready with a named reason if anything is missing, so a half-prepared node
  never receives traffic. The list is longer than "kernel modules and a few sysctls" and is set
  out [below](#node-preparation).

### The sandbox node pool does not scale in

A node running fifty VMs contains a single pod and looks idle. The instinct is to reach for an
annotation that blocks scale-down, and that instinct is what the rest of this section exists to
talk you out of, because the annotation defends the case least likely to arise and not the ones
that are.

**The documented default is that the sandbox node pool is scale-out only.** Both comparable
systems reached the same place — one configures its worker pool so the autoscaler is structurally
incapable of removing a node, the other runs a fixed-size group with its minimum equal to its
maximum. Neither built a mechanism for gracefully removing a node full of live VMs, because the
mechanism does not survive contact with the ways nodes actually disappear.

Two things reinforce that default, in this order.

**Accurate resource requests come first, and not for scaling reasons.** `vm-host` has to request
the capacity it hands out to VMs regardless of any autoscaler, because the kubelet cannot see
sandboxes at all and will otherwise schedule other pods into memory the VMs are already using.
That is a correctness failure long before it is a scaling one. A node whose requests reflect its
VMs happens also to sit above the utilisation threshold, so getting this right buys scale-down
protection as a side effect of being correct — which is a better reason to do it than the
protection itself.

**The annotation is a third line, not a first.** It is vendor-specific, with no portable spelling,
so the chart writes whichever one the cluster's autoscaler understands and a cluster running
neither gets nothing. In provisioner-style autoscalers its counterpart blocks voluntary
consolidation only, so node expiry, spot interruption, and repair of an unhealthy node all proceed
regardless — and those are not rare. Because it is static, it belongs on the node pool at install
time rather than being written at runtime by a privileged daemon, which is what lets `vm-host`
hold no Kubernetes write permission at all (see [security](security.md)).

### The drain hook is best-effort, and cannot be anything else

`vm-host` snapshots its sandboxes on `preStop`. It is worth having for rollouts and for
operator-initiated maintenance, and it is **not** a data-durability mechanism. Three facts make
that unavoidable rather than pessimistic.

The hook must finish inside the pod's termination grace period, whose default is thirty seconds; a
full snapshot writes all of guest memory synchronously, and a node's worth of multi-gigabyte VMs
does not fit, not marginally and not with tuning. The grace period is therefore configured
explicitly rather than inherited, bounded above by what the cluster's own node-deletion paths will
wait for. On the most common scale-down path — a node holding only DaemonSet pods, and therefore
treated as empty — **DaemonSet pods are not gracefully evicted at all.** The node is deleted, the
hook never runs, and no budget would have helped. And a manual drain ignores DaemonSet pods by
default, so it does not run there either.

What the hook does when it runs:

- **Sandboxes are captured smallest-memory-first**, which maximises the number saved per second of
  a budget that will not cover all of them. Any pause already in flight finishes first.
- **A sandbox still running on the demand-paged restore path is not attempted.** Pausing one drags
  its entire memory image back across the network before the first byte of artifact is written
  (see [snapshots](snapshots.md)), which cannot fit in any drain budget worth setting.
- **In-flight snapshot uploads are waited for before the process exits.** A pause that completed
  locally but has not finished uploading is a sandbox the tenant believes is safe, and it dies with
  the node unless the shutdown path waits.
- **Everything not captured is reported lost, with cause.** Those sandboxes are terminated and
  marked failed-by-node-drain rather than paused, so a tenant sees why their sandbox ended instead
  of finding a paused sandbox that never resumes.

### There is no pod disruption budget, and one would not help

A manual node drain **ignores DaemonSet pods by default** — it refuses to proceed until told to
ignore them, and then does not evict them. Our pod is never asked to stop, so the `preStop` path
never runs and an operator draining a node for maintenance destroys every sandbox on it while
believing they drained it safely. A pod disruption budget does not change this, because the drain
path is not evicting our pods in the first place.

The answer is procedural and belongs in the runbook rather than the chart: **node maintenance goes
through our own drain command**, which asks `control-plane` to stop placing on the node and to
pause its sandboxes through the ordinary API, and only then hands the node to `kubectl drain`.

### Node preparation

"Kernel modules, sysctls, the cgroup root, the NVMe mount" understates this considerably. The
list below is the actual surface, and its defining property is that almost every item fails
*silently* — as reduced density, slower restores, or a latency regression that is uniform across
the node and therefore attributable to nothing.

Every row carries a **class**, because the two classes are delivered by different things and
confusing them is how a node ends up half-prepared:

- **Image** — the machine image or a boot-time unit the image owns. Kernel command-line parameters
  and anything that only works on a freshly booted machine are here by necessity, not preference.
- **Init** — the `vm-host` pod's init container, which reruns on every pod restart and must
  therefore be idempotent.

`vm-host` verifies every row at startup and stays unready with a named reason if one is missing,
and the reason states the class — so an operator is told "your node image is wrong" rather than
"something is missing".

| Item | Class | Why it is on the list |
|---|---|---|
| Hardware virtualisation | Image | The pool must be bare metal or have nested virtualisation enabled. This is first on the list because it is the likeliest reason an installation fails on day one, and because it presents as "sandbox creation fails" rather than as anything about the nodes. `vm-host` asserts it and refuses readiness otherwise. |
| A supported host kernel, and one at a time | Image | Upstream validates at least two host and guest versions at any time, each for a minimum of two years, deprecating the oldest when a third is added (`references/firecracker-docs/kernel-policy.md:12-15`), and a restore expects an identical configuration. Two consequences follow and neither is optional. **A kernel upgrade partitions the fleet**, because paused snapshots taken before it will not place onto nodes after it — so an upgrade is a planned migration with a drain, not a rolling patch. And a version whose support has lapsed is a node running hostile code on an unpatched kernel, which sets an outer bound on how long that migration can be deferred. The guest kernel is the same argument on the other side of the boundary and binds harder, because it is sealed into artifacts rather than installed on machines; [template-builder](../components/template-builder.md) owns it. |
| Memory-map count | Init | `vm-host` holds mappings for every sandbox it serves, and the default limit is low enough to bind at the densities we are targeting. |
| File-descriptor limits | Image | Both the system-wide maximum and the daemon's own soft limit. Each sandbox costs descriptors for its control channel, tap, memory file, disk, fault handler, and every relayed connection. **The jailer applies its own limit to the process it launches, and its default is low** — and upstream documents that default as 2048 in one place (`references/firecracker-docs/jailer.md:125-126`) and 4096 in another (`references/firecracker-docs/prod-host-setup.md:135-140`), which settles the question of whether to rely on it. We pass it explicitly. |
| Huge page pre-allocation | Image | Only reliably succeeds on a freshly booted node, before memory fragments, which is precisely why it cannot live in a container that reruns on every pod restart. |
| Microcode loaded early in boot | Image | A boot-order property, and upstream puts host microcode alongside the kernels as a precondition for workload isolation (`references/firecracker-docs/prod-host-setup.md:4`, `references/firecracker-docs/prod-host-setup.md:301-306`). Several of the isolation guarantees in [security](security.md) assume it is current. |
| Simultaneous multithreading disabled | Image | A boot parameter. Upstream recommends it for production because multithreading is frequently a precondition for speculative-execution attacks (`references/firecracker-docs/prod-host-setup.md:327-333`). See [security](security.md) for why it is not optional on a node running hostile code. |
| A quiet host console | Image | Kernel command line. Console logging on the boot path is synchronous against a slow device, and the cost is not marginal: adding one console argument degraded restore from 3 ms to 8.5 ms, because creating the tap device generated host kernel logs that were slow to write (`references/firecracker-docs/prod-host-setup.md:58`, `references/firecracker-docs/prod-host-setup.md:62-67`). That measurement is from aarch64 and the number will differ here; the mechanism does not. Quieting it is free and costs multiples of the restore budget if forgotten. |
| The userfaultfd device | Init | On current kernels the fault handler obtains its descriptor through `/dev/userfaultfd`, governed by filesystem permissions, and the jailer makes it available inside the jail when present (`references/firecracker-docs/snapshotting/handling-page-faults-on-snapshot-resume.md:34-37`). The node must expose it and permit the daemon to use it. Without it every cold restore fails, which at least fails loudly. |
| The cgroup hierarchy mount option | Image | The option favouring dynamic modification (`favordynmods`). Host-wide, and on older hierarchies settable only at boot. Presents as uniformly slower creates with no failures anywhere. |
| Virtualisation module parameters | Image | Set at module load, so `/etc/modprobe.d` rather than a running system (`references/firecracker-docs/prod-host-setup.md:197-203`). `kvm.min_timer_period_us` bounds how often a guest can provoke the timer thread named below. The huge-page setting that addresses the same VM-setup regression is **conditional** — see the warning under this table. |
| Same-page merging disabled | Image | Upstream recommends disabling it (`references/firecracker-docs/prod-host-setup.md:335-341`), and on a node packed with mutually hostile tenants deduplicating identical pages across processes is a cross-tenant side channel offered voluntarily. It costs us no density, because sandboxes from one template already share memory through the page cache rather than through content scanning. |
| Swap | Image | Disabled, which is also upstream's recommendation and for our reason — it mitigates the data-remanence problem of guest memory reaching storage (`references/firecracker-docs/prod-host-setup.md:274-278`). See below; the cost has to be accepted rather than inherited. |
| Writeback thresholds | Init | A snapshot is a large synchronous write. Default dirty-page ratios turn one pause into an I/O stall for every other sandbox on the node. |
| Socket backlog limits | Init | Listen backlog, connection-request backlog, and device backlog. Gateway fan-in for a whole node's published ports lands on one daemon. |
| Connection-tracking maximum and bucket count | Init | Both, together. Raising the maximum alone lengthens hash chains instead of adding capacity — see [networking](networking.md). |
| Neighbour-table thresholds | Init | Raised from their defaults; each slot contributes an interface in the root namespace. |
| The NVMe mount and the cgroup root | Init | Both must be visible to the main container after the init container exits, which is a mount-propagation property and not a given. `vm-host` verifies propagation itself rather than assuming it. |
| A staging area for snapshot work | Init | Pause writes a full memory image before anything is uploaded; giving it a dedicated area keeps that traffic off the artifact cache's accounting. |
| The VMM binary and guest kernel | Image | Delivered on a host path, with their digests pinned in the chart and verified by `vm-host` before it reports ready. **The jailer treats every one of its inputs as trusted**, and names the operator invoking it as part of the trusted computing base (`references/firecracker-docs/jailer.md:266-270`) — not only the executable it runs but also the network-namespace path it joins — so nothing downstream checks either, and a wrong path is a sandbox in somebody else's namespace rather than an error. See [security](security.md). |
| The guest template's file-watch limits | — | Not a node setting at all: the file-watch API is a product feature, the guest defaults are low, and the limit has to be raised in the template because it cannot be changed from outside the guest afterwards. |

**One row is conditional, and applying it blindly removes a CPU vulnerability mitigation.** The
huge-page module setting is permitted **only where the host reports itself unaffected** by the
iTLB multihit erratum: upstream's instruction is to read
`/sys/devices/system/cpu/vulnerabilities/itlb_multihit`, apply it only if that says `Not affected`,
and otherwise apply the mount option alone (`references/firecracker-docs/prod-host-setup.md:425-429`).
On a machine that *is* affected, the setting disables
an active mitigation, which is the worst possible thing to do on a node whose whole purpose is
running hostile code. Where it cannot be applied, the mount option above is the only remedy
available and the slower creates are simply paid. The node image checks the verdict rather than
setting the parameter unconditionally, and `vm-host` reports which of the two arrangements it
found, because otherwise a fleet silently splits into fast nodes and safe nodes with nothing
naming the difference.

**One item is on neither list, and it is a hole in the isolation story rather than a tuning knob.**
On x86 a guest that injects timer interrupts drives a `kvm-pit` kernel thread — named for the
hypervisor process it serves — that by default lives in the root cgroup, so it spends host CPU
*outside* the sandbox's own limits, defeating a layer [security](security.md) lists as
load-bearing. Upstream's own remedy is an external agent moving the thread after guest start
(`references/firecracker-docs/prod-host-setup.md:177-198`), because Firecracker cannot: it has
dropped privilege by then. The timer-period parameter above raises the floor
on how often it can be provoked; moving the thread into the sandbox's cgroup after the guest starts
is a step in `vm-host`'s create path, because the thread does not exist until then. It is not the
only member of its class — see [security](security.md) for the block-engine workers, which cannot
be moved at all.

**Swap is disabled on sandbox nodes, and this is a choice with a cost.** The two pieces of
guidance conflict: swap makes memory pressure degrade rather than kill, which is attractive on a
node deliberately packed with large memory images, while guest memory paged to host swap is
tenant data written to a disk we did not intend to write it to and did not intend to leave it on.
Remanence wins — a sandbox that dies loudly is recoverable and a guest's memory on disk after the
guest is gone is not — and the consequence has to be accepted explicitly: memory pressure on these
nodes is fatal to something, so headroom is reserved and the daemon's resource requests must
reflect what it truly uses.

**The conflict this table used to record is now resolved, in favour of the machine image.** An
init container reruns on every pod restart, while a good deal of preparation is meaningful only
once per boot — and, worse, three items above are kernel command-line parameters that no container
can apply at all. Huge page pre-allocation is the clean example of the first kind: allocation
succeeds on a freshly booted node and degrades as memory fragments, so an init container running
after an hour of uptime cannot deliver it. Since the Image class turns out to hold the majority of
the list rather than a corner of it, the honest arrangement is that **node preparation is a
property of the machine image, and the init container handles only what is idempotent and
runtime-settable.** The cost is that the chart no longer prepares a node on its own, and an
installation on unprepared nodes fails at readiness with a clear reason instead of degrading
quietly — which is the better failure.

## Failure behaviour

| Failure | Effect |
|---|---|
| A `control-plane` replica dies | Others continue. Sandbox traffic unaffected. |
| All of `control-plane` is down, for less than the maximum lease | Running sandboxes keep serving. No creates, pauses, or deletes. Nodes suspend deadline enforcement, so nothing is killed for a lease nobody could renew. |
| All of `control-plane` is down, for longer than the maximum lease | Sandboxes do stop. Deadline suppression is bounded, and past that bound nodes resume enforcement. |
| A `gateway` replica dies | Load balancer routes elsewhere. Existing connections drop and reconnect. |
| Redis is lost | Routing falls back to PostgreSQL and the cache refills. Latency rises. |
| `vm-host` crashes | Sandboxes survive, thanks to `hostPID`, out-of-pod cgroups, and host-path volumes for everything a running VM still maps. The restarted daemon re-adopts them by enumerating their cgroups. No comparable system survives this — the usual answer is to kill every VM on the node at startup — so it is the least corroborated property here and the one to prove first. |
| A node is lost | Its running sandboxes are lost. Paused snapshots are safe in object storage. |
| An autoscaler removes a node | On the empty-node path our pod is not gracefully evicted, so `preStop` never runs and the sandboxes are lost without being snapshotted. The defence is that the pool does not scale in, backed by accurate resource requests; the annotation is a third line. |
| An operator drains a node | DaemonSet pods are not evicted by drain, so `preStop` never runs. Node maintenance must go through our own drain command instead. |
| Object storage is unavailable | Warm-cache creates still work; cold ones fail. Pauses queue and retry. |

## Out of scope for the first release

Recorded so nobody has to guess whether an omission is deliberate:

- Peer-to-peer artifact transfer between nodes. Warmth-aware placement covers most of the
  benefit; revisit if measurements demand it.
- Publishing incremental **memory** snapshots. The two halves of an artifact are on different
  footings, and conflating them would give away most of the benefit for none of the risk. The root
  filesystem is layered from the first release: we own every write to it through the copy-on-write
  layer, so its diff is computed against bytes that were never inside the hypervisor, and template
  chains — which are mostly root filesystem — get their storage dedup on a completely stock VMM.
  The memory file is not, because the hypervisor's own diff support is a developer preview that is
  not resumable without a merge, and the only production system doing it takes delivery of guest
  memory as a descriptor handed out of the VMM process. What a fork buys there is access to the
  bytes, not a better diff, and carrying one is a decision this release does not make.
  [Snapshots](snapshots.md) has the format, both mechanisms, and the trigger for revisiting.
- Idle auto-pause. `vm-host` reports per-sandbox traffic liveness from the first release, because
  it terminates every data-plane connection and the signal is free there, but nothing acts on it
  yet. Acting on it is most of the argument for incremental snapshots, and the two should be
  decided together rather than separately.
- Volumes, forking a sandbox, warm pools of pre-created sandboxes, tenant webhooks, snapshotting a
  *running* sandbox, and administrative surfaces for operating on a tenant's sandboxes in bulk.
  Both comparable systems have all of these; none of them is hard; none is needed to prove the
  architecture.
- Multi-region and multi-cluster placement.
- SSH access to sandboxes.
- Any in-guest capability beyond processes, filesystem, and port relay.
