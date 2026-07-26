---
type: Component
title: vm-host
description: The privileged per-node daemon that owns every Firecracker process, its networking, its artifact cache, and the sandbox data-plane API.
tags: [component, node, firecracker, daemonset]
timestamp: 2026-07-27T07:33:00Z
---

# vm-host

`vm-host` is a privileged DaemonSet with exactly one instance on every node in the sandbox node
pool. It owns every Firecracker process on its node, the per-sandbox networking, the node
artifact cache, and the sandbox data-plane API. It is the only component in the system that
talks to the hypervisor.

Everything about a running sandbox that is not inside the guest lives here. That concentration
is deliberate: the alternative — several privileged agents on the same node, each holding part
of a sandbox's resources — requires those agents to agree on ownership and ordering across
process boundaries, which is a distributed-systems problem invented for no reason on a machine
where a single process can hold all of it.

## Purpose

Turn commands from [control-plane](control-plane.md) into microVMs, and turn requests from
[gateway](gateway.md) into work inside those microVMs, without ever trusting the guest and
without ever letting a sandbox outlive its lease.

Three properties define the component:

- **It is the authority on its own node.** Capacity, admission, slot availability, and cache
  contents are decided locally and reported upward. No external component can assert that this
  node has room; it can only ask, and be refused. Because the node is the authority, control
  plane replicas never need to lock against each other to place work.
- **It is on the data path and must not stop being useful when the control plane is down.**
  Running sandboxes keep serving traffic through a `vm-host` whose control link is broken. Only
  lifecycle operations pause.
- **It holds the privilege.** Everything `vm-host` does is done with full node privileges, so
  every input it accepts — from the guest especially — is treated as hostile.

## Responsibilities

| Area | What `vm-host` does |
|---|---|
| Hypervisor lifecycle | Spawn Firecracker under its jailer into a cgroup this daemon created, supervise the process, drive its HTTP API, create and restore snapshots, kill it by cgroup when it stops answering. |
| Sandbox lifecycle | Allocate, create, checkpoint, pause, resume-as-new-instance, and destroy sandboxes; enforce deadlines from outside the guest. |
| Networking | Own the slot pool: background pre-population, allocation, scrub-on-reuse, drain delay, reclaim. See [networking](../architecture/networking.md). |
| Resource limits | Create the per-sandbox cgroup outside the pod's own subtree and launch the hypervisor into it; bound the guest's own block and network I/O; maintain node admission headroom. |
| Artifact cache | Capacity accounting, watermark-driven LRU eviction, the pin set, cold-path demand paging, background fill, and publication of pause artifacts. See [snapshots](../architecture/snapshots.md). |
| Data-plane API | Serve the per-sandbox API, verify tokens on private ports or explicit exposure on public tenant ports, enforce the per-sandbox concurrent-connection cap, translate to [vm-protocol](vm-protocol.md) calls, pass streams through. |
| Node reporting | Push capacity, per-artifact cache warmth, per-sandbox resource usage and traffic liveness, the hypervisor builds this node carries, and the restore compatibility key it can satisfy up the node-state subscription; gate traffic through the Kubernetes readiness probe. |
| Node hygiene | Verify node preparation at startup, drain on `preStop`, re-adopt sandboxes after a restart. |

## Explicit non-responsibilities

Recorded so that the next feature does not land here by default. `vm-host` is the component with
the most privilege and the largest blast radius, so its surface is defended.

| Not responsible for | Where it belongs | Why not here |
|---|---|---|
| Choosing which node runs a sandbox | [control-plane](control-plane.md) placement | A node cannot see the fleet. It can only accept or refuse. |
| Durable state | PostgreSQL and object storage | Node NVMe is disposable by design. A node that is lost must lose nothing that matters. |
| Minting or attenuating the signing key | [control-plane](control-plane.md) | The verification key is enough to verify. Holding the signing key on every node multiplies the consequence of one node compromise. |
| Quota and billing decisions | [control-plane](control-plane.md) | These are per-organisation and fleet-wide; the node sees one slice. |
| TLS termination and hostname parsing | [gateway](gateway.md) | Keeps certificate material off the privileged node pool. |
| Interpreting tenant payloads | Nothing; it is passed through | Parsing a stream to re-serialise it adds a hostile-input surface and a copy, and buys nothing. |
| Building templates | [template-builder](template-builder.md) | Builds are long, bursty, and failure-prone. They must not share a process with live sandboxes. |
| Anything requiring a guest syscall | [vm-steward](vm-steward.md) | The boundary is the point. |

## Internal structure

The daemon is one process containing a small number of long-lived tasks and one task per
sandbox. Everything is asynchronous; the only blocking work is pushed to a dedicated pool.

```
                    control-plane dials in            gateway proxies in
                             │ gRPC unary + node state       │ HTTP + upgrades
                             ▼                               ▼
                    ┌────────────────┐              ┌────────────────────┐
                    │  control link  │              │  data-plane server │
                    └───────┬────────┘              └─────────┬──────────┘
                            │  commands                       │  requests
                            ▼                                 ▼
                    ┌──────────────────────────────────────────────────┐
                    │  registry:  sandbox id → command sender + status │
                    └───────────────────────┬──────────────────────────┘
                                            │  send(Command)
             ┌──────────────────────────────┼──────────────────────────────┐
             ▼                              ▼                              ▼
     ┌───────────────┐            ┌───────────────┐              ┌───────────────┐
     │ sandbox actor │            │ sandbox actor │      ...     │ sandbox actor │
     │  owns: vmm    │            │               │              │               │
     │  slot, cgroup │            └───────────────┘              └───────────────┘
     │  vsock, pins  │
     │  deadline     │
     └───────┬───────┘
             │ uses (shared, internally synchronised services)
             ▼
   ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
   │ vmm client   │ slot manager │ cgroup mgr   │ cache manager│ lease store  │
   │ (jailer,     │ (netns,      │ (out-of-pod  │ (LRU, pins,  │ (fsync'd     │
   │  unix HTTP)  │  nftables)   │  hierarchy)  │  uffd, fill) │  metadata)   │
   └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

   node services: preflight verifier · node reporter · readiness · reaper · slot filler
                  process overwatcher · health checker · upload retrier
                  reclaim walker · usage sampler
```

### The registry holds senders, not resources

The registry is the one shared map in the daemon, and what it contains is load-bearing: a
command sender and a cheap copy of externally observable status per sandbox. It never contains
a Firecracker process handle, a network slot, a file descriptor, a cgroup handle, or a cache
pin. A caller takes the lock only long enough to clone a sender, so the lock is never held
across an await point and never held while any resource is being manipulated.

### Modules

| Module | Owns | Notes |
|---|---|---|
| `control` | The gRPC server that `control-plane` dials: unary commands in, one node-state subscription out | Multiple replicas may be connected at once; commands are idempotent, so this is safe. |
| `dataplane` | The HTTP server for the per-sandbox API, including upgrades | Authorizes from tokens or exposure state, strips platform credentials, and never parses tenant payloads. |
| `registry` | Sandbox id → command sender and status | The only shared map. |
| `sandbox` | The actor, the state enum, and the command set | Described below. |
| `vmm` | Typed client for the hypervisor HTTP API over its unix socket; jail construction and the launch into the sandbox's cgroup; process supervision | The only module that knows the hypervisor's wire format. |
| `net` | Slot pool and its background filler, namespaces, veth and tap devices, the nftables table, scrub and reclaim | Implements [networking](../architecture/networking.md). |
| `cgroup` | The out-of-pod hierarchy, per-sandbox creation and limits, launching into the cgroup, killing by it, and sampling usage from it | The *tenant* cgroup inside the guest is not touched from here; its freeze and thaw are guest-side protocol operations. |
| `cache` | Capacity accounting, LRU by last access, the pin set, chunked fetch, the userfaultfd handler, background fill, artifact publication | Implements the node-cache half of [snapshots](../architecture/snapshots.md). |
| `lease` | Per-sandbox lease files, keyed by sandbox identifier and epoch, written and fsync'd before resources are acquired | Metadata for reclaim and adoption, including active ingress-policy revision and public ports. Instance existence is recorded by its cgroup, not here. |
| `node` | Preflight verification, capacity and warmth reporting, readiness, drain | |

## The sandbox actor

**Each sandbox is exactly one asynchronous task that exclusively owns its resources**: the
Firecracker process handle, the network slot, the cgroup, the vsock connection, its artifact
cache pins, and its deadline. Commands arrive on a bounded channel. The task loop receives a
command, matches it against the current state, performs the transition, and replies on a
one-shot channel carried by the command.

Two consequences follow, and both are the reason for the design.

**Transitions are serialised by construction.** A pause cannot begin while a restore is in
progress, not because a lock forbids it, but because the single task that would perform the
pause is busy performing the restore, and the pause command is still sitting in the channel.
There is no lock discipline to document, no lock ordering to get right, and no possibility of
one code path acquiring resources in a different order from another. The property is enforced
by the shape of the program rather than by convention.

Consider the alternative in the abstract: a set of global maps — process handles here, network
slots there, cache pins somewhere else — each guarded by its own lock, with operations reaching
into several of them. Such a design does not have fewer races; it has the same races, managed.
Every operation must acquire the right locks in the right order, must not hold one across an
await, must re-validate after each acquisition because the sandbox may have been destroyed
while it waited, and must unwind correctly from a failure at any point in the middle. Each of
those is a rule that a future change can break silently, and the failure mode is a partially
destroyed sandbox or a slot handed to two occupants. Exclusive ownership does not manage that
class of race. It removes it: there is no second holder to race with, so no re-validation is
needed and no ordering exists to get wrong.

**Cleanup is structural, but it is not the guarantee.** Resources release through scope-guard
destructors held by the task, not through a cleanup function that a future edit can return past.
When the actor's loop returns — normally, by error propagation, or by panic unwinding — the
guards run in reverse acquisition order: the cgroup is killed and removed, the slot is scrubbed
and returned, and pins are released. There is no `cleanup()` with fourteen call sites and one
early return that misses it, because there is no `cleanup()`.

What the guards do not do is run in every case, and the design depends on not believing they do.
A destructor runs only while the process is still executing Rust code that owns the value: not
when the daemon is killed outright, not when the out-of-memory killer selects it, not when a
panic aborts rather than unwinds, and not when the daemon dies after a guard has enqueued its
asynchronous remainder but before the reaper has drained the queue. A forced termination is the
ordinary end of a pod that overran its grace period, so none of that is exotic.

**The reclaim walk is therefore the guarantee, and the guards are an optimisation.** Every
resource is named in an fsync'd lease before it is acquired, and the walk destroys anything whose
cgroup no longer holds a process, whether or not a destructor ever executed. The guards exist
because that walk runs on an interval rather than continuously: without them a sandbox that dies
on a healthy daemon holds its slot, its memory, and its cgroup until the next sweep. Releasing
promptly in the common case is worth having and is not worth mistaking for a correctness
property.

Two details make the guards useful where they do run. Asynchronous teardown cannot happen in a
destructor, so each guard carries the minimal synchronous kill — one write to `cgroup.kill`,
releasing an in-memory reservation — and enqueues the remainder on the node reaper, a long-lived
task that outlives every actor. And every guard is idempotent, because the ordinary shutdown path
performs the same releases explicitly in order to report failures.

### Commands and idempotency

Every command carries an **operation identifier** minted by the caller. The actor keeps a small
bounded map of recently completed operation identifiers and their results; a repeated command
returns the original result rather than acting a second time.

This is not defensive politeness. `control-plane` retries — on a timeout, on a broken stream, on
a replica restart — and it cannot distinguish "the command never arrived" from "the command
succeeded and the reply was lost". Without idempotency, a retried pause would snapshot twice
and publish two artifacts, and a retried delete could destroy a sandbox that a subsequent
create had legitimately placed on the same identifier. With it, retry is free and the control
plane's failure handling stays simple.

The map is bounded and expires by age. An operation identifier older than the retry horizon is
treated as new, which is safe because no caller retries that late.

### Every host-side name carries the epoch

**Nothing host-side is keyed by sandbox identifier alone.** The lease file name, the cgroup path,
the jail directory, the writable disk path, the VMM API socket, the fault-handler socket, and the
key of any connection pool entry are all keyed by the pair *(sandbox identifier, epoch)*.
Correspondingly, every teardown step — guard, reaper entry, or reclaim walk — carries the
epoch it was created for and deletes only names matching that generation.

The failure this prevents is not hypothetical, because resume affinity makes it likely. A resume
prefers the node that produced the snapshot, so the new instance of a sandbox is usually created
on the same machine the old instance just left. If names were keyed by identifier alone, the old
instance's asynchronous teardown — a reaper entry queued moments earlier, running after the new
instance has already started — would remove the *new* instance's cgroup, unlink its disk, or
delete its lease file. The cgroup removal is the worst of the three by a wide margin, because it
is not a bookkeeping error: it is an immediate and complete kill of a live tenant workload. The
lease deletion is the least of them, and only because existence is recorded in the cgroup and
nowhere else — a sandbox whose lease vanishes loses its metadata, not its claim to be running.

Epoch keying makes the stale teardown a no-op rather than a race to lose. It also makes the
generation visible in every path on the node, which is what allows an operator looking at a
directory listing to tell two instances of the same sandbox apart.

