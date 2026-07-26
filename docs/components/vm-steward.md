---
type: Component
title: vm-steward
description: The in-guest agent that spawns processes, streams I/O, performs filesystem operations, relays localhost ports, and runs the lifecycle hooks, over vsock only.
tags: [component, guest, vsock, agent, process, pty, cgroup, snapshot]
timestamp: 2026-07-27T07:33:00Z
---

# vm-steward

`vm-steward` is the only program inside a sandbox that [vm-host](vm-host.md) talks to. Every
process the tenant runs, every file they read, and every published port they serve becomes a
syscall made by this agent.

Its defining constraint is that it is **sealed into snapshots**. The binary present in a
template is the binary that will run for every sandbox derived from that template, for as long
as the template exists. There is no rollout, no canary, and no way to patch a running fleet:
the only way to change the agent is to rebuild templates, and paused snapshots taken before
that rebuild will still resume the old one. Everything below — the size budget, the absent
dependency set, the refusal to grow features, the capability negotiation in
[vm-protocol](vm-protocol.md) — follows from that one fact.

## Purpose

Do the small set of things that genuinely require a syscall inside the guest, and nothing else.
The interesting policy — who may call, what a sandbox is allowed to do, when it dies — lives on
the host, where it can be changed on a deploy cadence rather than a template-rebuild cadence.

### The memory budget is a design constraint, not a preference

The agent is a statically linked musl binary with no dynamic loader, and its resident-memory
budget is **two numbers rather than one**: under 10 MB idle, and a worst case of that figure
plus the aggregate output-ring cap and the per-sandbox relay cap. Stating only the first
describes an agent with nothing in flight, because those two caps *are* the configured output
buffers this component is otherwise measured exclusive of — so the number that actually sets
snapshot size and warm-restore page sharing is the one nothing was quoting. Both are ceilings,
and below both are measured.

It has **no garbage collector**, and that matters far more than the binary size.

A collector periodically walks the heap, touching pages the program is not logically using.
Every page it touches is a page the guest has written, and in this system a written page is
expensive twice over. It becomes a dirty page in the next incremental snapshot, inflating pause
cost and artifact size. And it becomes a private copy in a warm restore, where clean pages are
otherwise shared between every sandbox on the node restored from the same template — the
sharing property described in [snapshots](../architecture/snapshots.md) that determines how
many sandboxes fit on a machine. An idle agent that quietly dirties a few megabytes every
collection cycle would erode that sharing across the whole fleet, on every node, forever.

The target is an idle `vm-steward` that dirties nothing, and it is a target enforced by a test
rather than a property the code gets for free. An async runtime with timers wakes on a cadence,
touches its own stack and timer state, and dirties a little of both, so "no pages at all" is
only true of a program genuinely blocked in a syscall with nothing armed. CI holds a sandbox
idle for a fixed interval, reads the guest's dirty-page count across it, and fails the build
above a ceiling — which makes the budget a number that regresses visibly instead of a claim
nobody checks.

The saturated ceiling is measured the same way and is the one that needs saying, because it is
the case a busy sandbox is in when it gets paused. CI drives a sandbox until the aggregate ring
cap is full and the relay cap is held open, measures resident memory there, and fails above the
second ceiling. A worst case that is derived on paper rather than reached in a test is a number
nobody finds out is wrong until a node's density figure is.

## Responsibilities

| Area | Operations |
|---|---|
| Process | Spawn via raw argv or via an explicit shell, with or without a PTY. Stream stdout, stderr, and stdin. Resize the PTY. Deliver signals. Reap and report exit status. |
| Filesystem | Stat, list, make directory, move, remove. Chunked read and chunked write. |
| Watches | Recursive subtree watches over inotify, with explicit overflow reporting. |
| Network | On-demand relay from the host to a guest loopback port; enumeration of listening sockets. |
| Statistics | Guest filesystem usage, and the used-versus-page-cache split of guest memory. The two figures the host cannot obtain from outside. |
| Lifecycle | Post-restore hook, pre-pause quiesce, and freeze and thaw of the tenant cgroup and of the guest filesystem — all driven by the host. |

## Explicit non-responsibilities