**The epoch lives above the jail and never inside it**, and this is a constraint rather than a
preference. A snapshot records three of its external resources *by name* — the tap device by
device name, the block file by path, and the guest transport socket by socket name — and a
restore requires each of them to be present under exactly the name the artifact recorded
(`references/firecracker-docs/snapshotting/versioning.md:104-120`). Those three are therefore
identical for every sandbox on every node, and what distinguishes one instance from another is
the enclosing jail root and network namespace, both of which do carry the epoch. The arrangement
is load-bearing in both directions: without a per-sandbox namespace two sandboxes could not both
own a tap of the same name, and without a jail two instances could not both open the same socket
path — which is exactly the collision upstream documents for people restoring snapshots without
the jailer, and hands them a socket-path override to escape
(`references/firecracker-docs/vsock.md:178-184`). Naming any of the three for the epoch instead
would produce a sandbox that pauses successfully and can never be restored, which is the worst
failure shape available here: it is invisible until the tenant comes back. The jailer's
identifier is bounded as well — at most 64 characters, alphanumerics and
hyphens (`references/firecracker-docs/jailer.md:32-34`) — and the
24-character sandbox NanoID plus the epoch has to fit inside it, because that
identifier is what names the jail directory.

## State machine

Sandbox state is an explicit enum, matched exhaustively at every site that cares. Adding a
variant therefore breaks compilation everywhere it must be handled, which is the point: a new
state is a design change, and the compiler is the mechanism that forces every handler to
acknowledge it. No handler is permitted a catch-all arm.

| State | Meaning | Resources held |
|---|---|---|
| `Allocating` | Admission passed; slot, cgroup, disk, and cache pins are being acquired. | Growing |
| `Booting` | The VM is starting from a kernel and root filesystem rather than a memory image. Ordinary sandbox creation never enters this state; it exists for artifacts that carry no memory or device state. | All |
| `Restoring` | The VM is being restored from a snapshot and the guest handshake has not completed. | All |
| `Running` | The guest has answered on vsock at the current epoch. The sandbox serves traffic. | All |
| `Quiescing` | A pause or checkpoint sequence is in progress. Not cancellable. | All |
| `Paused` | Snapshot written to node NVMe; runtime resources released. Carries an explicit upload status — pending, published, or failed — which is recorded in the lease and reported upward. | The local snapshot, pinned, plus its cache entries |
| `Dead` | Terminal. Reclaim has run or is queued. | None |

### Transitions

| From | Command or event | To |
|---|---|---|
| — | `CreateSandbox` accepted by admission | `Allocating` |
| `Allocating` | Resources acquired, artifact carries a memory image | `Restoring` |
| `Allocating` | Resources acquired, artifact carries no memory image | `Booting` |
| `Allocating` | Acquisition failed, `DeleteSandbox`, or deadline | `Dead` |
| `Booting` \| `Restoring` | Guest handshake completed at the current epoch | `Running` |
| `Booting` \| `Restoring` | Handshake timeout, VMM exit, or `DeleteSandbox` | `Dead` |
| `Running` | `PauseSandbox` or `SnapshotSandbox` | `Quiescing` |
| `Running` | `ExtendDeadline` | `Running` |
| `Running` | `DeleteSandbox`, deadline expiry, VMM exit, guest protocol violation, or fault-handler loss | `Dead` |
| `Quiescing` | Snapshot written, for a pause and a checkpoint alike | `Paused` |
| `Quiescing` | Any other failure in the sequence | `Dead` |
| `Paused` | `DeleteSandbox`, or the upload exhausted its retry budget | `Dead` |

Note the edge that does not exist: **there is no `Paused` → `Running`**. A resume is a fresh
`CreateSandbox` producing a new sandbox instance with a new epoch, possibly on a different node.
Modelling resume as a transition would imply that host-held state survives the pause, and it
does not — the guest transport is severed by the snapshot, and stale tokens referencing the old
epoch must fail closed. Making resume a new instance makes that truth structural rather than
remembered.

**A checkpoint is a pause followed by a create, and nothing else.** The temptation is to resume
the VM in place and let the sandbox carry on, and that is where a `Quiescing` → `Running` edge
would go. It does not survive contact with what a snapshot does. **Creating a snapshot resets the
guest transport device, exactly as restoring one does** — the reset belongs to taking the
snapshot, not to loading it — so **every in-flight guest session terminates at a checkpoint**
whichever way the sandbox continues afterwards. Open PTY sessions, streaming output, file
watches, and published-port connections all end, tokens minted for the old epoch stop verifying,
and clients reconnect. Having conceded all of that, resuming in place buys one avoided restore
and costs a bespoke state-machine edge, a second re-handshake timeout, a second site that bumps
the epoch, and a second failure branch for a re-handshake that never answers. The restore it
avoids runs on the node that just wrote the snapshot, whose page cache is as warm as it will ever
be, over the code path every single create exercises and which is therefore the best-tested in
the daemon. So a checkpoint goes to `Paused` and then creates a new instance from the new
snapshot, on the same node, through the ordinary path.

Commands that are invalid for the current state return a typed error immediately. They are never
queued to be applied later, because a caller that receives "accepted" for a command that will be
applied at an unknown future time cannot reason about anything.

## Interfaces

| Direction | Peer | Transport | Purpose |
|---|---|---|---|
| Inbound | [control-plane](control-plane.md) | gRPC over one persistent connection the control plane dials, workload identity with mTLS | Lifecycle commands as unary calls; one server-streaming node-state subscription the other way |
| Inbound | [gateway](gateway.md) | HTTP/1.1 with upgrades, over the node's host IP, mutually authenticated | The per-sandbox data plane. Private requests carry the tenant capability token; public requests carry no client credential. Both require the gateway workload identity. |
| Inbound | kubelet | HTTP, on a separate listener from the sandbox data plane | Readiness and liveness |
| Outbound | Firecracker | HTTP over the per-VM unix socket inside the jail | VM configuration, snapshot create, snapshot restore, pause, resume |
| Outbound | [vm-steward](vm-steward.md) | vsock, via the hypervisor's unix socket multiplexer | [vm-protocol](vm-protocol.md) |
| Outbound | Object storage | HTTPS, chunked ranged reads and multipart writes | Artifact fetch and publish |
| Outbound | Kubernetes API | Watch its own pod. **Read-only** | Knowing when it is being asked to stop. The daemon holds no write permission anywhere in the cluster; see [security](../architecture/security.md) |
| Local | Kernel | netlink, nftables, cgroupfs, mount, userfaultfd, pidfd | Slots, limits, memory backends, exit notification |

### The node-state subscription

Commands arrive as unary calls. Everything travelling the other way is one server-streaming call,
opened by `control-plane` when it dials and held for the life of the connection, carrying the
node's full state on connect and changes afterwards. A command wants a reply matched to it and a
deadline of its own, which is what a unary call already is; multiplexing commands into a stream
means rebuilding both by hand over a transport that supplies them.

| Reported | Why the node is the only place it can come from |
|---|---|
| Capacity and admission headroom | The node is the authority on its own capacity. Nothing else can compute it. |
| Per-artifact cache warmth and the restore compatibility key | Placement weights the first and filters on the second. |
| The hypervisor builds this node carries | The VMM version selects a binary rather than filtering placement, so the control plane needs to know which versions this node can satisfy — and a rollout is visible as the set changing rather than as creates failing. |
| Sandbox inventory, state, and health | What this node believes it is running, which is what reconciliation compares against. |
| Per-sandbox CPU time, current memory, and peak memory | Sampled from the per-sandbox cgroup. |
| Per-sandbox last-traffic time and open-stream count | Every data-plane connection terminates here. |

**Resource usage is sampled from the cgroup, not asked of the guest.** `cpu.stat`,
`memory.current`, and `memory.peak` on the cgroup this daemon already creates are read on a fixed
interval — three file reads per sandbox — and the result is the one measurement in the system a
hostile occupant cannot influence, because it is the kernel's accounting of the hypervisor
process rather than the guest's report of itself. The guest-side half — filesystem usage, and the
split between memory a process is using and memory the guest kernel holds as cache — needs a
syscall inside the sandbox and is therefore a [vm-protocol](vm-protocol.md) capability. Neither
half substitutes for the other, and this one is free.

**Traffic liveness is ours for nothing, and nobody else has it.** Because this daemon terminates
every PTY, every stream, and every published-port connection, last-traffic time and open-stream
count are exact here and guesses anywhere else; [gateway](gateway.md) deliberately does not track
them, being stateless and replicated, so no replica sees all of one sandbox's traffic. The
control plane uses the pair for lease extension and idle auto-pause. Without it a tenant sitting
on an open PTY or a file watch is idle by every measure the control plane can see, and loses the
sandbox mid-session when the lease runs out.

### The data-plane API

`vm-host` serves the public per-sandbox API directly and translates it into
[vm-protocol](vm-protocol.md) calls. Three rules govern that translation.

**Streams are passed through, not parsed and re-serialised.** A PTY session, a file upload, and
a published-port connection are byte streams with a sandbox on one end and a tenant on the
other. `vm-host` frames, size-limits, and rate-limits them; it does not interpret them. Parsing
a stream in order to emit an equivalent stream costs a copy, adds latency to every chunk, and —
far worse — creates a parser on the privileged side of the boundary that consumes attacker-chosen
bytes. Pass-through keeps that parser out of existence.

**Every request is authorized here, independently of the edge.** Private ports require the
capability token, including the reserved sandbox agent port. An anonymous request is accepted only
when this sandbox actor's versioned exposure state marks that exact tenant application port
`public`. Exposure state comes from `control-plane`, not from an assertion made by `gateway`;
a routing or stale-cache mistake upstream therefore cannot become an authorization bypass.
Token verification includes the epoch, so a token minted for a previous instance fails closed.
Exposure updates are monotonic by policy revision. The actor atomically writes and fsyncs the
new revision and public-port set into its lease before acknowledging the control command; stale
updates are ignored. Adoption therefore restores the last acknowledged policy even when
`control-plane` is unavailable during a daemon restart.

The rule is scoped to the sandbox data plane deliberately, because the daemon does serve one
unauthenticated listener and pretending otherwise would make the rule something people learn to
disregard. **The kubelet probe listener is a separate port, bound separately, and exposes no
sandbox-reachable surface**: it answers readiness and liveness with the daemon's own state and
offers no route to any sandbox, no sandbox identifier in its request shape, and no operation that
touches a guest. It is reachable from the node, as it must be for the kubelet to call it, and it
is not part of the surface the wildcard domain resolves to. Anything that would give that
listener a way to name or reach a sandbox moves it onto the data plane, and the exemption ends.

**Credentials are stripped before anything is forwarded to the guest.** On private requests the
capability token header and browser session cookie are removed on the way in. The
occupant is hostile and can read whatever the request carries, so a forwarded credential is a
harvestable, replayable credential for the sandbox it authorises — and, in the browser case, one
that arrives automatically on every subresource the page loads. The credential's purpose is
discharged the moment `vm-host` has verified it; forwarding it further only widens who holds it.
Public requests require no platform credential; this hop removes one defensively if a caller or
stale edge supplied it anyway.

**This hop is the only place the strip can happen.** [gateway](gateway.md) forwards the
private credential rather than consuming it, because the verification that authorises reaching a
guest is ours. The edge-to-node hop is mutually authenticated for both branches: it carries a
live bearer token on private requests, and on public requests it reaches a listener whose
exposure state must not be callable by arbitrary cluster workloads.

**The per-sandbox concurrent-connection cap is enforced here, and only here.** It is keyed by
sandbox identifier and epoch, and released when the slot is. This is the same argument as the
traffic-liveness one and it lands in the same place: every relayed connection terminates in this
daemon, so the count is exact here and is a sum of guesses anywhere else. An edge-side cap has to
reconstruct one number from several stateless replicas, which costs a shared counter, a round
trip on the connection path, and a failure mode where the counter and reality disagree — for a
figure the node holds for free.

**The cap has a ceiling underneath it that is not ours, and it is set explicitly.** Every relayed
connection costs the hypervisor process a descriptor, and the jailer applies a descriptor limit
to the process it launches whether or not one is asked for
(`references/firecracker-docs/jailer.md:79-86`). That default is low relative to the connection
counts a published port attracts, and upstream's two accounts of what it is disagree with each
other — the jailer's own page gives 2048 and the production host guide gives 4096
(`references/firecracker-docs/jailer.md:125-126`,
`references/firecracker-docs/prod-host-setup.md:138-140`). The disagreement is the finding, and
it settles the question of whether to depend on the default: the limit is passed on the command
line, the connection cap is configured beneath it with headroom for the descriptors a sandbox
needs that are not connections, and the relationship between the two is asserted at startup
rather than discovered as refused connections under load. The same argument carries a file-size
limit, which is left unset rather than guessed at — the process it would bound is the one that
writes the memory image during a pause, so a limit below the largest sandbox on the node turns
every pause of that sandbox into a failure at the point of no return.

**A published port that is still binding is retried here.** A request arriving a moment before the
tenant's server has finished binding is the most common transient error in normal use, and the
cheapest place to absorb it is the one where a retry is a single local dial into the guest rather
than another round trip from the edge. So a connection refused by the guest is retried briefly
under a bounded budget before an error is returned; [gateway](gateway.md) deliberately does not
retry this case, so the two budgets cannot compound.

**Every byte arriving from the guest is hostile input.** Length-prefixed framing with a hard
maximum; oversized frames close the connection. Per-sandbox rate limits on message volume and on
expensive operations. No guest-supplied string is ever used to name a host file, address a peer,
or index a privileged operation — host-side names derive from host-side identifiers only. A
protocol violation terminates the sandbox rather than attempting recovery, because a guest that
is speaking the protocol incorrectly is either broken or attacking, and neither deserves a
best-effort parse.