| Not responsible for | Why |
|---|---|
| Authentication | The occupant is root inside the guest. See [no authentication](#it-performs-no-authentication). |
| The public API shape | Public request and response types live in [control-plane](control-plane.md) and the SDK. `vm-host` translates. A sealed component must not carry types that change whenever the product does. |
| Deciding lifecycle | The host is authoritative. A sandbox cannot veto or delay its own pause or destruction. |
| Serving HTTP | It has no HTTP server, no router, and no JSON surface. |
| Networking policy | Egress rules, address assignment, and public exposure are host-side. See [networking](../architecture/networking.md). |
| Anything not needing a guest syscall | If the host can do it, the host does it. |

## Internal structure

```
                          vsock listener (one well-known port)
                                    │
                     ┌──────────────┴──────────────┐
                     │  session: handshake, epoch, │
                     │  stream demultiplexing      │
                     └──────────────┬──────────────┘
        ┌───────────────┬───────────┼───────────┬────────────────┐
        ▼               ▼           ▼           ▼                ▼
   process table    filesystem    watches     relay          lifecycle
        │            (chunked)   (inotify)  (loopback)      (hooks, RAII
        ├─ ring buffers                                      thaw guard)
        ├─ pty pairs
        └─ tenant cgroup
```

Each box is a module with no knowledge of the transport beyond a stream handle, so the whole
agent can be driven in tests over a unix socket instead of vsock.

## Interfaces

### Inbound

One vsock listener on a fixed port, speaking [vm-protocol](vm-protocol.md). `vm-host` connects
in; the agent never dials out and never initiates an operation.

**It never binds a TCP or UDP port.** This is not a hardening detail bolted on afterwards — it
is the reason the management surface is not reachable from any network the tenant can route to.
There is no port for a tenant process to discover, no metadata endpoint to spoof, and nothing
reachable from the sandbox network. Anything that would require a listening socket is therefore
structurally out of scope for this component.

That the vsock listener is also unreachable from *inside* the guest is a property of the guest
kernel configuration rather than of this design, and the claim has to be stated conditionally.
With vsock loopback compiled out — the configuration the template build asserts, per the kernel
requirements in [vm-protocol](vm-protocol.md) — a guest process connecting to the guest's own
context identifier is dropped by the transport, and one connecting to the local context
identifier is dropped by the device. Built against a kernel with loopback enabled, the same
agent presents a connectable control channel to tenant code. This is not a tenant-isolation
boundary either way, because the occupant is root and can read the agent's memory regardless;
what the assertion buys is that the control channel is not a *service* inside the guest that a
compromised dependency of the tenant's own program could dial without first becoming root. The
assertion belongs in the template build because that is the last moment at which the kernel and
the agent are chosen together — afterwards both are sealed into the same artifact.

### Outbound

Kernel interfaces only:

| Surface | Used for |
|---|---|
| `clone3` with `CLONE_INTO_CGROUP` and `CLONE_PIDFD`, then `execve` with a pre-exec hook | Spawning tenant processes directly into their cgroup, with a descriptor for the child |
| `/dev/ptmx` and `/dev/pts` | PTY allocation and resize |
| cgroup2 under `/sys/fs/cgroup` | Tenant cgroup membership, freeze, thaw, kill |
| `pidfd_send_signal` | Signal delivery, addressed by descriptor rather than by pid |
| `inotify` | Subtree watches |
| `sock_diag` over netlink | Enumerating listening sockets without walking `/proc` |
| Loopback `connect` | The port relay |
| `FIFREEZE` / `FITHAW` | Filesystem freeze and thaw, for filesystem-only artifacts and the builder's seal — never around a memory capture |
| `setpriority`, `ioprio_set`, `oom_score_adj` | Applied in the child before `exec`, and before the credential drop |
| `clock_settime`, `sethostname` | Applied by the post-restore hook |
| `/dev/urandom` with `RNDADDENTROPY`, then `RNDRESEEDCRNG` | Reseeding the guest's random pool after a restore. Two ioctls rather than one, and both need `CAP_SYS_ADMIN` in the guest |
| `/etc/machine-id` | Regenerating the machine identity in the post-restore hook, after the reseed |
| The file bind-mounted over `/proc/sys/kernel/random/boot_id` | Regenerating the boot identifier in the same step. An ordinary write to that file, because the procfs entry itself cannot be written; [vm-init](vm-init.md) establishes the mount at boot |
| `statfs`, `/proc/meminfo` | The two guest statistics the host cannot obtain from outside |
| `/etc/passwd`, `/etc/group` | User resolution |

User resolution reads those two files directly rather than going through the name service
switch. **The constraint is the C library, not static linking:** the implementation this binary
links against has no name-service-switch mechanism at all, so there are no modules to load and
nothing that dynamic linking would restore. This is a deliberate limitation rather than an
oversight: a guest is a single-tenant image, not a machine attached to a directory service, so
file-backed resolution is the complete answer.

## State owned

| State | Lifetime | Notes |
|---|---|---|
| Process table | Until the process exits and its record expires | Keyed by an agent-assigned process ID, not a pid. See [process identity and record expiry](#process-identity-and-record-expiry) |
| Process descriptors | One per live child | Obtained at clone; how signals are addressed |
| Output ring buffers | With the process record | Bounded per process and capped in aggregate |
| PTY master descriptors | With the process | |
| Watch descriptor trees | Until the watch stream closes | One kernel watch per directory |
| Relay connections | Per relayed connection | Capped per sandbox |
| Environment and metadata | Replaced by the host at restore | Never persisted to disk, never logged |
| Current epoch | Set at handshake | |
| Tenant cgroup handle | Process lifetime | |
| Per-freeze disruption marker | With the freeze it belongs to | Whether a clock disruption has been observed since that freeze was taken. Captured clear into the artifact and set on the restored side, which is what makes the rule in [split by cause](#the-auto-thaw-deadline-is-split-by-cause) work |

All of it lives in guest memory, which means **all of it is captured by a snapshot**. A resumed
sandbox still has its process table, its PTYs, and the output produced before the pause. What
does *not* survive is anything held on the host side of the connection; see
[vm-protocol](vm-protocol.md).

### Process identity and record expiry

The agent-assigned process ID and the kernel pid solve different problems, and conflating them
produces a specific bug.

The assigned ID prevents **table aliasing** and nothing else. IDs are monotonic and never
reused, so a client holding one from before a restore can never be silently handed a different
process. It does not make signal delivery safe, because the record still contains a kernel pid,
and between a process exiting and the agent noticing, the kernel is free to recycle that number.
A signal sent to a recycled pid lands on an unrelated process — plausibly one the tenant spawned
deliberately to occupy the slot. **Signals are therefore delivered through the process
descriptor obtained when the child was cloned.** A descriptor refers to that process and no
other, and once the process is gone it fails cleanly instead of hitting a stranger.

Signalling a process *group* is the residual case, because the kernel offers no descriptor for
one. The agent sends group signals only while it still holds a live descriptor for the group
leader, which narrows the window without closing it, and the operation that must be exact —
terminating a whole tree — uses `cgroup.kill` instead, which is not addressed by pid at all.

**Record expiry** has a stated policy rather than an implied one. A terminated process's record
— exit status and whatever remains in its rings — is retained for a bounded interval after exit,
and the table is separately capped by count, evicting the oldest terminated records first. Live
processes are never evicted. The interval is measured on the **monotonic clock**, deliberately:
it does not advance while the VM is paused, so a sandbox paused for a week resumes with its
records intact, and a client reattaching after the restore finds the exit status it was waiting
for rather than a table emptied by wall-clock time the guest never experienced.

Waiting on or attaching to a record that is gone has a defined answer, and it separates the two
cases a bare `NOT_FOUND` would blur. Because IDs are monotonic, an ID at or below the highest
ever issued but absent from the table was necessarily expired, while anything above it was never
issued. The first returns `FAILED_PRECONDITION` naming the retention interval; the second
returns `NOT_FOUND`. One integer of extra state buys the difference between "your process
finished and you asked too late" and "you asked for something that never existed", which call
for opposite responses from a client.

## Key flows

### Spawning: two primitives, deliberately

There are two spawn operations and they are not interchangeable.

- `exec` takes a **raw argv vector**. The agent passes it to `execve` unmodified. No word
  splitting, no globbing, no variable expansion, no quoting rules.
- `shell` takes a command line and **explicitly** runs it under a shell.

Nothing is implicitly wrapped in a shell. The reason is that implicit wrapping converts every
argument containing a space, a quote, a dollar sign, or a semicolon into a parsing question,
and the caller — typically an SDK building a command from user data — has no way to opt out. A
filename becomes a command substitution. The argv-first primitive removes the class entirely,
and callers who genuinely want a pipeline, a redirect, or a glob ask for a shell by name, which
also makes the choice visible in logs and audit records.

Priority settings follow the same principle. Process priority, I/O priority, and OOM score
adjustment are applied **in the pre-exec hook of the child**, not by prefixing the command with
helper binaries. Wrapping would require those binaries to exist in the tenant's image, insert
an extra process into the tree so the reported pid is not the tenant's process, and reintroduce
exactly the quoting problem `exec` was designed to avoid.

I/O priority is applied on the understanding that it may do nothing. It is honoured only by a
block scheduler that implements priority classes, and nothing in the template contract pins
which scheduler the guest runs. The setting is best-effort, and no behaviour anywhere is built
on the assumption that it took effect.

### The tenant cgroup

Every tenant process is created **directly inside a dedicated cgroup**: the placement is part of
the clone, so there is no window in which the child exists outside the group and no way for a
fast-forking child to escape before it can be moved. The kernel preconditions that atomic
placement depends on are part of the sealed contract in [vm-protocol](vm-protocol.md).

That cgroup is the unit the host operates on. Killing it terminates the whole tree without the
agent walking a process list that a hostile occupant can grow faster than it can be read, and
freezing it is how tenant execution stops for a pause.

**The freeze is not atomic.** Writing `1` to `cgroup.freeze` *requests* a freeze; it does not
perform one. The write returns immediately while the kernel stops each task at its next
signal-delivery point, and the only way to know the transition finished is to read `frozen` from
`cgroup.events`. Two things make that gap real rather than theoretical. The operation races
`fork`, so a task forking mid-freeze can leave a running child behind. And a task in
uninterruptible sleep — anything blocked in the kernel on I/O — cannot be stopped until it
returns, which is unbounded from userspace. The agent therefore writes, then **waits for
`frozen=1` under its own deadline**, distinct from the host's, and reports which of the two
outcomes it got. A capture that proceeds without the confirmation is still a valid snapshot; it
is crash-consistent with respect to tenant writes rather than quiesced, and the host has to know
which one it took.

The agent itself sits outside that cgroup and carries a **protective OOM score**, so under
memory pressure the kernel reaches for tenant processes before the component that would
otherwise be needed to report what happened.

### The pre-exec hook

The hook runs between the clone and the `execve`, in a child that has inherited the address
space of a multi-threaded parent but has only one thread in it. Only a restricted set of
operations is safe there: no allocation, no lock acquisition, no arbitrary library calls. Every
string, path, and descriptor the hook needs is built in the parent beforehand, and the hook
performs only syscalls against already-prepared values. **Every return value is checked and a
failure aborts the child**, because a hook that ignores an error produces a process running with
the wrong identity, the wrong limits, or the wrong terminal, and nothing downstream can tell.

The order is not arbitrary. The credential change is a one-way door, and three settings have to
precede it:

| Step | Must precede the credential drop because |
|---|---|
| `oom_score_adj` | Afterwards it can only be raised. A tenant process that should be the preferred OOM victim has to be marked while privilege remains |
| `setpriority` | Afterwards priority can only be lowered; a nice value given away cannot be reclaimed |
| `ioprio_set` | Afterwards the I/O priority class cannot be raised |

The full sequence is: reset the signal mask and dispositions; apply the three settings above;
establish the session and controlling terminal if this is a PTY-backed process; then
`setgroups`, `setgid`, `setuid`, in that order and no other; then `exec`.

**Resetting the signal mask is the step most easily omitted and the one with the worst symptom.**
A blocked signal mask **survives `execve`**. [vm-init](vm-init.md) blocks signals so it can
consume them through a signalfd, so unless the mask is restored between clone and exec it is
inherited by `vm-steward`, and then by every tenant process the agent spawns. The result is a
tenant shell that silently ignores interrupt and terminate, with nothing in that process's own
configuration to explain why and no error reported anywhere. Dispositions need the same
treatment for a different reason: `execve` resets installed *handlers* to the default, but
signals set to **ignore stay ignored** across it, so an inherited ignore disposition is every
bit as durable as an inherited mask.

The `setgroups`, `setgid`, `setuid` ordering is the familiar rule, and the familiar
justification for it is wrong in a way worth correcting. Reversed, the group calls do not fail
*silently* — they return an error, like any other refused syscall. What makes the reversal
dangerous is not that the kernel hides it but that a hook which ignores return values hides it,
leaving a process that kept group membership it should not have. The operative rule is therefore
the return-value rule, not the ordering rule: get the order right, then check that it worked.

### Descriptor hygiene

The agent holds descriptors a tenant process must never see: the control channel to the host,
the PTY masters of every other session, the cgroup directory descriptors used for placement and
freezing, and the inotify watch descriptors. Any of them surviving an `exec` into tenant code is
a containment hole, and the control channel is the severe case — a tenant process holding that
descriptor holds the management channel itself and can speak the protocol as though it were the
agent, from inside a sandbox whose entire design assumes it cannot reach that channel.

**Every descriptor is therefore opened close-on-exec at creation**, never marked afterwards, and
the small set the child genuinely needs — its own standard streams, its own PTY slave — is
cleared deliberately in the hook. Setting the flag after the fact is not equivalent: between the
open and the `fcntl` there is a window in which another thread can fork, and this agent forks
from an async runtime with more than one thread in it.

### PTY sessions

A PTY is not a pipe with a resize call attached. Four of its properties have to be handled
explicitly, and each of them, mishandled, presents as a bug somewhere else.

**The child must create a new session and set the controlling terminal.** Without `setsid` and
then making the slave its controlling terminal, the process has no controlling terminal and the
terminal has no foreground process group — so the kernel has nobody to deliver `SIGINT` to and
the interrupt character does nothing. This is the failure that gets reported as "interrupt
doesn't work in the sandbox", and it is not a signal-delivery bug; it is a missing session.

**Reading a PTY master returns an I/O error, not end-of-file, when the last slave closes.**
Every session ends that way, so an agent that treats the error as an error reports a spurious
failure at the end of every single session. The agent maps it to normal end of stream and lets
the process's exit status be the outcome; a genuine error on that descriptor is distinguished by
the process still being alive.

**A PTY carries one stream, so the separate stdin-close operation is meaningless against it.**
There is no half to close — the master carries both directions on one descriptor, and closing it
tears the session down rather than signalling end of input. The operation is rejected with
`INVALID_ARGUMENT` and a message naming the alternative: send the end-of-transmission character,
which is what a terminal-aware program is waiting for in any case. Accepting it silently would
leave a client waiting for an end of input its program will never observe.

**A PTY-backed process is started when the PTY is allocated**, in one operation; there is no way
to allocate a terminal now and spawn into it later. A master with no process on the slave side
has no good behaviour available. Either it is immediately at end of stream, which is wrong, or
the agent holds a slave descriptor open to prevent that — and a held slave means the master never
reports the session ending, which converts an event into a poll and destroys the exit signal the
client actually wants.

### Output streaming and the ring buffer

Each process's output is written into a **bounded ring buffer** carrying monotonically
increasing sequence numbers. A PTY-backed process has one stream, because a PTY is a single
device; a non-PTY process has separate stdout and stderr rings.

A client that disconnects and reconnects reattaches by naming the last sequence number it
observed. The agent resumes from there.

The honest statement of what this guarantees:

- Bytes are delivered **in order** and **never duplicated**.
- If the client is keeping up, nothing is lost.
- If the producer outruns the consumer far enough to wrap the ring, the **oldest** bytes are
  dropped, and the next delivery carries an explicit gap descriptor naming the sequence range
  and byte count that were discarded.

Loss is bounded and always reported. It is never silent. The two alternatives are worse: an
unbounded buffer lets a process printing in a tight loop exhaust guest memory and take the
sandbox down, and blocking the writer changes the tenant program's behaviour depending on
whether anybody happens to be reading — a process that runs fine when observed and hangs when
not is the least debuggable outcome available.

Ring size is per process, and the total across all processes is capped, so spawning many
chatty processes cannot defeat the memory budget one buffer at a time.

### Watches

inotify is not recursive in the kernel, so a recursive watch is a tree of watch descriptors the
agent maintains itself: one per directory, added as directories appear. Two consequences are
surfaced rather than hidden.

A subtree created between the `mkdir` event and the installation of its watch would be missed,
so directory creation triggers a rescan of the new subtree and synthesises the events the
watch would have produced. And when the kernel's event queue overflows, the agent emits an
explicit overflow event instead of continuing as though nothing happened, because a watch that
has silently lost events is worse than one that admits it and asks the client to rescan. Watch
counts are bounded and a subtree that exceeds the limit fails loudly.

### Port relay

When the host receives traffic for a published port it opens a relay stream, and the agent
connects to `127.0.0.1:<port>` or `[::1]:<port>` from inside the guest and copies bytes both
ways. Connections are made on demand — a connect to a port nothing is listening on simply
returns an error — so there is no per-port helper process and nothing to configure when a tenant
starts a server. The reasoning for choosing an in-agent relay over the netfilter and
per-port-forwarder alternatives is in [networking](../architecture/networking.md).

**Enumerating listening sockets is still a poll.** The netlink socket-diagnostic interface is a
*dump* interface: it answers "what is listening right now", and the kernel sends no notification
when a socket begins listening. Event-driven discovery would mean attaching a probe to the
kernel's listen path, which is a kernel-version-coupled dependency this component is in the
worst possible position to carry, since it cannot be updated after a template is sealed. So
`ListPorts` is a dump, and anything that needs to observe a port *appearing* runs that dump on a
timer. Relaying on demand takes the poll out of the data path, which is what matters for latency
and for idle cost, but it does not answer the product question "tell me when my server is up" —
that answer is a host-side timer over this operation, and it should be recognised as one rather
than described as event-driven.

**Half-close is carried in both directions,** because without it the request-response protocols
most likely to be published break silently. When the host half-closes its write side, the agent
shuts down the write side of the loopback socket and keeps reading, so a server that waits for
end of input before responding gets it. When the loopback peer closes its write side, the agent
reports a half-close on the stream and keeps copying the other direction. The stream ends when
both directions are closed or either errors, and a reset from the guest side is reported as an
error rather than a clean close, so a client can distinguish a complete response from a
truncated one.

**Concurrent relay streams are capped per sandbox.** Each costs a guest socket, two buffers, and
a task, so an uncapped relay converts inbound connections on a published port into guest memory.
Past the cap, new relay streams are refused with `RESOURCE_EXHAUSTED` rather than queued —
queueing converts a refusal the caller can react to into a latency spike it cannot.

One consequence of relaying rather than routing surprises people debugging their own
applications, so it is worth stating outright: **the tenant's server sees every relayed
connection arriving from loopback.** The peer address is `127.0.0.1`, so per-address rate
limiting inside the tenant application sees a single client, address-based allow-lists inside it
mean nothing, and its access log records the relay. Carrying the real client address is the
ingress layer's job and is done with a header there — see
[networking](../architecture/networking.md) — not by this component. The matching constraint is
that **a server bound to a specific non-loopback address is unreachable**: the agent connects to
loopback, so a process bound only to the guest's external address never receives the connection,
and the only evidence anywhere is a refused connect inside the guest. Binding loopback or the
wildcard address is a requirement, not a convention.

### Guest statistics

Most of what anyone wants to know about a sandbox's resource use, [vm-host](vm-host.md)
computes from the sandbox cgroup without asking the guest anything: CPU time and total memory in
use are both visible from outside, and by the rule that nothing becomes a capability here unless
it needs a guest syscall, that is where they stay. Two figures are not visible from outside, and
this operation exists for exactly those two.

**Guest filesystem usage** is invisible from the host because the host has no filesystem to
look at. It has a block device. How much space is free is a question only the guest's own
filesystem can answer, and the outside view — allocated extents — says nothing about deleted
files, sparse regions, or reserved blocks. The agent answers with `statfs`.

**The used-versus-page-cache split of guest memory** is invisible for a subtler reason: from
outside, all of guest RAM looks allocated, because it is. Nothing on the host can distinguish a
page a tenant process is using from a page holding cached file contents the kernel will drop the
moment anything asks for memory. That split is the input to any honest answer to whether a
sandbox is about to be out-of-memory killed, and it is what makes the pre-pause reclaim pass in
[snapshots](../architecture/snapshots.md) measurable rather than asserted. The agent answers by
parsing `/proc/meminfo`.

The operation is unary, behind its own capability bit, and deliberately does no arithmetic: it
reports what the two kernel interfaces returned and leaves rates, deltas, and thresholds to the
host, which can change its mind about all three on a deploy cadence. It is here in v1 because a
`statfs` and a `/proc/meminfo` parse cost the sealed agent almost nothing, and because a
capability that is not reserved before the first template ships cannot be added later without
rebuilding every template in the fleet.

### Post-restore hook

A restored guest wakes believing that no time has passed. From inside, the instant of the
snapshot and the instant of the restore are adjacent, which for a sandbox paused overnight
means every process observes a clock that is hours wrong. TLS handshakes fail against
not-yet-valid or long-expired certificates, timers that should have fired have not, and any
log written by a tenant process is misdated.

The hook is delivered by a host-side **retry loop**, because the control channel is not usable
the instant a restore returns — see
[vm-protocol](vm-protocol.md#the-channel-is-not-usable-when-the-restore-returns). Every step
below is therefore written to be idempotent, and the first one is only idempotent because it was
designed to be.

**It also arrives on a new connection, every single time.** Creating the snapshot sends a
transport reset to the guest's vsock driver, and when the restored VM's vCPUs run the driver
closes every connection that was open. The listen socket survives, with its context identifier
updated to the restored VM's, so the agent is reachable again without doing anything at all — but
the connection the pause was requested over is gone, and the hook cannot arrive on it
(`references/firecracker-docs/snapshotting/snapshot-support.md:643-655`). What follows for this
component is a discipline rather than a mechanism: **a connection ending is not an error
condition here.** It is the ordinary shape of a pause. The agent tears down the streams that
belonged to that connection, keeps everything that belongs to itself — the process table, the
rings, the watches, the tenant cgroup handle and the freeze it is holding — and waits to be
connected to again. An agent that reported a dropped connection as a fault, or that treated one
as a reason to discard state, would do so on every restore in the fleet, and the noise would be
indistinguishable from the signal on the one occasion it mattered.

1. **Step the realtime clock** to the host-supplied wall time, within a tolerance window. The
   host supplies the time because the guest has no trustworthy source; there is no network yet
   and no reason to add one.
2. **Re-apply environment, metadata, and the hostname**, which arrive over vsock at this moment
   and are never baked into an artifact — see [security](../architecture/security.md) on secrets.
3. **Reseed the guest's random pool** with host-supplied entropy.
4. **Regenerate the machine identity and the boot identifier**, after the reseed so that both are
   derived from a pool that has already been given fresh randomness.
5. **Thaw the tenant cgroup**, releasing the processes frozen before the capture.

The thaw is last, and that is the ordering constraint the whole list hangs on: the thaw is
precisely what allows tenant code to execute, so everything that must be true before tenant code
runs has to be finished before it.

**Stepping the clock has to be bounded.** A step is not a quiet assignment: it fires every
absolute timer whose deadline has passed and cancels every timer armed to be cancelled when the
clock is set — machinery that exists so programs can detect exactly this. A hook delivered by a
retry loop that stepped unconditionally would inflict that on the guest once per attempt. The
hook applies an **asymmetric tolerance window** instead. It steps when the guest clock is behind
by more than a small threshold, which is the ordinary case after a pause and the one worth
correcting, or ahead by more than a few seconds; inside the window it does nothing and reports
success. The asymmetry is deliberate: being slightly ahead is harmless, while stepping the clock
backwards is the more destructive direction and needs a larger error to justify it.

**The host re-stamps the wall time on every attempt** rather than computing it once before the
first. The tolerance window already gets close to the right answer — a stale value inside the
window is not applied at all — but a retry loop against a slow guest can run for seconds, and
re-stamping is strictly more accurate over that interval for no cost on either side. Ordering
between attempts is then settled by **last-write-wins on a monotonic stamp in the payload**: an
attempt older than one already applied is discarded. That is a cheaper idempotency mechanism
than a general key for this one operation, and a more honest one, since successive attempts
legitimately carry different times and are not retries of identical bytes.

**Reseeding is not optional, because every sandbox restored from one template starts with the
same random state.** The property that makes restores fast — identical guest memory — applies to
the kernel's random pool as well, so session keys, temporary filenames, hash seeds, and anything
else derived from guest randomness are identical across every sandbox from that template until
something reseeds. The generation-identifier device does reseed the kernel on resume and it is
the right primitive, but it does not close the window by itself: there is a gap between the
vCPUs resuming and the reseed landing, and the thaw is what lets tenant code run inside that
gap. Upstream describes the same gap in the same terms — the device leaves "a race window
between resuming vCPUs and Linux CSPRNG getting successfully re-seeded"
(`references/firecracker-docs/snapshotting/random-for-clones.md:127-130`) — and recommends an
explicit reseed before tenant code resumes even on kernels that implement the device, for
exactly that reason
(`references/firecracker-docs/snapshotting/random-for-clones.md:180-183`). So the hook adds
host-supplied entropy to the pool and credits it, forcing a reseed, and it does so **before** the
thaw. Reseed, then thaw, in that order and never the other.

Worth stating precisely, because the loose version invites the wrong edit: this step is
**race-closing, not sole.** The device does reseed this pool, and the step is not here because
nothing else would — it is here because nothing else does it before the thaw. Removing it on the
grounds that the kernel pool is already handled deletes the only thing that handles it in time.

**Reseeding is two ioctls and a capability, not a write.** Writing bytes to the random device
mixes them into the input pool without crediting them and does not force the CSPRNG to reseed,
so an implementation that opens the device and writes has done almost nothing and reports
success. The sequence that works is `RNDADDENTROPY`, which mixes the host-supplied bytes into the
input pool *and* increases the entropy count, followed by `RNDRESEEDCRNG`, which specifically
reseeds the CSPRNG from that pool; both require `CAP_SYS_ADMIN` in the guest
(`references/firecracker-docs/snapshotting/random-for-clones.md:97-102,170-179`). This is written
down because the agent is sealed: an approximation of it cannot be corrected by a deploy. The
cost is not a consideration against a restore — reseeding 32 bytes through the kernel device
measures about 11 microseconds, and about 0.6 from the hardware instruction (Brooker et al.,
*Restoring Uniqueness in MicroVM Snapshots*, §4).

**What the reseed does not reach is userspace, and this agent cannot reach it either.** A
userspace generator seeds once at startup and stretches that seed; reseeding the kernel pool
afterwards leaves it exactly as the capture found it, in every sandbox from the template alike.
The paper is explicit that a platform reseeding kernel randomness and a tenant using a
cryptographically secure PRNG do not compose into a secure result (§2), and upstream scopes
itself to the kernel interfaces for the same reason
(`references/firecracker-docs/snapshotting/random-for-clones.md:6-12`). Step 3 is therefore the
strongest step available at this layer rather than a solution, the template build is what keeps
such generators out of the captured image in the first place, and the residual is stated in
[security](../architecture/security.md#clone-hygiene) rather than left implicit here.

The hostname is in this payload because it has nowhere else to come from. [vm-init](vm-init.md)
sets it once at boot from the kernel command line, which is the *template's* command line, so
without a delivery mechanism every sandbox derived from a template would present the same name
— and PID 1 is asleep at restore and has no channel to the host in any case. Setting a hostname
is a guest syscall, restore is the moment the host first knows what this instance should be
called, and this hook is the only thing that is both.

**The machine identity is in the list for the same reason, and one step later on purpose.** A
guest's machine identifier is generated once, on a boot that finds the file empty, and the
message bus, the journal, and a good deal of application code derive stable identifiers from it.
Emptying it at build time is the standard remedy, and it is sufficient only for a system that
cold-boots: a template is booted before it is captured, so the value that boot generated is in
the image, and every sandbox restored from that template — along with every snapshot taken of
those sandboxes — would otherwise carry one tenant's machine identity forever. Regenerating it
here places it after the entropy reseed, so the new identifier comes from a pool that is no
longer the one every sandbox of this template shares, and before the thaw, so no tenant process
ever reads the template's.

**The boot identifier moves with it, and it is the one value here that cannot be written.**
`/proc/sys/kernel/random/boot_id` is initialised with a random string at boot and is read-only
afterwards, so every clone of a captured boot reads the same value and the obvious remedy —
write a new one — is not available at all. What does work is a bind mount of another file over
it (`references/firecracker-docs/snapshotting/random-for-clones.md:150-155`). That mount is made
once, at boot, by [vm-init](vm-init.md#mounts): mounting is a one-time act, PID 1 is where the
one-time acts live, and PID 1 is asleep at restore with no channel to the host in any case. What
is left for this hook is an ordinary write into the file underneath the mount, in the same step
as the machine identity and for the same reason. Were the mount absent from the captured image
there is nothing this hook could do about it, which is why
[template-builder](template-builder.md) asserts its presence in the published template rather
than trusting that a boot arranged it.

Note that the monotonic clock does not advance across a pause either. That is left alone: it
measures the guest's own running time, and code that wants elapsed wall time should be reading
wall time.

### The thaw is an RAII guard

The thaw is implemented as a guard value whose destructor thaws the cgroup. It is never a
statement at the end of a function.

This is worth being emphatic about because the failure mode is total and silent. A sandbox left
with a frozen tenant cgroup is indistinguishable from a hung one: every process exists, none
runs, nothing logs, and the only symptom is that the sandbox stopped doing anything at an
unremarkable moment. Any early return, any `?` on a fallible call in the restore path, and any
panic between the freeze and the thaw would produce it. A guard makes the thaw unconditional on
control flow — unwinding runs the destructor, and so does every error path, including ones
added later by someone who has never read this document.

The guard belongs to the restore hook and must not be copied onto the pause path, where it would
do the opposite of its job. The freeze taken by `PrePause` is *meant* to outlive the call that
took it: it is captured into the artifact and released by the post-restore hook of whatever
sandbox is restored from it, so a guard there would thaw the tenant on the way out of the very
function whose purpose was to leave it frozen. The pause path is protected by two other things
instead — an explicit thaw operation the host calls when a pause aborts, and a guest-side
auto-thaw deadline that releases the freeze if no thaw arrives and no restore has intervened.
Both are defined in [vm-protocol](vm-protocol.md). The deadline matters because the failure it
prevents is the same total, silent one: a sandbox frozen forever looks exactly like a hung
sandbox, while a sandbox that thawed early is merely wrong in a way somebody notices.

### The auto-thaw deadline is split by cause

That reasoning holds for exactly one of the two ways a freeze goes unreleased, and taken as a
blanket rule it defeats the ordering guarantee the post-restore hook rests on.

The case it is right for is the pause-abort. A freeze **this** agent instance took, with no
clock disruption observed since, was taken in the guest that is still here: the clock, the
environment, and the machine identity are the ones the freeze was taken under, nothing has to
happen before tenant code runs, and releasing the freeze on the deadline is unambiguously
correct.

The other case is a freeze the agent finds itself still holding **after** a restore, and it is
the ordinary outcome of a sandbox restored while the host is wedged or partitioned. The restore
succeeded; the hook never arrived. That guest's realtime clock reads the pause instant, its
hostname and machine identity are still the template's, and its environment and metadata were
never applied, because they arrive over vsock at that moment and are deliberately never baked
into an artifact. Every reason the hook exists is unmet, by design, and a deadline firing there
thaws tenant code into precisely the guest the hook's ordering exists to rule out. Entropy is
the least affected of the three: the generation-identifier device reseeds the kernel on resume
by itself, and the narrow window the host reseed closes has long since passed by the time a
deadline measured in the guest's own running time expires. That holds for the kernel pool and
not for anything above it — a userspace generator seeded before the capture is untouched either
way — but the userspace residue is identical whether or not a hook arrives, so it does not bear
on this decision. The clock and the identity are the real exposure, and neither has any source
other than the host.

So a freeze held across a disruption **never** auto-thaws. The agent's behaviour is the one
[vm-init](vm-init.md#supervision-and-restart-backoff) already specifies for an agent that cannot
start at all: present as a sandbox that never answers, and let the host destroy it from outside
on its own timeout. That is the same trade the platform takes everywhere else — a sandbox that
dies loudly is recoverable, and one running tenant code with a week-old clock and another
tenant's machine identity is not.

The agent can only make the distinction because the hypervisor makes it for it. Every deadline
in this component is measured on the monotonic clock, which is correct and stays that way, and a
monotonic clock is exactly what makes a pause invisible — so there is no in-band evidence inside
the guest that a restore ever happened. The
[clock-disruption device](vm-protocol.md#the-clock-disruption-device) supplies it: on restore it
bumps a disruption marker and raises an interrupt before the vCPUs resume, so the fact is
available to the agent before any guest instruction has run. The agent records, per freeze,
whether a disruption has been observed since it was taken. It reads nothing else from the
device, and in particular takes no time from it.

### Pre-pause quiesce

`PrePause` is one operation that does several things, and the agent performs all of them,
because they are all guest syscalls.

1. **Stop accepting new work.** Operations arriving after this point are refused; in-flight ones
   finish or are abandoned at the deadline.
2. **Flush agent-owned buffers,** and run the best-effort reclaim pass described in
   [snapshots](../architecture/snapshots.md) — it happens here because a frozen cgroup cannot do
   any of it.
3. **Freeze the tenant cgroup** by writing `cgroup.freeze`, then wait for `frozen=1` in
   `cgroup.events` under the agent's own deadline, for the reasons given above.
4. **Acknowledge,** reporting whether the freeze was confirmed or the wait expired.

**The guest filesystem is not frozen here, and its absence from that list is deliberate rather
than an omission.** `FIFREEZE` state lives in the guest's superblock, and the guest's superblock
is guest memory — so freezing before a memory capture bakes a *frozen* root filesystem into the
artifact, and every sandbox ever restored from it blocks on its first write to disk,
permanently, from a single mistake at capture time. The agent implements filesystem freeze and
thaw for the two cases that do not capture memory: filesystem-only artifacts, and the builder's
seal.

The quiesce also carries a **host-side deadline**, and the host proceeds when it expires. The
agent cannot delay a pause, by construction, because the host is authoritative for lifecycle.
What it can do is report which state it actually reached, so the host knows whether it is
capturing a quiesced guest or a crash-consistent one.

## It performs no authentication

`vm-steward` does not authenticate its callers. There is no shared secret, no token check, and
no allow-list inside the guest.

The reason is developed fully in [security](../architecture/security.md) and is worth restating
because the omission looks like a gap: **the occupant is root inside the guest.** They can read
the agent's memory, replace its binary, and forge its messages. A secret delivered into the
guest so the agent can validate callers is a secret the occupant can simply read, so it
protects nothing from the only attacker who is actually inside. An in-guest check would provide
the appearance of a boundary exactly where no boundary can exist.

The enforcement point is `vm-host`, on the other side of the virtualisation boundary, where the
occupant cannot reach the code doing the checking. Every request that reaches this agent has
already been authorized there: by capability token for a private port, or by the active explicit
exposure record for a public tenant application port. Public exposure changes the host-side
decision; it does not add authentication logic or secret material inside the guest.

Two things follow for anyone working on this component. There is no point adding in-guest
authorisation logic; it would be defence against nobody. And the agent should not attempt to
sanitise on the host's behalf either, because the host must validate guest-supplied bytes
regardless of what the agent claims to have done.

## Concurrency and failure model

An async runtime with a small worker pool. One task per connection, one per active stream.
Blocking filesystem work runs on a bounded blocking pool so a slow read cannot stall the
reactor and starve unrelated streams.

| Failure | Behaviour |
|---|---|
| A stream task panics | Caught at the task boundary; the stream fails with an error code, other streams are unaffected |
| A connection drops | Streams on it are torn down; processes, rings, and watches survive, because they belong to the agent and not to the connection. **Routine rather than exceptional:** every pause severs the connection through the vsock transport reset, so this row describes the restore path as much as it describes a failure |
| Malformed, oversized, or excessively nested frame | The connection is closed. Frames are size-limited before allocation, so a length prefix cannot be used to request an arbitrary allocation, and decoder recursion is separately depth-limited, because the size limit does not bound nesting |
| The agent process dies | [vm-init](vm-init.md) restarts it with backoff |
| Guest memory pressure | Tenant processes are the OOM victim first, by score |

The agent sets itself as a **child subreaper**, so a tenant process's own children reparent to
the agent rather than escaping to PID 1. That role creates a race *inside* the agent, and it is
the kind that only shows up under load. As subreaper the agent is notified about reparented
grandchildren it never spawned and knows nothing about, and it must wait for them or they stay
zombies holding pid slots. It simultaneously needs the exit status of each of its own children,
addressed individually. Those two needs collide: when one code path sweeps with a wildcard wait
while another waits on a specific child, the kernel delivers the exit to whichever call it
dispatches first. If the sweeper wins it consumes the status of a tracked process and the
targeted wait reports no such child; if the targeted wait wins the sweep sees nothing. Either
way the real exit code is lost intermittently. **There is therefore exactly one reaping
authority inside the agent:** a single task performs every wait, demultiplexes results by
process ID into the process table, and discards whatever it does not recognise as an adopted
orphan. No other code path calls wait.

The agent-restart case deserves precision, because it is the one where behaviour is degraded
rather than preserved, and it is worse than "their statuses are gone". Two kernel properties
bound it. **The child-subreaper flag is not inherited by children**, so the agent must set it on
itself at every start and can never assume a descendant carries it. And when the agent dies, its
direct children reparent to `vm-init`, which reaps them — meaning their exit statuses have been
*consumed*, not misplaced. There is one copy of an exit status and it has already been delivered
to somebody else, so a restarted agent cannot re-adopt those processes and cannot recover what
it missed by any means at all. What it can do is re-discover the still-running ones by
enumerating the tenant cgroup, then watch and signal them through process descriptors — a
descriptor opened on a process that is not your child still reports when it exits, though not
with what status. It reports them as adopted processes with unknown history rather than
pretending it still has their output, which went with the old address space. This is the fault
isolation that justifies keeping the agent separate from PID 1: an agent bug costs observability
of running processes, not the sandbox.

## Configuration

There is deliberately almost none, because configuration is state that gets sealed into a
template and cannot be corrected afterwards.

| Setting | Source | Notes |
|---|---|---|
| vsock port | Compile-time constant | Part of the sealed contract; changing it breaks every existing template |
| Maximum frame size | Compile-time constant, advertised in the handshake | Shared with the host through negotiation rather than shared configuration |
| Per-process ring size, aggregate ring cap | Compile-time defaults | |
| Blocking pool size | Compile-time default | |
| Freeze-confirmation deadline, auto-thaw deadline | Compile-time constants | Both measured on the monotonic clock, so a paused sandbox does not age out of a freeze it was captured in. The auto-thaw deadline is suppressed outright on a freeze held across a clock disruption |
| Process record retention, concurrent relay stream cap | Compile-time constants | |
| Environment, metadata, hostname | Delivered in the post-restore payload | Never baked into an artifact. The hostname is in the payload because nothing else can carry it: PID 1 sets it once at boot from the template's kernel command line |

Anything a tenant can influence arrives over the protocol at restore time. Nothing tenant-facing
is read from a file inside the image.

## Observability

The agent has no metrics endpoint, because it has no listening port and will not be growing
one. Telemetry therefore travels two ways.

Structured lines go to stderr, which [vm-init](vm-init.md) leaves attached to the guest console
and `vm-host` captures. That channel is narrow and shared with the kernel, so agent logging is
rate-limited and reserved for events an operator would act on: startup, hook execution, agent
restarts, and protocol-level errors.

Counters — spawns, active processes, bytes relayed, ring gap events, watch overflows, rejected
frames — are reported in protocol responses and polled by the host, which exports them labelled
by sandbox alongside its own host-side view (round-trip latency, error codes, reconnect counts).
Attributing agent behaviour from outside is also more trustworthy, since the guest is hostile
and its self-reported numbers are input, not truth.

**No tenant data is ever logged.** Not process output, not file contents, not environment
values, not paths supplied by the tenant. Sandbox output is tenant data and is deliberately not
captured centrally.

## Testing

| Layer | What it covers |
|---|---|
| Unit | Frame decoding, ring sequencing across wrap and gap reporting, path normalisation, user and group resolution, backoff arithmetic |
| Harness | A fake host drives the real agent over a unix socket using the same transport trait, so the majority of behavioural tests run without a VM and in milliseconds |
| Pre-exec | Spawn and assert the child starts with an empty signal mask and default dispositions, that none of the agent's descriptors survived the `exec`, and that a hook step returning an error fails the spawn instead of proceeding |
| In-VM integration | PTY session and controlling terminal (interrupt reaches the foreground group), the I/O error on the master at session end, cgroup freeze confirmed through `cgroup.events` including a member in uninterruptible sleep, cgroup kill, inotify semantics, subreaper reparenting and the single reaping authority under concurrent exits |
| Snapshot | Spawn a long-running process, pause, resume, then assert the clock is corrected, entropy was reseeded and the machine identity regenerated before the thaw, the cgroup is thawed, and reattach resumes at the expected sequence number. Deliver the post-restore hook twice and assert the second delivery changes nothing, including that it does not step the clock again, and that an attempt carrying an older stamp than one already applied is discarded. Restore two sandboxes from one template and assert their random streams, their machine identities, and their boot identifiers all differ — the last against the bind-mounted file, since a template whose mount is missing fails this by reading one shared value from procfs |
| Fuzzing | The decoder, continuously, with deeply nested messages in the corpus as well as oversized ones. It parses input from outside the process, and a crash here — including a stack overflow, which no size limit prevents — is a dead sandbox |
| Budget | Resident memory measured in CI against both ceilings — idle, and with the aggregate ring cap and the relay cap saturated — failing the build on regression, because the budget is a sealed property that cannot be fixed by a deploy |

The RAII thaw guard has its own test: inject a failure at each step of the restore hook and
assert the cgroup is thawed in every case, including the panic case. The pause path is tested
from the other direction — abort a pause after `PrePause` has frozen the tenant, assert an
explicit thaw restores it without a restore having happened, and separately assert that the
auto-thaw deadline releases a freeze that is never matched by one. The disruption case is
asserted against a real pause and restore: hold the captured freeze past the deadline with no
hook delivered, and assert the tenant stays frozen and the sandbox never answers, rather than
thawing into an uncorrected guest.

## Rules that must not be violated

1. **Never bind a TCP or UDP port.** vsock only, and the host always connects in.
2. **Never shell out.** `shell` is an operation the tenant explicitly requests; the agent's own
   logic never invokes a shell for any purpose, including priority, timing, or file operations.
3. **Never serve HTTP.**
4. **Never carry public API types.** The protocol is a private contract; the product API is not.
5. **Never add a capability that does not require a guest syscall.** If the host can do it, the
   host does it. The sealed surface stays small.
6. **Never authenticate.** The check belongs on the host, where the occupant cannot reach it.
7. **In the restore hook, the tenant cgroup thaw is always a guard, never a statement.** The
   pause-path freeze is the deliberate exception: it outlives its call and is released by an
   explicit thaw, or by the auto-thaw deadline if no clock disruption has been observed since it
   was taken. A freeze held across a restore is never released by a deadline; the sandbox stays
   frozen and the host destroys it.
8. **Never log tenant data.**
9. **Never delay a pause.** Quiesce acknowledges or the host proceeds without it.
10. **Never allocate on an unvalidated length.** Size limits are checked before memory is
    reserved.
11. **Keep the idle dirty-page count under its ceiling,** measured in CI rather than asserted.
    An idle agent is an agent that costs nothing on every node running the template that
    contains it.
12. **Every descriptor is close-on-exec at creation.** The control channel, other sessions' PTY
    masters, cgroup directory descriptors, and watch descriptors must never cross an `exec` into
    tenant code.
13. **Reset the signal mask and dispositions before `exec`.** An inherited mask survives it, and
    an inherited ignore disposition survives it too.
14. **One reaping authority.** Exactly one task waits; everything else reads the process table.
15. **Signal through a process descriptor, never a raw pid.** The assigned process ID prevents
    table aliasing; it does nothing about pid recycling.