**The guest transport is not the only channel out of a sandbox, and the other one bypasses all of
that.** The hypervisor emulates a serial device whose output is the hypervisor process's own
standard output — a byte stream from inside the sandbox to a descriptor this daemon holds, with
no framing, no protocol to violate, and no limit unless one is configured. A guest writing to it
without pause grows host memory or host storage at whatever sits on the other end, which is us
(`references/firecracker-docs/prod-host-setup.md:28-32`). The guest kernel command line the
hypervisor passes by default disables the device
(`references/firecracker-docs/kernel-policy.md:191-196`), and that is worth having, but it is a
first line and not the control: a template supplying its own boot arguments replaces those
defaults wholesale (`references/firecracker-docs/kernel-policy.md:209-211`), and upstream states
plainly that the device can be reactivated from inside the guest even when it was disabled at
boot (`references/firecracker-docs/prod-host-setup.md:38-40`). What holds regardless is on this
side. The serial output is directed to a bounded sink rather than inherited
(`references/firecracker-docs/prod-host-setup.md:33-36`), the device carries a rate limiter of
its own and is given one (`references/firecracker-docs/device-api.md:114-115`,
`references/firecracker-docs/device-api.md:124-125`), and the volume is a per-sandbox metric,
because a sandbox screaming into its console is either a broken template or someone probing for
exactly this. The hypervisor's log and metrics sinks are the same shape of hazard for the same
reason — the guest influences how much is written to both
(`references/firecracker-docs/prod-host-setup.md:48-51`) — with the additional trap that a named
pipe nobody drains blocks the writer, which is a hypervisor stalled by its own logging.

The launch keeps hold of those streams rather than detaching from them, for reasons set out with
the rest of the jailer's arguments below.

## State owned

All of it is node-local, and all of it is either reconstructible or disposable. Nothing here is
durable truth; that lives in PostgreSQL and object storage.

| State | Form | Lifetime | Reconstruction after loss |
|---|---|---|---|
| Sandbox registry | In-memory map: id → command sender, status | Process | Rebuilt at startup by the reclaim walk |
| Per-sandbox resources | Owned by the actor task, named by sandbox identifier and epoch | Sandbox | Not shared; released by guards, and by the reclaim walk in the cases where guards do not run |
| Slot pool | In-memory free list plus kernel objects (namespaces, veths, taps, nftables sets) | Node | Enumerated from the kernel and reconciled against leases |
| Artifact cache index | In-memory index over the NVMe directory: size, last access, completeness | Node | Rebuilt by scanning the directory at startup |
| Pin set | In-memory, one entry per mapping held by a live sandbox | Sandbox | Rebuilt during adoption; unpinned for sandboxes that no longer exist |
| Admission ledger | In-memory reservation of memory, vCPU, slots, and disk | Node | Recomputed from adopted sandboxes |
| Instance existence | The per-sandbox cgroup directory, named by sandbox identifier and epoch | Sandbox instance | None — this *is* what the reclaim walk enumerates |
| Lease files | One fsync'd file per sandbox instance on NVMe, named by sandbox identifier and epoch | Sandbox instance | None — it carries the metadata the walk cannot read off the kernel |
| Ingress exposure | Active public-port set and policy revision, recorded in the lease | Sandbox instance | Restored during adoption and reconciled from control-plane desired state |
| Pending uploads | The pinned local snapshot, its retry count, and its deadline, recorded in the lease | Until published or abandoned | Read from the lease at adoption; the upload resumes |
| Idempotency map | In-memory, bounded, age-expiring | Retry horizon | Lost on restart; the control plane's retries then re-execute against the adopted state, which is safe because the commands are state-guarded |
| Epoch counters | Recorded in the lease file, incremented on every instance | Sandbox | Read from the lease at adoption |

## Key flows

### Create

1. **Admit.** Check the requested memory, vCPU, disk, and slot against local headroom. Refusal
   is a normal, cheap answer: the control plane excludes this node and places elsewhere. A node
   that accepts work it cannot run is far more expensive than one that refuses promptly.
2. **Re-check the restore compatibility key** in the artifact's manifest against this node: host
   CPU architecture, family and model or CPU template identifier, microcode revision, host kernel
   version, snapshot format version, guest kernel identity and boot args, and the device model
   set. Placement filters on all of it, and this check is the same predicate evaluated a second
   time by the party that will actually perform the restore. It is cheap, it runs before the
   artifact fetch rather than after it, and a mismatch is a terminal error rather than a degraded
   start — see [snapshots](../architecture/snapshots.md). Two manifest fields are **not** part of
   that filter and are resolved here instead: the **VMM version selects which of the hypervisor
   builds this node carries will be launched**, and the agent build identifier is run through
   the quarantine list below. A VMM version the node does not carry fails the create outright,
   which is a deployment problem with an obvious cause rather than a silent one.
3. **Write the lease** and fsync it, before acquiring anything. The lease is named for this
   sandbox *and this epoch*, and it records metadata only — deadline, memory backend, pins,
   pending upload. A lease with no resources is a harmless orphan record; a resource with no
   lease is an invisible leak.
4. **Spawn the actor** and register its sender. State is `Allocating`.
5. **Create the cgroup** in the out-of-pod hierarchy and set its memory, CPU, PID, and block I/O
   limits before anything can be placed in it. From here until reclaim removes it, this directory
   is what makes the instance exist.
6. **Acquire the rest**, each step taking a scope guard: a slot from the pre-warmed pool
   (scrubbed if it is a recycled slot), the writable disk, and a cache pin on the artifact's
   memory file and disk image. The sandbox's own egress allow and deny lists arrive on the
   create call and are installed as named sets in the slot's namespace here, and the
   concurrent-connection cap is armed against the same slot. Both last exactly the occupancy.
7. **Ensure the artifact is local.** A cache hit proceeds immediately. A miss begins a chunked
   fetch into a sparse file and proceeds without waiting for it to complete.
8. **Build the jail** and launch the hypervisor under its jailer, into the sandbox's namespace
   and **into the cgroup created in step 5**, so placement is settled by the clone rather than
   checked afterwards. Artifacts enter the jail as **hard links** from the cache; the hypervisor
   binary is the single exception and is copied by the jailer. Launch arguments that change the
   device model the guest will see — the virtio transport above all, which is a command-line flag
   rather than an API call (`references/firecracker-docs/kernel-policy.md:158-166`) — come from
   the manifest rather than from node configuration, because they are part of the compatibility
   key checked in step 2 and a node choosing them independently would invalidate it. Immediately
   after the launch the VM's in-kernel timer thread is moved into the same cgroup — see below for
   all of this.
9. **Restore**, selecting the memory backend for this restore according to whether the local
   memory file is complete — the file backend when it is, userfaultfd when it is not, per
   [snapshots](../architecture/snapshots.md). On the userfaultfd path the fault handler is
   started and its handshake with the VMM confirmed, under a timeout, before the guest is allowed
   to run. Prefetch hints from the manifest are populated first, and the guest's network rate
   limits are re-applied last — after the snapshot has loaded, and before the separate call that
   resumes the VM. State is `Restoring`.
10. **Handshake** over the guest transport at the new epoch, apply the post-restore hook — clock
    correction, environment, thaw of the tenant cgroup — and wait for the guest to report ready.
    The hook is delivered by a retry loop that lives on this side, so **the wall time is stamped
    freshly on every attempt** rather than once before the first: a loop running for seconds
    against a slow guest would otherwise land a value that was accurate when it began. Each
    attempt also carries a monotonic stamp, and the guest resolves ordering by last-write-wins
    on it, discarding an attempt older than one already applied. See
    [vm-protocol](vm-protocol.md).
11. **Arm the deadline and the health checker**, publish the sandbox as `Running`, and report the
    new capacity upward.

Failure at any step propagates out of the actor. The guards unwind in reclaim order — the cgroup
killed first, the lease file removed last — and the error is returned to the control plane
classified as retryable or terminal.

### The quarantine list is deployable; the agent is not

The guest agent is sealed into every template and snapshot built while it was current, so a
capability it advertises truthfully and implements incorrectly cannot be fixed by deploying
anything. The bit stays set in artifacts already on disk, the host is contractually obliged to
believe it, and the only correction available inside the protocol is a fleet-wide template
rebuild started at the moment the bug is found.

The host therefore owns a **capability quarantine list**: a deployable mapping from agent build
identifier to a set of capability bits to *subtract* from whatever an agent of that build
advertises. It is consulted at the handshake and, because a restore should not be attempted
against a capability set that is about to be reduced, against the manifest's recorded build
identifier before the restore. Once a bit is gone the host takes the path it already has for an
agent that never had it, so the affected templates get rebuilt as scheduled work rather than
during an incident. It subtracts and never adds: subtracting is always safe because the host
must already work against an agent that never claimed the bit, whereas adding one would be the
host asserting a capability on the strength of a build string. [vm-protocol](vm-protocol.md)
carries the contract; what belongs here is that the list is node configuration, reloadable
without a restart, and applied before anything is restored.

### A CPU template is what widens the eligible pool

Placement filters a restore on the host's CPU model, because a memory snapshot is portable only
between hosts exposing the guest an identical feature set, and the trivial way to guarantee that
is an identical processor. A CPU template is the non-trivial way: it fixes what the guest sees,
so one snapshot becomes restorable across every model the template covers. Three things about
that are easy to assume wrongly.

**It widens within a vendor and never across one**, because presenting one vendor's processor as
another's is not supported (`references/firecracker-docs/cpu_templates/cpu-templates.md:21`). A
fleet mixing vendors is two pools whatever we do, and the template's job is to collapse the
models inside each. The built-in templates are deprecated in favour of custom ones
(`references/firecracker-docs/cpu_templates/cpu-templates.md:41-46`), so what we deploy is a
template of our own rather than a name chosen from a list.

**Nobody in this system produces one at runtime.** A template is built offline from a dump of the
guest CPU configuration taken on *every* combination of processor model, host kernel, firmware,
and hypervisor version the fleet contains, reduced to the entries that differ and then drafted by
hand (`references/firecracker-docs/cpu_templates/cpu-template-helper.md:49-51`,
`references/firecracker-docs/cpu_templates/cpu-template-helper.md:159-167`). A node's
contribution is the dump; the template arrives pinned, like the binaries. It is also gated before
deployment rather than after, because KVM may decline part of a template without saying so and
the hypervisor does not check at runtime
(`references/firecracker-docs/cpu_templates/cpu-templates.md:133-135`,
`references/firecracker-docs/cpu_templates/cpu-template-helper.md:81-85`) — an unapplied template
yields a guest with a different feature set, a snapshot that is not portable after all, and no
error anywhere.

**It expires without changing.** A template's validity is relative to the firmware, host kernel,
and hypervisor version it was drafted against, and a microcode update can alter the behaviour of
an instruction while every reported value stays identical. The answer upstream gives is a
fingerprint stored with the template and compared whenever any of those move
(`references/firecracker-docs/cpu_templates/cpu-template-helper.md:110-122`), which for us is
every rollout. The consequence here is a field: **the node reports its microcode revision with
the rest of its compatibility key**, because two nodes sharing a template identifier and
differing in microcode are not interchangeable and the identifier alone cannot say so.

None of this makes a template a security control, and [security](../architecture/security.md)
must not treat it as one. Masking a feature tells the guest the feature is absent; it does not
generally stop the guest executing the instruction anyway
(`references/firecracker-docs/cpu_templates/cpu-templates.md:25-30`).

### How many builds a node carries, and for how long a pause survives

The hypervisor's support policy is what bounds both, and neither is bounded anywhere else in this
bundle. Patch releases — which is to say security fixes — are published for the last two minor
releases for up to a year, for any minor release for at least six months, and for the latest
minor of a major release for a year (`references/firecracker-docs/RELEASE_POLICY.md:45-52`). At
the recent cadence of roughly one minor release a quarter
(`references/firecracker-docs/RELEASE_POLICY.md:93-99`), that is two or three versions in support
at any moment.

**A node carries the supported builds and no others**, because an unsupported hypervisor stops
receiving security fixes and this one runs hostile code. So the reported set changing is what a
rollout looks like, and a set that only ever grows is a bug in the release process rather than a
node with more choices.

That gives the number this bundle has so far left open. **A paused sandbox stays restorable for
as long as the fleet still carries a build that can restore it: six months at the guaranteed
minimum, a year at the outside.** Past that the artifact is not damaged, it is unrestorable,
which is a worse failure because nothing observes it until a tenant returns. Acting on the
deadline belongs to the control plane — restore under a current build and pause again, or delete
— and what belongs here is that the node reports which builds it carries, which is what makes the
deadline computable at all.

Carrying several builds costs less than it appears, because a client generated against one minor
release is guaranteed to work against every later minor of the same major
(`references/firecracker-docs/RELEASE_POLICY.md:122-123`). The typed client is therefore compiled
against the oldest minor the node carries and speaks to all of them; a new *major* is the
expensive event, being a second client and a second set of behaviours rather than a second path.
The version the launched process reports on its own API
(`references/firecracker-docs/device-api.md:139`) is checked against the one the manifest asked
for, because a pinned digest proves the file is the one the chart named and proves nothing about
the chart having named the right one.

The host kernel is the same argument with less room. Two or three versions are validated at a
time, each supported for a minimum of two years
(`references/firecracker-docs/kernel-policy.md:12-15`,
`references/firecracker-docs/kernel-policy.md:26-30`), and a snapshot is expected to resume only
on a configuration identical to the one that produced it — the narrow exceptions upstream reports
are explicitly not recommended for production
(`references/firecracker-docs/snapshotting/snapshot-support.md:669-674`). A host kernel upgrade
therefore partitions the fleet into two incompatible halves rather than rolling through it, which
is why the kernel version is in the compatibility key and why the migration deadline above
applies to it too.

The same policy is why no developer-preview feature is used on this path. The reason is stronger
than their being unsupported: a developer-preview feature may change its user-facing behaviour
without a major version increment (`references/firecracker-docs/RELEASE_POLICY.md:146-148`),
which is precisely the guarantee the multi-build arrangement above rests on.

### What the create path actually spends its time on

Two costs are large, are not obvious from the step list, and are the ones that move when
something regresses.

**Jail construction scales with the node's mount count.** Building the chroot involves the
kernel's mount table, and the work is proportional to how many mounts the node already has. On a
dedicated machine that number is small. On a shared cluster node it is not: every other pod's
volumes, every secret and config projection, and every CSI attachment are mounts, and their count
is set by workloads that have nothing to do with us and that we do not control. This is a direct,
measurable cost of the requirement to coexist with unrelated workloads, and it is why jail
construction is a separately reported create phase rather than being folded into launch. A node
whose creates have slowed with no change on our side is usually a node that has accumulated
neighbours. The two factors compound rather than add: upstream measures ten jails built in
parallel at roughly twice the cost of one on a node with no mounts, and roughly ten times the
cost on a node with five hundred (`references/firecracker-docs/jailer.md:299-306`). Both terms
are outside our control on a shared node — the mount
count belongs to our neighbours and the parallelism to the arrival rate — which is why concurrent
jail construction is bounded by a semaphore like every other saturating resource, rather than
being allowed to scale with the create burst that provoked it.

**Jail resources must be hard-linkable from the artifact cache, which means the jail root and the
cache must be on the same filesystem.** This is a hard configuration requirement, verified at
startup, and the reason is the density argument. A hard link makes the jail's memory file the
same inode as the cache's, so every sandbox restored from one template on one node maps the same
physical pages through the host page cache. If the link cannot be made because the two paths sit
on different filesystems, the fallback is a copy — of the memory image and of the disk image, per
sandbox. That does not merely waste NVMe; it gives every sandbox a private set of pages and
destroys the sharing that the whole per-node density figure rests on. The failure is silent in
the sense that every sandbox still works, and it shows up only as a node that holds a third as
many sandboxes as it should.

The hypervisor binary is the one thing in the jail that is not linked, and it is not ours to
decide. **The jailer copies the executable it is given into the chroot, always**, and its
documented purpose in doing so is that the new process shares no memory with any other hypervisor
process (`references/firecracker-docs/jailer.md:120-122`). Carving the binary out of the
hard-link rule is not a concession to a limitation; it is
a property the jailer is enforcing on purpose, and one we would have to reproduce if we ever
launched without it. The cost is a small fixed per-sandbox charge in disk and in create time, and
one more thing reclaim has to remove, at sandbox churn rate rather than once.

**Sharing an inode means sharing its ownership, and that collides with the recommendation to give
each hypervisor its own identity.** Upstream asks for a distinct unprivileged user and group per
instance, so that breaking out of one jail yields nothing belonging to another
(`references/firecracker-docs/prod-host-setup.md:104-113`), and separately requires that every
resource placed in a jail be readable — and, for a writable disk, writable — by that identity
(`references/firecracker-docs/jailer.md:275-279`). A hard link is one inode with one owner, so a
shared artifact cannot be owned
per sandbox and the two requirements cannot both be met on the same file. The split follows the
mutability: **artifacts entering the jail by hard link are read-only and are made readable to
every sandbox identity through a common group, while everything a sandbox can write — its disk,
its jail root, its sockets — belongs to that sandbox's identity alone.** Getting this backwards
does not fail loudly. Chowning a hard link changes the file for every sandbox already mapping
that inode, because there is only one inode; and a jail whose linked memory file is unreadable by
the identity the hypervisor drops to fails the restore rather than the link.

The same inode is also the whole of the page-sharing story, which is worth saying because a node
preparation item looks as though it should interfere and does not: kernel samepage merging is
disabled on these nodes as a side-channel surface
(`references/firecracker-docs/prod-host-setup.md:337-341`), and costs us nothing, because our
sharing is many mappings of one file rather than deduplication of anonymous pages that happen to
match.

### The guest's own I/O is bounded, not just ours

Node-level semaphores bound *our* consumers of the NVMe device — snapshot writes, restore reads,
artifact fetches, background fill — and bound nothing a guest does. One tenant running a large
sequential write therefore degrades every restore on the node, and the symptom is the worst kind
this document deals in: uniformly slow, attributable to nothing.

The hypervisor has native per-device rate limiters, a pair of token buckets for operations and
for bandwidth on each device. Every sandbox gets them, from the Capacity configuration group
beside its memory and vCPU, and a per-sandbox counter records how often a bucket empties — one
sandbox constantly at its limit is a plan question, many at once is a device at its ceiling, and
neither is a regression in this daemon.

**Both buckets are needed, and the reason is that one thread emulates every device.** A
hypervisor process runs an API thread, one thread per vCPU, and a single thread carrying the
whole device model — block, network, and the guest transport alike
(`references/firecracker-docs/design.md:71-79`). Upstream's own measurements put that thread's
ceiling around 25 Gbps of TCP at full-sized segments and around 18 Gbps at small ones
(`references/firecracker-docs/network-performance.md:10-14`), which is the shape of a
per-operation cost rather than a per-byte one: a guest
sending small packets saturates the thread at two-thirds of the throughput. The bandwidth bucket
bounds what a sandbox takes from the node's uplink and NVMe; the operations bucket is the one
that bounds a flood, and it protects something the node-level view misses entirely, because the
thread a flooding network device saturates is the same thread that services this daemon's own
channel to the agent. A sandbox can therefore make itself unreachable to us without ever touching
a node-wide resource, and the two look identical from aggregate throughput.

The ordering is what is easy to get wrong and expensive to fix later. **Limiter state is
serialised into the snapshot**, so a restore inherits whatever was configured when the artifact
was taken: an older policy, a different plan, a value some previous version of this daemon chose.
Limits are therefore re-applied on **every** restore, unconditionally, before the VM is resumed,
and the snapshot-carried values are never read back. Trusting them instead makes the next change
to a limit an audit of every artifact in the fleet rather than a change to this code path. Three
mechanical details decide whether that actually holds.

**The restore call can resume the VM itself, and ours must not.** Loading a snapshot takes an
optional instruction to resume immediately (`references/firecracker-docs/device-api.md:68`);
taking it collapses the window in which anything can be re-applied, because the guest is running
by the time the call returns. So the load is issued without it and the resume is a separate step,
which is the same reason the post-restore hook has a window to work in.

**A patch merges rather than replaces.** Updating one bucket leaves every field not mentioned at
whatever the snapshot restored
(`references/firecracker-docs/api_requests/patch-network-interface.md:63-65`), which is precisely
the value we are refusing to trust. Both directions and both buckets are
written explicitly on every restore, and *no limit* is written as an explicit zero-sized bucket
rather than as an omission
(`references/firecracker-docs/api_requests/patch-network-interface.md:69-70`).

**The block device is the gap, and the cgroup closes it.** The network limiters are documented as
patchable at any time after boot
(`references/firecracker-docs/api_requests/patch-network-interface.md:3-4`,
`references/firecracker-docs/api_requests/patch-network-interface.md:35`), and so is the
persistent-memory device's (`references/firecracker-docs/pmem.md:202`). The documented patch
surface for a block device carries the backing path and nothing else: `PartialDrive` is
`drive_id` and `path_on_host` where `PartialNetworkInterface` and `PartialPmem` both carry their
limiters (`references/firecracker-docs/device-api.md:89-90`,
`references/firecracker-docs/device-api.md:91-93`,
`references/firecracker-docs/device-api.md:112-113`), and the documented purpose of the block
patch is to notify the hypervisor that the backing file's path or size has changed
(`references/firecracker-docs/api_requests/patch-block.md:5-11`). Since a restore configures no
devices — they arrive from the snapshot's device state — there is no call on the restore path
that sets a block limiter, and for that device the rule above is a rule about what the artifact
carries rather than about what this daemon applies.

**That last conclusion is an argument from absence, and is recorded as unverified rather than
settled.** What the pinned documentation shows is that no block limiter patch is *documented*,
which is not the same as one being impossible: the schema those pages defer to
(`references/firecracker-docs/device-api.md:39-41`) is the hypervisor's own API specification,
which is not part of the pinned tree, so the negative cannot be checked here. The disposition is
deliberate — a design that assumes the limiter is reachable and is wrong fails silently at
restore, while one that assumes it is not reachable and is wrong carries a redundant control. If
the specification later shows the field exists, what changes is that the block limiter joins the
network one on the re-apply path; the cgroup bound below stays regardless, because it is the only
one of the two that no artifact can carry stale.

The host-side answer is the one we already own: the per-sandbox cgroup's I/O controller bounds
what the hypervisor process can put through the NVMe device whatever its emulated device
believes, which is also upstream's recommendation for controlling a guest's disk I/O
(`references/firecracker-docs/prod-host-setup.md:127-133`). That is why the cgroup root delegates
`io` alongside `cpu`, `memory`, and `pids`, and why a block limit is verified by reading the
cgroup rather than by reading the device.

### The balloon is asked, not told

The pre-pause reclaim pass depends on the balloon to hand back guest memory before the image is
written, and [snapshots](../architecture/snapshots.md) owns that sequence. Two properties of the
device decide what this daemon can do with it, and both cut against the way it is usually
described.

**Almost none of it is per-sandbox.** The device has to be installed before the VM boots
(`references/firecracker-docs/ballooning.md:120-123`), its options are fixed for the life of the
microVM (`references/firecracker-docs/ballooning.md:8-11`), and statistics can be neither enabled
nor disabled after boot (`references/firecracker-docs/ballooning.md:300-305`) — only the target
size and the statistics interval move afterwards. Since ordinary
creation restores rather than boots, the balloon and every option on it are properties of the
artifact, decided by [template-builder](template-builder.md), and a template built without one
can never acquire one. What is genuinely per sandbox is the target we set. This is the same shape
as the sealed agent: a decision taken at build time that no deployment can revise, which is why
it belongs in the template contract rather than in the create call.

**The device is guest-cooperative, which on a hostile guest means advisory.** Upstream is
unusually direct about this: the device requires a cooperating driver in the guest
(`references/firecracker-docs/ballooning.md:56-57`), the hypervisor cannot introspect that driver
and a compromised one voids every guarantee the device makes, the operator must be ready for the
process to use all the memory it was given however the balloon is configured
(`references/firecracker-docs/ballooning.md:69-79`), and the reported figures are an indication
rather than a measurement (`references/firecracker-docs/ballooning.md:90-93`). Three consequences
land here. **The admission reservation is
never reduced by a balloon** — memory is committed at the size the artifact declares, and the
cgroup's memory limit, not the device, is what enforces it. **The reclaim pass is bounded by time
and takes what it has**, because inflation speed belongs entirely to the guest driver
(`references/firecracker-docs/ballooning.md:470-471`); a sandbox that declines to inflate is
paused with a larger image, not held. And **a stalled inflation has its target lowered to the
size actually reached**, because a balloon that cannot meet its target keeps retrying, which
spends the guest's vCPU on nothing at the exact moment we are trying to quiesce it — lowering the
target to the size reached is upstream's own remedy
(`references/firecracker-docs/ballooning.md:473-476`).

The continuous variant — the guest reporting free ranges as it frees them — is attractive for
the same reason and has one consequence worth naming before it is switched on: it too is
pre-boot only and cannot be stopped afterwards
(`references/firecracker-docs/ballooning.md:312-313`), and it turns memory removal from something
that happens during a pause into something that happens all the time. The fault handler's
deferred case, set out below, is then a steady-state path on every demand-paged sandbox rather
than a pause-time one. The host-initiated variant, which is the mechanism a pre-pause pass would
ask for if it could choose (`references/firecracker-docs/ballooning.md:351-357`), is a developer
preview carrying a documented race that can free memory the guest has already reclaimed
(`references/firecracker-docs/ballooning.md:450-455`), and is declined on that basis rather than
on its status.

Whichever is used, the mechanism underneath is the hypervisor discarding the reported pages out
of the guest's mapping with `MADV_DONTNEED`
(`references/firecracker-docs/ballooning.md:99-105`). That discard is what generates the removal
events a fault handler has to drain, and is the whole reason the handler needs a lock its workers
never touch and a queue for faults it cannot service yet.

### The slot pool is filled in the background

A slot is a network namespace, a veth pair, a tap device, addresses, routes, and an nftables
ruleset. Constructing one is the single most expensive piece of sandbox creation that is not the
restore itself, and doing it inline would put all of that work on the critical path of every
create, for no reason: nothing about a slot depends on which sandbox will occupy it.

So the pool is populated by a background task that maintains a target number of ready slots, and
allocation on the create path is a pop from a free list. Two sources feed the pool. New slots are
built ahead of demand, at low priority, yielding to live creates in the same way the background
cache filler does. Recycled slots — returned by a destroyed sandbox, scrubbed of conntrack
entries, sets, and routes, and held for the drain delay so in-flight connections can finish —
re-enter the same free list, and are strictly cheaper than building a slot from nothing.

One interaction is worth stating because it produces confusing numbers rather than failures.
**During the drain delay the admission ledger and the pool disagree.** A destroyed sandbox has
released its admission reservation, so the ledger already counts the slot as available, while the
slot itself is still draining and is not yet in the free list. A node can therefore admit a create
and then find no slot ready for it. The reconciliation is that admission counts against the
configured pool size rather than against the instantaneous free list, and a create that arrives
during the gap waits briefly for the background task rather than being refused — the wait is
bounded by the drain delay, which is short and configured, and refusing work that will be
servicable in a moment is the worse answer.

### Ingress

A request from `gateway` carries the sandbox identifier and port in the hostname. `vm-host`
looks up the actor and authorizes against either the private capability token or that actor's
active public-port set and policy revision. It then obtains the guest transport and copies bytes.
The actor is not blocked for the duration of the connection: it hands out a cloneable transport
handle at handshake time, and stream copying happens on connection tasks. The actor remains the
only thing that can *change* the sandbox, which is the
property that matters; concurrent readers of an established transport race with nothing.

### Pause

The full ordering, its rationale, and its guarantees are in
[snapshots](../architecture/snapshots.md). What belongs here is the execution model: the
sequence runs inside `Quiescing`, in a dedicated task that is never dropped part-way, bounded by
a per-node semaphore because snapshot writes and restore reads compete for the same NVMe
bandwidth. When it completes, the sandbox transitions to `Paused`, whether the caller asked for a
pause or a checkpoint.

Four things about the sequence are `vm-host`'s responsibility specifically.

**Health checking stops before the sequence begins.** The first action on entering `Quiescing` is
to disarm the health checker for that sandbox. A quiescing sandbox has stopped answering by
design — its tenant processes are frozen and shortly afterwards its VM is paused — so a checker
still running against it reports a failure that means nothing. Since a failed check no longer
terminates anything, the rule is now hygiene rather than a safety property, and it stays for that
reason: a signal that reads as failure during every single pause is a signal operators learn to
ignore, and the point of reporting health is that somebody looks at it.

**Freezing is a guest-side operation that the host drives, not one the host performs.** `vm-host`
sends `PrePause` and the guest freezes its own tenant cgroup; the host does not reach into the
guest's cgroup hierarchy, for the same reason it does not reach into anything else in there. The
freeze is **asynchronous** — the write that requests it returns before tasks have actually
stopped — so the guest waits for confirmation before acknowledging, and the host treats a missing
or late acknowledgement as a failure of that step rather than proceeding. Every step after the
freeze assumes tenant code has genuinely stopped, and an unconfirmed freeze is not a barrier.

**The guest filesystem is not frozen when memory is being captured.** That state lives in the
guest's superblock, which is guest memory, so freezing before the capture bakes a frozen
filesystem into the artifact and every sandbox ever restored from it blocks on its first write.
A filesystem freeze is used only for filesystem-only artifacts, which carry no memory image.
Conversely, the **tenant-cgroup freeze deliberately does persist into the artifact**: a restored
sandbox comes up with its tenant processes still frozen, which is what gives the post-restore
hook a window to correct the clock and re-establish the environment before any tenant instruction
runs. Releasing it is the hook's job, not the capture's.

**There is an explicit thaw, and it belongs to the abort path.** A sequence that completes never
thaws: the freeze is captured into the artifact deliberately, and the next instance's
post-restore hook is what releases it. Every abort path, by contrast, sends the thaw rather than
relying on the guest's own auto-thaw deadline to notice, and sends it unconditionally rather than
tracking whether it is needed. The thaw is idempotent, so a duplicated one is free, while a
missing one leaves a sandbox frozen with nothing scheduled to unfreeze it.

### The window between pause and durability

When the snapshot is written, the sandbox is reported paused — but the artifact exists only on
this node's NVMe until the upload lands, and until then the tenant's "paused" sandbox is one node
failure away from being gone. That window has to be owned by something, and it is owned here.

- The local snapshot is **pinned against eviction** for as long as the upload is outstanding. The
  cache is watermark-driven and would otherwise be entitled to select it, which would leave the
  upload with nothing to read.
- The upload has a **retry budget with backoff**, recorded in the lease alongside the pin, so it
  survives a daemon restart: adoption finds the pending upload and resumes it rather than
  discovering an orphaned snapshot with no owner.
- `Paused` carries an explicit **upload status — pending, published, or failed — reported upward
  on the node-state subscription**, so the control plane can distinguish a sandbox that is
  durably paused from one that is merely paused on a machine. Resume from a pending snapshot is
  exactly why resume affinity prefers this node.
- When the budget is exhausted the outcome is defined rather than left to inference: the sandbox
  transitions to `Dead`, the pin is released, the local snapshot is deleted, and the failure is
  reported upward as a terminal pause failure. The alternative — retrying forever — pins cache
  capacity indefinitely for an artifact nobody can reach, and the alternative of silently
  dropping it reports a durable pause that never existed.

The upload itself proceeds in the background with the manifest written last, so a failure at any
point leaves orphaned blobs for the collector rather than a half-readable artifact.

### Deadline expiry

Every sandbox carries an expiry, and `vm-host` enforces it **from outside the guest**. Nothing
inside the sandbox participates: no in-guest timer, no cooperative shutdown, no acknowledgement
the guest can withhold. A hung sandbox and a hostile one are handled identically, because from
the host's position they are indistinguishable and the correct action is the same.

Extensions arrive as ordinary commands on the actor's channel and re-arm the timer. Routing
extensions through the same serialised path as every other transition means an extension can
never race a teardown: whichever command the actor takes from the channel first wins, and the
other observes a state in which it is invalid.

### Health checks observe; they do not terminate

`vm-host` probes each running sandbox on an interval and reports the result. **A failed probe
never terminates the sandbox.**

What the probe measures is how fast the guest answers, which is a function of tenant load rather
than of liveness: a guest saturating its vCPUs, an agent paused for a moment, and a burst of
relayed connections are indistinguishable at this distance from one that is dead. Terminating on
it therefore means terminating sandboxes in proportion to how hard tenants work them — failing
the check is the normal consequence of using the product, not a symptom of anything. The one
comparable implementation running at this scale reaches the same conclusion and does nothing on
failure but flip a flag and log.

So health is reported upward, alarmed on, and used to weight placement, and termination is
reserved for evidence the host can trust without asking the guest anything: hypervisor exit,
deadline expiry, a protocol violation, or the loss of a fault handler. None of the four can be
manufactured by a busy tenant. A guest kernel panic reaches us as the first of the four, because
the command line the hypervisor passes by default turns a panic into a shutdown rather than a
reboot loop (`references/firecracker-docs/kernel-policy.md:191-194`) and the hypervisor exits
when the CPU resets (`references/firecracker-docs/api_requests/actions.md:39-40`) — so the
loudest thing that can go wrong inside a guest arrives as evidence the host can act on, without
the guest being asked anything.

### Cache fetch and eviction

Fetches are chunked ranged reads into a sparse file that doubles as the final memory image, so
completion requires no conversion step. Eviction runs on watermarks — begin at the high mark,
stop at the low mark, plus an absolute cap — and selects victims by **last access**, not last
write, because a popular template is written once and read constantly. **Anything currently
mapped by a live sandbox is pinned and skipped.** Evicting a memory file out from under a
running VM is unrecoverable, so the pin set is consulted on every candidate, and a pin is held
by the sandbox actor for exactly as long as the mapping exists.

### The fault handler is a liveness dependency of every cold sandbox

On the userfaultfd path the daemon is not merely servicing the sandbox; it is standing in for its
memory. **The VMM waits indefinitely for a fault to be serviced.** There is no timeout on that
wait and no degraded mode, so a fault handler that dies, deadlocks, or is never started leaves
every vCPU that subsequently faults parked forever. The sandbox does not crash and does not
report an error. It stops, while holding its slot, its memory, its cgroup, and its lease.

Three obligations follow, and they are the reason the cold path is treated as more dangerous than
the warm one rather than merely slower.

**A daemon crash or restart kills every cold-path sandbox on the node.** This is the one real
limit on the crash-recovery property described below. Sandboxes restored from a complete local
memory file survive a restart untouched, because their memory is served by the kernel from a
mapped file and the daemon is not in that path at all. Sandboxes still being demand-paged do not
survive: their fault handler was in the daemon that just died, and the restarted daemon cannot
reattach to the descriptor. Adoption must therefore identify cold-path sandboxes and kill them
deliberately rather than adopting them into a state where they appear healthy and will hang at
the next fault. The mitigation is the background filler, which shortens the window in which any
given sandbox is cold; the exposure is a reason to keep the filler running and to prefer warm
nodes at placement, not a reason to claim the restart is transparent.

**The handshake is timed out and the handler is monitored.** The VMM's registration of the memory
region with the handler happens once, at restore, and a handshake that never completes produces
exactly the same indefinite hang as a handler that dies later — but at a point where the sandbox
has not yet started and can still be failed cleanly. So the handshake carries a timeout and a
failure of it fails the create. Thereafter the handler's liveness is a monitored signal in its
own right, not something inferred from whether the sandbox looks healthy, because a hung sandbox
looks healthy from every angle except the one that matters.

**A fault-path fetch that exhausts its retries kills the VM.** This is the disposition the
mechanism permits, and it is worth being explicit that it is not a choice between good options:
**an error cannot be returned to a page fault.** There is no way to tell a guest that a read of
its own memory failed, so the alternatives are killing the sandbox or hanging it forever. Killing
it produces a loud, attributable failure that the tenant can retry and that shows up in a metric;
hanging produces a sandbox that consumes its full resource footprint while doing nothing, for the
rest of its lease.

### How the handler is threaded, and why it is not a preference

[Snapshots](../architecture/snapshots.md) sets out the handler's obligations as a contract. The
threading rules are restated here because they are what an implementer of this daemon actually
has to build, and every one of them fails as a hang or as silent corruption rather than as a
test failure.

**The event-read loop takes a lock the workers never touch.** This is a deadlock, not a
throughput note. The balloon's discard call blocks inside the kernel until the handler drains the
removal event it just generated, so every lock the event reader needs is a lock the VMM is
already waiting on — and our workers hold their locks across ranged reads to object storage. Put
the two on one lock and a single slow read against a distant endpoint stops the whole VMM: every
vCPU, not the one that faulted, and not for the duration of the read but until the read returns.
Worker state is guarded separately, and no code path may acquire both.

**The install path has four outcomes and three of them are not errors.** A handler written as
"install or fail" is wrong in both directions at once — it kills healthy sandboxes and hangs sick
ones — and two of the three non-error outcomes are produced by concurrency this design mandates
elsewhere.

| Outcome | Cause | Disposition |
|---|---|---|
| Installed | The ordinary case. | Wake the faulting thread. |
| Already present | A concurrent worker or a prefetch won the race for the same page. | Success, and **the wake is still issued**. The winner's install does not wake a thread that parked after it, so returning early here leaves a vCPU blocked on a page that is already correct. |
| Deferred | A soft failure from the kernel, most often a discard arriving against the range while the copy is in flight. | Queue the address on the handler's own deferred list and signal itself to retry. **The kernel does not redeliver a fault it has already reported**, so nothing else will ever bring this address back. |
| Discarded | The faulting thread is gone: the VM is being torn down, or the region is unregistered. | Drop it. There is nobody to wake and retrying writes bytes into a dead address space. |

The deferred case is the one that must not be collapsed into either neighbour, and its cause is
the balloon the pre-pause reclaim depends on: a discard against a range with a copy in flight is
ordinary behaviour, not a malfunction. Treating it as an error kills a working sandbox; treating
it as handled parks a vCPU permanently. So the handler owns a deferred queue and a self-pipe to
wake itself on, because the kernel supplies neither.

**Zeroing a read fault is ordered: zero, then write-protect, then wake.** An anonymous mapping
cannot be write-protected until it has been populated, so the protect follows the zero; and the
wake follows the protect, or the guest resumes against a page that is briefly writable and the
write goes unrecorded. A *write* fault takes neither step — the page is about to be dirtied by
definition, and protecting it only to fault again immediately is pure overhead.

### Drain

On `preStop`, the daemon marks itself unready so no new work is placed, then snapshots and
evacuates its sandboxes within the termination grace period, oldest deadline first. Sandboxes
that cannot be snapshotted in the remaining budget are reported as lost rather than being killed
silently. If the daemon is merely restarting rather than the node going away, drain is skipped
entirely: the sandboxes survive the restart and are re-adopted, with the exception of any that
are still demand-paged.

Drain is a best case, not a guarantee. It runs when something asks the pod to stop and waits; it
does not run when the node is taken away underneath it, and the paths on which that happens —
scale-down of a node holding only DaemonSet pods, and a manual drain, neither of which evicts
this pod at all — are set out in [overview](../architecture/overview.md).

## Concurrency, cancellation and failure model

### Concurrency

Per-sandbox concurrency is solved by the actor. Node-level concurrency is bounded by semaphores
on the resources that saturate: snapshot writes, restore reads, artifact fetches, and background
fill. Background fill runs at the lowest priority and yields to live restores, because a
background optimisation that delays a customer-visible start has negative value.

Command channels are bounded. A full channel is backpressure and is surfaced as resource
exhaustion to the caller, which re-places the work. Unbounded queues convert a capacity problem
into an unbounded-latency problem and then into an out-of-memory event.

### Cancellation

**Pause, snapshot, and restore run in dedicated tasks that are never dropped part-way.**
External cancellation sets a flag; the sequence checks that flag **only at step boundaries** and
unwinds through a defined recovery path.

The reason is specific and severe. These sequences contain critical sections that leave the
system in a state only they can exit: a frozen tenant cgroup, a paused VM, a snapshot half
written. Dropping the task after the guest has frozen its tenant cgroup leaves it frozen with
nothing scheduled to thaw it, and the sandbox is hung indefinitely — it does not fail, it does
not recover, it simply stops, and it holds its slot, its memory, and its cgroup while doing so.
The same applies to a hypervisor pause abandoned before the corresponding resume.

> **Selecting over a critical section is a prohibited pattern.** No critical section may appear
> as a branch of a construct that can abandon it — not against a timeout, not against a shutdown
> signal, not against a cancellation token. The step runs to its own conclusion, and the
> cancellation is observed afterwards.

This does not mean a hung hypervisor call blocks forever. Each individual call carries its own
timeout inside the typed client, and a timeout is a *failure of that step*, handled by the
sequence's own recovery path — send the thaw, resume or destroy the VM, transition to `Dead` —
rather than by abandoning the task that owes those actions. Timeouts belong to steps; they never
span a critical section.

### Failure classification

| Class | Examples | Handling |
|---|---|---|
| Transient, node-local | Momentarily exhausted slots, semaphore saturation, in-flight fetch | Refuse with resource exhaustion; the control plane places elsewhere |
| Transient, external | Object storage timeout during a cold fetch | Retry with backoff inside the actor; fail the create if the deadline passes |
| Terminal, sandbox-scoped | VMM exit, restore failure, handshake timeout, guest protocol violation, compatibility key mismatch, a VMM version this node does not carry | Sandbox to `Dead`; guards unwind; reported upward |
| Unresponsive VMM process | The process is alive but answers neither its API nor a graceful signal | An overwatcher kills the cgroup after a bounded wait and treats the cgroup reporting itself unpopulated as completion. The VMM's own signal handling is not async-signal-safe and can deadlock inside a handler (`references/firecracker-docs/prod-host-setup.md:74-79`), so a process that has been asked to stop and has not is assumed unable to, not merely slow. Waiting politely for it holds the sandbox's memory and slot indefinitely. An overwatcher that finds unresponsive hypervisors and kills them outright is upstream's own recommendation for exactly this deadlock (`references/firecracker-docs/prod-host-setup.md:81-83`). |
| Fault handler lost | The handler for a demand-paged sandbox died, or its handshake never completed | Kill the VM. The guest is already parked or about to be, and there is no error that can be returned to a page fault. |
| Terminal, node-scoped | Hardware virtualisation unavailable, a binary failing its pinned digest, missing node preparation, sandbox CIDR overlap, cgroup root absent, inside the pod's subtree, or not delegating the controllers we need | Refuse readiness; the node takes no traffic. Starting wrong is worse than not starting. |
| Programming error | Invariant violation inside an actor | The actor's panic unwinds through its guards; the sandbox dies; the daemon survives and records it |

A panic in one actor must not take down the daemon, because doing so would take down every other
sandbox on the node with it. Ownership is what makes that containment possible: an actor's panic
can only damage state it exclusively owns, so there is no shared structure left inconsistent by
the unwind.

## Crash recovery

Sandboxes survive a `vm-host` restart. Two mechanisms make it true, and both are structural
rather than best-effort:

- **Host PID namespace sharing.** A container's processes share its PID namespace, and when that
  namespace's init dies the kernel kills every process in it. With `hostPID`, Firecracker
  processes are not in the pod's PID namespace and are not killed when the pod is replaced.
- **Out-of-pod cgroups.** Container teardown destroys the pod's cgroup subtree along with
  everything in it, so sandbox cgroups are created in a separate hierarchy rooted outside that
  subtree.

The property has one exception, and it is stated here rather than buried: **sandboxes still being
demand-paged do not survive, because their fault handler lived in the daemon that died.** Only
sandboxes whose memory file is complete locally are genuinely independent of the daemon. See the
fault-handler discussion above.

### Startup sequence

1. **Verify node preparation.** Hardware virtualisation, kernel modules, non-namespaced sysctls,
   the cgroup root, the NVMe mount, and the pinned digests of each hypervisor build with its jailer,
   and the guest kernel. Anything missing means unready, permanently, with a clear reason. A
   half-prepared node must never receive traffic.
2. **Run the reclaim walk**, below. It is what rebuilds the registry, the pin set, and the
   admission ledger.
3. **Reconcile the cache.** Scan the directory, discard partial downloads that no live sandbox is
   demand-paging from, rebuild the index, and release pins held by sandboxes that no longer
   exist.
4. **Report readiness** once warmth and capacity are known.

### The reclaim walk

Adoption and reclamation are one enumeration with two outcomes, not two mechanisms that have to
agree with each other.

1. **Enumerate the per-sandbox cgroups** under the root and the lease files beside them, pairing
   them by *(sandbox, epoch)*. Anything the registry already knows about is skipped, which is how
   the walk avoids racing a create in flight. At startup the registry is empty, so nothing is
   skipped and every instance on the node is considered.
2. **Adopt every cgroup that holds a process.** Read the hypervisor's process id from
   `cgroup.procs` and re-attach: reopen the unix socket, reconnect the guest transport at the
   **recorded** epoch — the VM never stopped, so this is a new connection to the same instance
   rather than a new instance — re-take the pins, restore the admission reservation and ingress
   exposure revision, re-arm the deadline and health checker, resume any pending upload, and
   spawn an actor in `Running`. A
   lease recording the userfaultfd backend is not adopted; its sandbox is killed, because its
   handler is gone.
3. **Reclaim everything else**: cgroups holding no process, and kernel-visible resources — slots,
   jails, disks, sockets — with no lease at all.

The two mismatches are where the walk decides something, so both dispositions are stated. A
**lease with no cgroup** is not an instance — nothing was ever placed, or the kill has already
run — so the walk releases what the lease names and deletes it. A **populated cgroup with no
lease** is an instance whose metadata was lost; it is adopted and reported upward with its
metadata marked missing, not killed, because killing a live tenant workload on the strength of an
absent file is precisely the failure this arrangement removes.

**The walk also runs on a slow timer, and that is the cheapest correctness in this document.**
Two admissions made elsewhere combine badly: scope guards do not run in several ordinary cases,
and a walk that runs only at startup leaves everything they missed held until the next restart,
on a healthy daemon that may not restart for weeks. Running the same walk periodically closes the
gap for one background task and no new logic, because the walk exists regardless.

**Adoption is a branch of that walk rather than a mechanism beside it**, and the reason is
proportion. Neither of the systems this design is measured against survives a daemon restart at
all; one kills every hypervisor on its node when it starts, and pays for that with drains that
wait hours for a fleet to empty. There is no prior art to copy and nothing working to check
against, so it is built as the smallest increment on an enumeration we need anyway — one walk,
two outcomes, one set of tests — rather than as a second subsystem whose disagreements with the
first would be found in production.

### Adoption is not confused by process ID reuse

A process descriptor cannot be inherited across a daemon restart — the restarted process has a
new descriptor table and nothing to inherit it from — so adoption has to begin with a number, and
a recorded number is reusable by the time anything reads it. The cgroup removes that problem
rather than managing it: the number comes out of `cgroup.procs` rather than out of a file the
daemon wrote earlier, and nothing else on the node can be placed in that cgroup, so a recycled
process id is never a candidate. This is why the lease records no process id and no start time.
There is nothing left to disambiguate.

One narrow window remains: the hypervisor may exit between that read and the opening of a
descriptor for what it named. So membership is verified once through the descriptor after it is
open, and a process that is not in the cgroup is dropped. The descriptor is then held for **exit
notification only** — signalling goes to the cgroup, which names no process at all.

### Ordered reclaim, anchor last

Reclaim proceeds in a fixed order by resource type, and every step is scoped to one generation:
a reclaim for *(sandbox, epoch)* touches only names carrying that epoch, so it can never remove a
resource belonging to a later instance of the same sandbox.

| Order | Reclaimed | Note |
|---|---|---|
| 1 | Everything in the cgroup, then the cgroup directory | One write to `cgroup.kill` terminates every process in the sandbox — jailer, VMM, and anything either spawned — and `cgroup.events` reporting the cgroup unpopulated is the confirmation that it finished, which a signal followed by a bounded wait never supplied. Killing a *process group* instead would name a pid, which is exactly as reuse-prone as the single process it is meant to improve on, and would be escapable by anything that calls `setsid` — which is the "leaves the rest running and unowned" failure the rule exists to prevent. A graceful signal precedes the kill under a short budget, so a VMM that can flush does, but it is not waited on past that, because an unresponsive VMM may be deadlocked in its own signal handling. The signal goes to the process, not to the guest: the one shutdown the hypervisor can ask a guest to perform arrives through an emulated keyboard and depends on a driver and a cooperative occupant (`references/firecracker-docs/api_requests/actions.md:36-45`), which is a veto and therefore inadmissible. The directory is removed once the kill is confirmed. |
| 2 | The fault handler, if one was running, and its socket | Its VM is already gone; a handler still holding a registered region keeps a descriptor alive for nothing. |
| 3 | Cache pins, then the writable disk | Pins first: an unpinned artifact may be evicted, and there is no longer a mapping to protect. |
| 4 | The jail: the chroot directory tree, the hard links inside it, and the per-VM copy of the VMM binary | The binary copy is per sandbox, not per node, so leaving it behind leaks disk at sandbox churn rate rather than once. |
| 5 | The VMM API socket | Inside the jail, but named separately and worth naming here so it is not assumed to disappear with the directory. |
| 6 | Host-side rules keyed to the slot that live **outside** the sandbox's network namespace | The forward and address-translation rules that connect the slot to the uplink sit in the host's own nftables table, not in the namespace. Deleting the namespace does not remove them, and nothing else will. This is the entry most easily missed, because the namespace teardown makes the slot *look* fully reclaimed while a growing set of rules referencing a nonexistent interface accumulates in the host table. |
| 7 | Root-namespace connection-tracking entries for the slot address, and the veth peer's neighbour entry | A sandbox's flows are tracked in **two** tables — once in the slot's namespace and again in the root namespace where the masquerade happens — and flushing from the root namespace flushes only the root's. Both are needed, filtered by the slot address, and confirmed. These are the entries that consume the node's shared conntrack hash table, so leaving them to expire is what fills it with flows belonging to sandboxes that no longer exist. The neighbour entry is the same shape of miss: node preparation raises the neighbour-table thresholds, which budgets for these entries rather than removing them, and a budget for entries nothing deletes is a slower leak and not a bounded one. See [networking](../architecture/networking.md). |
| 8 | The network slot itself: interfaces, addresses, routes, then the named namespace | Scrubbed and returned to the pool after the drain delay. A slot whose scrub cannot be confirmed is destroyed rather than reused. |
| 9 | The lease file | Last, always. |

Within each resource type, the **discoverable anchor is deleted last**. The named network
namespace is removed after the interfaces and rules inside it, so a slot torn down halfway
remains enumerable and reclaimable rather than leaking as a set of unreferenced kernel objects.
The lease file is deleted after every resource it names, so a daemon that dies during reclaim
finds the same lease again on the next walk and simply repeats the work. Repeating reclaim is
free; every step is idempotent. Losing the ability to find a half-reclaimed resource is not free,
because the only remedy is draining the node.

The cgroup goes first rather than last, and the exception is deliberate: a cgroup cannot be
removed while it holds processes, so the kill and the removal are one step or they are a race.
What keeps a half-reclaimed instance discoverable is that the lease outlives it. A lease with no
cgroup names every resource still to be released, which is exactly the mismatch the walk knows
how to handle.

## Kubernetes integration

| Setting | Value | Reason |
|---|---|---|
| Kind | DaemonSet | Exactly one owner of the hypervisor per node, guaranteed by the workload type. |
| `privileged` | `true` | Bind-mounting per-sandbox network namespaces into the host namespace directory requires bidirectional mount propagation, permitted only to privileged containers. See [security](../architecture/security.md). |
| `hostNetwork` | `true` | Pod IP equals host IP, so `control-plane` and `gateway` reach a specific node without kube-proxy. |
| `dnsPolicy` | The host-network variant of the cluster-first policy | **Must be set explicitly.** A host-networked pod otherwise inherits the node's resolver, which does not resolve cluster service names — so the daemon cannot reach the Kubernetes API server by service name, cannot resolve an in-cluster object store endpoint, and fails at startup in a way whose cause looks nothing like DNS. This is the single most common misconfiguration of a host-networked DaemonSet. |
| `hostPID` | `true` | A correctness requirement: without it, replacing the pod kills every sandbox on the node. |
| Host port | A fixed port for the data-plane listener, and a second for the probes | With `hostNetwork` there is no port mapping: the listener occupies that port on every node in the pool, fleet-wide. The number is therefore part of the installation's contract with the cluster, not a local detail, and it must not collide with anything else the operator runs on those nodes. |
| Resource requests | Sized to the capacity the daemon hands out to VMs, not to the daemon's own footprint | Two separate consequences, both severe. Sandbox memory lives in a cgroup outside the pod, so the kubelet does not see it: without a request covering it, the scheduler treats the node as nearly empty and places other pods into memory the VMs are already using, and the node goes to out-of-memory kills. The same request is also what stops an autoscaler concluding the node is underutilised, and it is the first line of that defence rather than a supplement to an annotation, because it is the only signal that survives an autoscaler which defines a node holding nothing but DaemonSet pods as empty. |
| Network policy | Not applicable | Network policy does not apply to host-networked pods. Data-plane access is therefore enforced in-process from private tokens or explicit public exposure, and the gateway hop requires workload identity. The control listener uses mutual TLS. There is no network-layer fallback. |
| Placement | Labelled and tainted sandbox node pool | A hypothetical escape lands on a machine hosting no other tenant's workloads. |
| Namespace | Labelled for the privileged Pod Security Admission profile | Only this namespace. Every other component runs Restricted. |
| Priority class | High | Sandbox memory is invisible to the kubelet, so node-pressure eviction must not select this pod. |
| Cache volume | `hostPath` on a dedicated NVMe filesystem | DaemonSets have no volume claim templates, and a cache that fills by design must not drive the node into disk pressure. |
| Jail root | `hostPath` on the **same filesystem** as the cache volume | Jail contents are hard-linked from the cache, and a hard link cannot cross a filesystem. Verified at startup; see the create path. |
| Service account | Watch its own pods. **Read-only, and that is the whole of it** | The daemon writes nothing to the cluster. The one write it ever wanted — a do-not-disrupt annotation on its own node — has no per-object scoping available for the verbs involved, so granting it means granting the ability to modify every node in the cluster, on the workload with the largest blast radius already. The annotation is static, so it belongs on the node pool at install time; [security](../architecture/security.md) has the reasoning and [overview](../architecture/overview.md) has what replaces it. |

### Node preparation and verification

A privileged **init container** in the same pod performs node preparation: loading kernel
modules, setting non-namespaced sysctls, creating the cgroup root, and mounting the NVMe
filesystem. Keeping it in the same pod means the privileged surface is one workload rather than
two, and means preparation and use cannot drift apart across separate release cycles.

`vm-host` then **verifies all of it at startup and stays unready if anything is missing**. It
does not attempt repair. Verification is cheap, deterministic, and gives an unambiguous reason
for a node being out of service; a daemon that silently fixes what it finds hides a
misconfiguration until the day it fixes it wrong.

Two assertions in that set are worth naming, because neither is about a setting an init
container writes and both fail in a way that points nowhere near their cause.

**The node can actually run a virtual machine.** The device exists, it is usable, and hardware
virtualisation is genuinely available — the pool is bare metal or has nested virtualisation
enabled. This is first because it is the likeliest way a first installation fails: managed
Kubernetes offerings frequently default to a machine type providing neither, and the symptom is
"sandbox creation fails" rather than "these nodes cannot run virtual machines", because the
component that discovers the missing capability sits several layers below whoever chose the
machine type. Asserting it at startup converts a confusing product failure into an unready node
with a reason on it.

**The hypervisor builds, their jailers, and the guest kernel match the digests pinned in the
chart.** These files do not arrive through the artifact store, so nothing downstream verifies
them: the jailer's own documentation is explicit that it treats every input as trusted — not only
the path to the executable it launches, but the chroot base, the network namespace path, and
anything already placed inside the jail root — and that the operator invoking it is part of the
trusted computing base, responsible for those paths being unwritable by anyone unprivileged
(`references/firecracker-docs/jailer.md:266-274`,
`references/firecracker-docs/prod-host-setup.md:99-103`). Whoever can write them owns every
sandbox created afterwards, and owns them beneath every other
control in the system. Checking each file against a pinned digest before reporting ready extends
the rule the artifact store already applies — bytes are not trusted until a digest says so — to
the classes of file that escaped it only because they are installed rather than fetched. See
[security](../architecture/security.md).

Two things about *which* files are pinned are easy to get wrong, and both fail silently.
**A jailer belongs to a hypervisor build rather than to the node**: upstream supports a jailer
only against a statically linked hypervisor of the same version, and does not support the
experimental GNU builds at all (`references/firecracker-docs/jailer.md:8-10`), so the set of
builds in the configuration is a set of pairs, and pinning one jailer for a node carrying three
builds is pinning a mismatch for two of them. And **the kind of build is itself a security
property**, because debug binaries and experimental GNU targets install no default system-call
filters at all (`references/firecracker-docs/seccomp.md:14-17`). A digest can pin exactly the
wrong binary with complete integrity: the hypervisor's own syscall boundary, which the security
posture treats as a layer, would simply be absent, with nothing on any path to say so. Only
release builds of the statically linked flavour the jailer expects are pinned, and the launch
passes neither the argument that replaces the default filters nor the one that removes them —
both of which upstream advises against in production
(`references/firecracker-docs/prod-host-setup.md:20-24`,
`references/firecracker-docs/seccomp.md:82-86`).

### The cgroup is ours, not the jailer's

Delegating cgroup placement to the jailer is the tempting arrangement and the wrong one, because
the way the jailer behaves when its preconditions are unmet is to succeed. So `vm-host` creates
the per-sandbox cgroup itself, sets its limits, and launches the jailer **into** it by cloning
directly into that directory's descriptor. Placement is then a guarantee the kernel makes at
clone time, and the window in which a hypervisor exists outside its cgroup — the window every
read-back check exists to catch — never opens. What does have to be prevented is the jailer
undoing it afterwards, which is what the first of the arguments below is for.

Two jailer arguments and one omission follow, and each matters independently.

- **`--cgroup-version 2`, explicitly.** The default is the older hierarchy
  (`references/firecracker-docs/jailer.md:40-42`), and on a v2 node that default produces no clear
  error, just operations against a hierarchy nobody is using, with the restore-latency penalty of
  a v1 arrangement described in [snapshots](../architecture/snapshots.md) on top.
- **`--parent-cgroup` naming the cgroup we already created.** In the configuration we run — v2,
  with no `--cgroup` arguments — the jailer creates no cgroup at all, and instead **moves itself
  into the parent it was given** if that directory exists, doing nothing and reporting no error
  if it does not (`references/firecracker-docs/jailer.md:65-74`). So the clone is not the last
  word on placement after all: the jailer runs after it and can move the process somewhere else.
  Naming our own cgroup is what makes that move a no-op. Omitting the argument does not disable
  the behaviour, because the default parent is the **basename of the exec file**
  (`references/firecracker-docs/jailer.md:53`) — meaning a stray directory of that name at the
  cgroup root quietly relocates every hypervisor on the node *out* of the cgroup we placed it in,
  and takes its memory and CPU limits with it. The argument is not tidiness; the default is a name
  an outsider can predict.
- **No `--cgroup` arguments.** Given any, the jailer switches to creating a child cgroup of its
  own instead (`references/firecracker-docs/jailer.md:56-64`), and walks upward writing
  controllers into every ancestor's `subtree_control`, up to and including the v2 root. That last
  part is not in the documentation and is verifiable only in the implementation, where the routine
  recurses into the parent *before* writing its own, with a comment stating the rule applies
  recursively (`references/firecracker-src/jailer/cgroup.rs:380-402`).
  Rearranging the node's cgroup hierarchy is not a launcher's business, least of all on a node we
  share.

The move also constrains the per-sandbox cgroup itself: a process cannot be moved into a cgroup
that has domain controllers enabled in its own `subtree_control`, and the jailer exits with an
error when it tries (`references/firecracker-docs/jailer.md:70-73`). So the leaf we create
delegates nothing onward, which is what v2 requires of it anyway. This is the mirror image of the
assertion made about the root below, and the two are easy to state backwards: the root delegates
and holds no processes, the leaves hold processes and delegate nothing.

**The launch is also not daemonized, which is a decision rather than an omission.** Daemonizing
redirects all three of the hypervisor's standard descriptors to `/dev/null`
(`references/firecracker-docs/jailer.md:94-95`), and the jailer's only way to report a failure of
its own is to write to standard error (`references/firecracker-docs/jailer.md:293-295`) — so a
jail that could not be built would produce a launch that failed with no explanation of why.
Nothing is gained in
exchange: supervision is ours, and the kill is by cgroup rather than by anything a new session or
process group would give us. The descriptors that stay open are the ones the guest can write to
through its serial device, which is why they go to bounded sinks rather than being inherited.

Preflight asserts what a live node can satisfy: the root **exists**, sits **outside the pod's
subtree**, is **writable**, carries `+cpu +memory +pids +io` in its `subtree_control`, and
**holds no processes of its own**. The tempting assertion — a *root* with an empty
`subtree_control` — is self-contradictory and would be fatal. A child has a `memory.max` only if
its parent delegates
`+memory`, so empty subtree control and a per-sandbox memory limit cannot both hold; and
preflight runs before readiness, while a node that has just adopted sandboxes has children and a
non-empty subtree control by definition. A daemon asserting it fails its own preflight and
refuses readiness permanently, on exactly the restart crash recovery exists to serve. What
remains is the shape v2 requires anyway: the root delegates and holds nothing, the per-sandbox
cgroups are the leaves that hold processes.

Reading a hypervisor's cgroup membership back after launch is a **test assertion**, not a runtime
step: it compensates for a delegation this arrangement no longer performs. The test reads
membership after the jailer has run rather than after the clone, because the clone is not the
step that could get it wrong.

**One kernel thread escapes all of this.** On x86 the hypervisor's in-kernel timer device is
serviced by a `kvm-pit` kernel thread that a guest drives by injecting timer interrupts, and it
belongs to the root cgroup by default (`references/firecracker-docs/prod-host-setup.md:179-181`).
The kernel creates it, not the launch: a guest's CPU, spent outside that guest's accounting and
outside its limit, on the layer we have just spent this section making load-bearing. The
hypervisor cannot move it, having dropped privilege by the time it exists, and upstream's own
remedy is for an external agent to do so
(`references/firecracker-docs/prod-host-setup.md:184-188`) — so the create path moves it
immediately after launch while the daemon still holds every privilege it needs. The node-level
alternative is a virtualisation module parameter, which is a
property of the machine rather than of a sandbox and is a node-preparation item in
[overview](../architecture/overview.md).

### Capacity invisible to the kubelet

Because Firecracker processes live in a cgroup outside the pod's subtree, the kubelet has no
idea they exist. A node running fifty sandboxes reports one small pod. Two obligations follow,
and neither is optional:

- **`vm-host` maintains its own admission headroom.** It tracks committed memory, vCPU, disk, and
  slots against a configured node budget, reserving a margin for the host itself. Nothing else
  will do this; the scheduler cannot see the load it would be scheduling against.
- **`vm-host` requests the capacity it hands out.** Its pod requests the memory and CPU budget it
  will allocate to VMs, not the few hundred megabytes the daemon itself uses. Without that, the
  scheduler sees a nearly empty node and places unrelated pods onto memory the VMs already hold,
  and the node resolves the contradiction with out-of-memory kills. The request is the only
  channel through which sandbox load is visible to anything outside this component.
- **`vm-host` carries a high scheduling priority**, so that node-pressure eviction does not
  select the one pod whose eviction would destroy every sandbox on the machine.

### Readiness, not taints

Whether a node can be removed underneath this daemon is not settled here. The sandbox node pool
is scale-out only by default, the honest resource request above is what makes that hold, and the
static do-not-disrupt annotation is a third line of defence written on the node pool at install
time rather than by this daemon at runtime — [overview](../architecture/overview.md) carries that
argument in full, along with why the `preStop` hook is best-effort and cannot be anything else.
What is node-local is what this daemon implements: it drains on `preStop` when it is asked to
stop and waits, and it gates traffic through readiness.

Traffic is gated through the **Kubernetes readiness probe**, not through taints. Taints control
what the Kubernetes scheduler places, and **sandboxes are not scheduled by Kubernetes** — they
are placed by `control-plane`, which watches the DaemonSet and treats readiness as the signal.
Readiness is also graded rather than binary: the node reports which artifacts it holds and how
complete they are, and placement treats warmth as a weight. A cold node still accepts work when
nothing warm has capacity, because slow beats refused.

## Configuration

Configuration is validated exhaustively at startup, and a validation failure means refusing to
become ready rather than starting with a default. The failure modes available to a
misconfigured privileged node daemon are severe enough that "start anyway and hope" is not an
option — a sandbox CIDR overlapping the cluster's pod or service network, for instance, is
refused outright rather than corrected.

| Group | Keys | Notes |
|---|---|---|
| Networking | Sandbox CIDR, slot pool target size, pre-warm rate, uplink interface, resolver address, egress **floor** deny list, per-sandbox concurrent-connection cap, slot drain delay | CIDR validated against the node's routes at startup. The deny list here is only the floor — identical on every node, unreachable by any tenant setting. A sandbox's own allow and deny lists arrive on the create call and are installed in that sandbox's namespace, so the effective policy is the intersection of two rulesets in two namespaces and a per-sandbox list can only narrow the floor. See [networking](../architecture/networking.md). |
| Capacity | Node memory budget, host reserve, maximum sandboxes, maximum vCPU oversubscription, disk budget, per-sandbox network and serial rate limits in operations and in bandwidth, per-sandbox cgroup block I/O limits | The inputs to admission, and the basis for the pod's own resource requests. The limits bound what one guest can take from the node's NVMe and uplink; the network ones are re-applied on every restore and the block ones live on the cgroup instead. A balloon target is not here — it is a property of the artifact, not of this configuration. |
| Cache | High and low watermarks, absolute cap, chunk size, fault-fill run length, fetch concurrency, background fill rate | See [snapshots](../architecture/snapshots.md) |
| Hypervisor | The set of VMM builds this node carries, each a version with its own binary **and its own jailer**; jail root path, cgroup hierarchy version, kernel identifier, descriptor limit for the launched process, serial and log sinks, per-call timeouts, graceful-stop budget before the cgroup kill; pinned digests for every binary in the set and for the guest kernel | A set rather than one binary, because the artifact names the version it needs and the node picks a build; a set of *pairs*, because a jailer is supported only against its own version. The set is bounded by which releases are still supported, not by how many have ever shipped. The jail root must resolve to the cache's filesystem, and the hierarchy version must be set rather than defaulted. |
| Guest agent | Capability quarantine list: agent build identifier to the capability bits to subtract | Reloadable without a restart, because its whole purpose is to respond to a sealed agent's bug faster than a fleet rebuild can. |
| cgroups | Cgroup root path outside the pod subtree, default CPU, memory, PID, and block I/O limits | The root must exist, be writable, delegate `cpu`, `memory`, `pids`, and `io` to its children, and hold no processes of its own; all verified at startup. The per-sandbox leaves delegate nothing onward, or the jailer cannot enter them |
| Lifecycle | Default and maximum deadline, handshake timeout, health check interval, usage sample interval, reclaim walk interval, snapshot concurrency, upload retry budget, drain budget | Drain budget must fit inside the termination grace period |
| Guest hardening | Maximum frame size, per-sandbox message rate, expensive-operation rate | Applies to every byte from the guest |
| Control and data plane | Listen addresses and host ports, verification key set and rotation, readiness thresholds | Verification keys only; no signing key on the node. The ports are fleet-wide, so they are part of the installation's contract with the cluster. |

## Observability

The dashboard question this component must answer is "why was this sandbox slow, and is this
node healthy?", so metrics are phase-resolved rather than aggregate.

| Metric | Why it earns its place |
|---|---|
| Create latency, broken out by phase: admit, acquire, jail, fetch, restore, handshake | An aggregate create latency tells you nothing actionable. The phase breakdown names the subsystem, and the jail phase in particular moves with the node's mount count rather than with anything we changed. |
| Cache hit ratio, bytes used, pinned bytes, evictions | The hit ratio is effectively the start-latency distribution, so it belongs on the main dashboard. |
| Userfaultfd faults, pages installed per fault, fault-service latency, **live fault handlers versus cold-path sandboxes** | The cold path's health; a low pages-per-fault figure means the fill run length is misconfigured, and any gap between handlers and the sandboxes depending on them is a set of guests that will hang at their next fault. |
| Snapshot duration by step, and the tenant-cgroup freeze window specifically | The interval between the guest confirming its freeze and the VM resuming is tenant-visible stall time and is the number to defend. Time waiting for freeze confirmation is reported separately, because a slow confirmation and a slow capture have different causes. |
| Pending uploads, their age, and retry-budget exhaustions | The pause-to-durable window. A sandbox reported paused whose upload is old is a sandbox one node failure from being lost. |
| Slot pool depth, pre-warm rate, scrub failures, reclaimed orphans | Slot exhaustion caps sandboxes per node before memory does, and a pool depth trending to zero means the background filler is losing to create rate. |
| Admission rejections by reason | Distinguishes a node at capacity from a node misconfigured to think it is. |
| Reclaim walk outcomes — adopted, reclaimed, killed-because-cold, unaccounted — at startup and on every timed sweep | Any non-zero unaccounted count is a leak and a bug. The cold-path kill count is expected but is a direct measure of what a restart costs tenants, and a timed sweep that keeps finding work means a guard path is broken. |
| Deadline enforcement kills | Should be routine; a spike means the control plane stopped extending. |
| Guest protocol violations and rate-limit trips, per sandbox | Attack signal and tenant-bug signal. |
| Network rate-limiter trips and cgroup block I/O throttling, per sandbox | One sandbox against its buckets constantly is a plan or placement question; many at once is a device at its ceiling. Without this the two look identical from the node's aggregate throughput. The two limits are read from different places, which is a consequence of where each can be enforced rather than a choice. |
| Health check outcomes, per sandbox | Reported and alarmed on, never acted on. A rise across a node is a node problem; a rise in one sandbox is usually a tenant working it hard, which is why it terminates nothing. |
| Control link state and time since last command | Distinguishes "no work" from "disconnected". |

Traces propagate the context supplied by `control-plane`, so a slow create is one trace spanning
admission, placement, and every phase on the node. Logs carry the sandbox identifier, epoch, and
operation identifier on every line. Tokens are redacted, and guest bytes are never logged —
sandbox output is tenant data and is deliberately not captured centrally.

### The hypervisor measures itself, and we read it

Everything above is what this daemon can see about a hypervisor from outside it. The hypervisor
also measures itself, emitting a JSON line per interval to a path we choose, and the questions
that record answers cannot be reached from here at all — most of them concern what the guest is
doing to the process, which is exactly the boundary this daemon cannot see across.

Ingesting it is cheap because of how the instances are arranged. The metrics configuration is
deliberately *not* carried in a snapshot (`references/firecracker-docs/metrics.md:7-8`), which
for a system that pauses and resumes would ordinarily be another thing to re-apply on every
restore; here it costs nothing, because every instance is a fresh process and the configuration
is set at launch. The path alone can be given on the command line, but the instance identifier
and the operator-defined properties cannot
(`references/firecracker-docs/metrics.md:52-57`), so the configuration goes through the API — the
sandbox identifier and epoch travel as properties, which is what lets one collector on a node
attribute a line to a sandbox.

Every group named below is one the hypervisor emits by default
(`references/firecracker-docs/metrics.md:156-177`).

| Group | What it answers that nothing on this side can |
|---|---|
| `seccomp` | A denial means the hypervisor attempted a system call its own filters forbid. That is a bug or an exploit in progress, it is the failure our security posture most depends on not happening quietly, and this counter is the only place it appears. |
| `signals` | The process's own fatal-signal accounting. A bus error here is the live mapping whose backing file went away — the exact failure the host-path volume requirement in [overview](../architecture/overview.md) exists to prevent, observed rather than argued about. |
| `uart` and `i8042` | Guest console volume: the unframed channel described above, in numbers. A sandbox that has reactivated its serial device shows up here and nowhere else. |
| `balloon` | What the guest actually returned against what was asked of it. Reported by the guest driver, so it is an indication and never a measurement, and it is read as the input to the stagnation rule rather than as an accounting of memory. |
| `net_{interface}` and `block_{drive}` | Per-device counters including limiter behaviour, at a granularity the node's aggregate device throughput cannot recover. |
| `latencies_us` | The hypervisor's own timing of snapshot creation and load. Our create breakdown brackets the restore from outside; this is the inside of it, and it is what separates a slow hypervisor from a slow fetch. |

Every group is emitted whether or not the corresponding device is attached
(`references/firecracker-docs/metrics.md:196-199`), so the per-line cost is fixed and known
rather than varying with the sandbox. Flushing is automatic on a one-minute interval or on demand
(`references/firecracker-docs/metrics.md:121-125`,
`references/firecracker-docs/api_requests/actions.md:22-24`), and the on-demand flush is used at
teardown: a process that goes away between flushes discards the interval covering the pause,
which is the one interval anybody was going to look at.

The hypervisor's *tracing* is a different matter and is deliberately not used. It is absent from
release binaries (`references/firecracker-docs/tracing.md:32-34`), so enabling it means building
and pinning a hypervisor of our own, and upstream measures the cost at more than ten times
(`references/firecracker-docs/tracing.md:68-69`). It is a tool for reproducing something on a
machine serving nobody. The production answer to the same question is the latency group above.

The hypervisor's log stream is configured once at launch and cannot be reconfigured afterwards
(`references/firecracker-docs/logger.md:5-6`), so its level and destination are launch decisions.
Like the console, its volume is influenced by the guest
(`references/firecracker-docs/prod-host-setup.md:48-51`), so it goes to a bounded sink that is
drained.

## Testing

Most of `vm-host` is testable without a hypervisor, and it is worth the design effort to keep it
that way, because a test suite that requires nested virtualisation runs on a fraction of the
machines and a fraction as often.

Three boundaries sit behind traits, each with an in-memory fake:

| Trait | Real implementation | Fake |
|---|---|---|
| VM handle | The typed hypervisor client over its unix socket | An in-memory VM that records calls, can be told to fail any specific call, and can be told to hang |
| Object store | S3-compatible client | An in-memory bucket with injectable latency, partial reads, and failures |
| Guest transport | vsock carrying [vm-protocol](vm-protocol.md) | A scripted peer that can answer, stall, close, or emit malformed and oversized frames |

On top of those:

- **The state machine gets an exhaustive transition table test.** Every state paired with every
  command is asserted to produce either the documented transition or the documented rejection.
  Because the enum is matched exhaustively in the implementation, adding a state breaks
  compilation; because the table is exhaustive in the test, adding a state also fails the test
  until its behaviour under every command is stated. The compiler catches the missing handler,
  the table catches the unconsidered semantics.
- **Crash injection kills the daemon at randomised points in the pause sequence** and restarts
  it. Three assertions hold after every run: no orphaned hypervisor processes, cgroups, slots,
  jails, sockets, or disks; no host-side rule left referencing a returned slot; and no
  half-published artifact — every artifact either has a manifest and is complete, or has no
  manifest and is invisible. The daemon is killed with a signal it cannot handle at least as
  often as with one it can, because the case the lease file exists for is the one where no
  destructor ran. The same harness covers the create and reclaim paths.
- **Cgroup membership after launch is asserted here rather than read back at runtime**, and rate
  limits are asserted after a *restore* rather than after a create — a snapshot taken under one
  set of limits, restored under another, with every bucket in both directions read back off the
  running VM, because a patch that merges makes a partially re-applied limit look like a
  correctly applied one. Both are guarantees the production path is supposed to make
  structurally, which is exactly why the only thing that can keep them true across a change to
  the launch or restore path is a test.
- **Generation tests interleave a destroy and a same-node recreate** of one sandbox identifier,
  running the first instance's teardown after the second instance has written its lease, and
  assert that the second instance's lease, disk, cgroup, and sockets are untouched. This is the
  failure that resume affinity makes likely and that nothing else in the suite would produce.
- **Ingress-policy tests** cover absent exposure, one explicitly public tenant port, a different
  private port on the same sandbox, the reserved agent port, revision ordering, and public-to-
  private revocation while a gateway still holds stale policy.
- **Hostile-guest tests** drive the malformed-peer fake against the data plane and assert that
  the daemon bounds memory, terminates the offending sandbox, and does not disturb its
  neighbours.
- **Only the end-to-end suite needs real virtualisation.** It runs on real nodes, covers the
  paths the fakes cannot honestly model — actual restore, actual page sharing, actual CNI
  coexistence — and is the gate before rollout, not the inner development loop.

Notably absent is a large concurrency-model-checking effort. Exclusive ownership means there is
almost no shared mutable state within the daemon for such a tool to explore, so the interleavings
it would search are mostly not reachable. That is a narrower claim than "the concurrency risk was
designed out", and the difference matters: the races that remain are not between tasks inside one
process but between a process and the state it left on the node — a teardown racing a recreate, a
reaper entry outliving its daemon, a reclaim racing an adoption. Those live in the filesystem and
the kernel rather than in memory, no model checker over the program's types would see them, and
they are exactly what the crash-injection and generation tests exist to find. The effort goes
there because that is where the risk actually is.

## Rules that must not be violated

1. **One task owns one sandbox's resources.** No resource belonging to a live sandbox is ever
   placed in a shared map or handed to another task for mutation.
2. **No lock is held across an await point.** The registry lock exists to clone a sender and for
   nothing else.
3. **No critical section appears as a branch of a construct that can abandon it.** Pause,
   snapshot, and restore run in tasks that are never dropped part-way; cancellation is a flag
   checked at step boundaries.
4. **Every command is idempotent by operation identifier.** A retry returns the original result.
5. **Every sandbox data-plane request is authorized locally.** Private ports require a token;
   anonymous access requires active `public` exposure for that exact tenant port. The agent port
   can never be public. The kubelet probe listener is separate and exposes no sandbox surface.
6. **Credentials are stripped before anything reaches the guest.** Private requests arrive with
   the original token or cookie for this component to verify and remove. Public requests require
   none, and any platform credential still present is removed defensively.
7. **No guest-supplied value names a host file, addresses a peer, or indexes a privileged
   operation.** Host-side identifiers only.
8. **Nothing shells out in the pause, restore, or teardown path.**
9. **Every host-side name carries the epoch**, and every teardown deletes only its own
   generation. The exception is the three names a snapshot records for itself — the tap device,
   the block file, and the transport socket — which are identical for every instance and are
   disambiguated by the namespace and the jail enclosing them, because a restore requires them
   unchanged.
10. **The lease is the leak guarantee; scope guards are an optimisation.** No resource is
    acquired before its lease is written and fsync'd, whatever the guards do afterwards.
11. **An instance exists if and only if its cgroup directory exists.** The lease carries metadata
    about an instance and is never evidence that one is running.
12. **Adoption reads the hypervisor's process id out of the cgroup**, verifies membership once
    through the descriptor it then opens, and holds that descriptor for exit notification only.
13. **The discoverable anchor is deleted last** — the named namespace after its contents, the
    lease file after every resource it names.
14. **The hypervisor is killed by writing `cgroup.kill`**, and the kill is complete only when
    `cgroup.events` reports the cgroup unpopulated. No teardown names a process or a process
    group.
15. **Jail contents are hard-linked from the cache, never copied — except the hypervisor
    binary**, which the jailer always copies on purpose. The jail root and the cache share a
    filesystem, and the node stays unready if they do not. A linked artifact is read-only and
    reachable through a shared group; only what a sandbox may write belongs to that sandbox's
    own identity.
16. **The hypervisor is launched into a cgroup this daemon created**, by cloning into it rather
    than by being moved afterwards, and never into the pod's own cgroup subtree. The jailer is
    given that same cgroup as its parent argument, so the move it would otherwise make is a
    no-op rather than a relocation.
17. **Guest network rate limits are re-applied in full on every restore** — both directions, both
    buckets, no limit written as an explicit zero — before the VM is resumed, and the values the
    snapshot carries are never trusted. Guest block I/O is bounded by the sandbox's cgroup, which
    no snapshot carries.
18. **A failed health check never terminates a sandbox.** Termination requires hypervisor exit,
    deadline expiry, a protocol violation, or the loss of a fault handler.
19. **The file memory backend is used only when the local memory file is complete.** A private
    mapping over a partial sparse file reads zeros silently.
20. **A demand-paged sandbox is never adopted across a daemon restart.** Its fault handler is
    gone; it is killed rather than left to hang at its next fault.
21. **A pinned artifact is never evicted**, and a snapshot whose upload is outstanding is pinned.
22. **The full restore compatibility key is checked before restore is attempted**, not after it
    fails. The VMM version is not part of that key: it selects which of the node's hypervisor
    builds to launch, because filtering on it would strand every paused sandbox for the length of
    a rollout.
23. **The event-read path of a fault handler holds a lock its workers never touch.** A shared
    lock is a deadlock, not a slow path: the balloon's discard blocks in the kernel until the
    event is drained, and a worker can be blocked on object storage.
24. **A node that fails preflight verification stays unready.** It does not attempt repair and it
    does not start anyway. Preflight includes that the node can run a virtual machine at all, and
    that every hypervisor build, its own jailer, and the guest kernel match their pinned digests.
    Only release builds are pinned; a debug build carries no default system-call filters.
25. **The daemon writes nothing to the Kubernetes API.** Its service account reads.
26. **The state enum is matched exhaustively.** No catch-all arm, anywhere.
