---
type: Component
title: vm-protocol
description: The vsock wire contract between vm-host and vm-steward — framing, stream multiplexing, capability negotiation, epochs, reconnection, and the rules governing its evolution.
tags: [component, contract, vsock, protobuf, capabilities, epoch, snapshot]
timestamp: 2026-07-27T07:33:00Z
---

# vm-protocol

`vm-protocol` is the contract between [vm-host](vm-host.md) and [vm-steward](vm-steward.md). It
is a shared crate: message definitions, framing, the session state machine, and the client and
server halves that both components build on.

## Purpose

**This is the one interface sealed into snapshots, and therefore the one interface that must
not churn.**

Every other contract in the system can be changed by deploying both sides. This one cannot. The
agent that speaks it is baked into a template, and every sandbox created from that template —
and every snapshot ever taken of such a sandbox, indefinitely — runs that exact binary. A
snapshot paused today may be resumed in a year, by a host that has been redeployed hundreds of
times in between, and it will present an agent from a year ago expecting the protocol as it was
then.

So the operative question for every decision below is not "what is the cleanest design" but
"what will still work when one side of this conversation has been frozen for an arbitrary
length of time." That constraint produces capability negotiation instead of version
comparison, a reconnect-first session model instead of a connection-oriented one, idempotency
keys instead of at-most-once delivery, and an evolution rule enforced by tests rather than by
discipline.

## Why not an off-the-shelf protocol

Everything below is specified from scratch — framing, stream identifiers, credit windows,
keepalives — and a sealed interface is the last place a reader should accept that without a
reason. The alternative considered was **HTTP/2 over vsock**, and it was rejected on three
grounds.

The first is the resident-memory budget. A general-purpose stack carries header-compression
tables, a settings machine, a priority tree, and per-connection buffers sized for the internet
rather than for a socket with exactly one peer. Every page of that is a page in the agent's
resident set, which is a page in every memory image and a private copy on every warm restore —
so the budget in
[vm-steward](vm-steward.md#the-memory-budget-is-a-design-constraint-not-a-preference) is not a
preference a sufficiently good library could be argued past.

The second is the dependency surface of a sealed binary. A defect in a hand-written frame
decoder costs a template rebuild; so does a defect in a vendored stack, except that the second
arrives on somebody else's disclosure schedule and covers machinery this contract would never
use. We would be sealing server push, priority, and dynamic table resizing into every artifact
in order to send length-prefixed protobuf to one peer.

The third is that it would not answer the question we actually have. A session-level ping proves
the connection is alive and says nothing about whether a particular stream is still attached to
anything — which is [the keepalive problem below](#keepalive-is-per-stream-not-only-per-session),
and the one liveness question a sealed agent cannot be redeployed to fix.

**This decision has no prior art behind it, and that is worth stating rather than implying.**
Comparable systems do not validate it, because none of them puts its agent behind vsock at all:
they serve HTTP over a TCP port on the guest interface, which is the arrangement `vm-steward`'s
never-bind-a-port rule exists to refuse. Nobody else has run this transport at scale on our
behalf. The choice rests on our own constraints.

### What is adopted from HTTP/2 on purpose

Rejecting the implementation is not rejecting the design work, and several hazards below have
exactly one good answer that HTTP/2 reached first. Those answers are taken deliberately, in one
place, rather than rediscovered one incident at a time.

| Behaviour | Where it appears below |
|---|---|
| Stream identifiers allocated monotonically by one side and never reused | Stream multiplexing |
| An exhaustible identifier space, remedied by retiring the connection rather than wrapping | Relay stream lifecycle |
| Per-stream credit windows over a shared connection | Stream multiplexing |
| Half-close per direction, the stream ending only when both halves are done | Relay stream lifecycle |
| A stream failing without failing the connection | Error model and the failure table |

What is deliberately not adopted: header compression, priority and dependency trees, server
push, and mid-session settings renegotiation. Each is machinery for a many-peer, many-origin
web, and each is state the agent would carry into every snapshot for the life of the template.

## Responsibilities

| Responsibility | Detail |
|---|---|
| Framing | Length-prefixed frames with a hard maximum size |
| Message schema | The protobuf definitions and the generated types |
| Multiplexing | Stream identifiers, so one connection carries many concurrent calls |
| Session | Handshake, capability exchange, epoch tagging |
| Chunking | Splitting payloads larger than a frame, at the protocol level |
| Error model | A stable, enumerated set of error codes |
| Idempotency | The key format and the semantics of a safe retry |
| Guest kernel requirements | The kernel features the agent uses unconditionally, asserted by the template build because they cannot be negotiated |

## Explicit non-responsibilities

| Not responsible for | Why |
|---|---|
| The public API | Public request and response types are separate and change freely with the product. If they were the same types, every product iteration would demand a new agent — which cannot be deployed. `vm-host` translates between the two. |
| Authentication | There is nothing to authenticate. See [security](../architecture/security.md); the check happens on the host before a request ever reaches this channel. |
| Transport setup | Creating the vsock device and the host-side unix socket is Firecracker's and `vm-host`'s work. |
| Retry policy | The protocol makes retries *safe*; deciding when to retry is the host's. |
| Business semantics | What a sandbox is allowed to do is host policy, not wire format. |

## Transport and framing

The transport is **virtio-vsock**. `vm-steward` listens on a fixed port; `vm-host` connects
through the Firecracker-provided unix socket. The control channel therefore does not exist on
any network the tenant can route to. See [networking](../architecture/networking.md).

That sentence hides a text preamble, and the preamble decides what a failed reconnect looks like.
The unix socket belongs to the hypervisor rather than to the agent and multiplexes every guest
vsock port onto itself, so a host that wants one writes `CONNECT <port>\n` and reads back
`OK <assigned_port>\n` before a single frame of anything below is exchanged
(`references/firecracker-docs/vsock.md:45-49,51-63`). What follows is the shape of failure rather
than the bytes. The unix `connect()` succeeds whenever the hypervisor is up, whatever state the
guest is in, so a guest that is not ready is invisible at connect time; the refusal arrives
afterwards, and it arrives as the hypervisor *terminating* the connection because nothing was
listening on the port asked for (`references/firecracker-docs/vsock.md:60-63`). A reconnect loop
that keys on `connect()` returning an error therefore never fires, and reads a sandbox that has
not finished restoring as one that answered.

The socket path carries the same collision hazard as the tap device name and for the same reason:
it is recorded in the snapshot, so every sandbox restored from one template wants the identical
path, and two of them on one node collide on any port either uses
(`references/firecracker-docs/vsock.md:176-184`). Both halves are resolved outside this contract —
a namespace per slot for the device name, a jail per sandbox for the socket path — and
[vm-host](vm-host.md) carries the argument.

```
┌──────────────┬────────────────────────────────────────────┐
│ u32 length   │ protobuf Frame                             │
│ (big-endian) │  ├─ stream_id                              │
│              │  ├─ epoch                                  │
│              │  └─ oneof body { request | event | ... }   │
└──────────────┴────────────────────────────────────────────┘
                 ▲
                 └─ rejected outright above the maximum frame size
```

A length prefix plus a protobuf message, with a **hard maximum frame size**. A frame whose
prefix exceeds the maximum causes the connection to be closed without reading the body and
without allocating for it — the length prefix is validated before any buffer is reserved, so it
cannot be used to request an arbitrary allocation. Both sides enforce this; the host enforces
it because the guest is hostile, and the agent enforces it because the host is simply another
source of bytes from outside the process.

**A frame size limit does not bound decoder recursion, and conflating the two is how a decoder
that passes every stated check still dies.** Nesting costs a couple of bytes per level, so a
frame comfortably under any sane ceiling can encode thousands of levels of nested messages. A
decoder that recurses per level exhausts its stack long before it exhausts the frame, and on a
statically linked binary with a modest main-thread stack that is not an error return — it is a
dead agent, killed by input that was correctly length-prefixed, correctly sized, and valid
protobuf. Both sides therefore enforce an explicit **recursion-depth limit**, set low enough
that only input designed to reach it does, and reject the frame when it is exceeded. The fuzzing
corpus carries deeply nested messages so the limit stays exercised rather than becoming a
constant nobody has tested.

Payloads larger than a frame — file contents, bulk output, relayed traffic — are **chunked at
the protocol level** rather than by raising the frame ceiling. A single ceiling that everything
fits under is the mechanism that keeps memory bounded on both sides; a protocol where the
largest legal message is "however big the file is" has no bound at all. The effective chunk
size is advertised in the handshake rather than assumed, so neither side has to guess.

### Stream multiplexing

Every frame carries a **stream identifier**. One connection therefore carries any number of
concurrent unary calls and long-lived streams: three PTY sessions, a file watch, a directory
listing, and a chunked upload can all be in flight at once without a connection each.

Stream identifiers are allocated by the host, monotonically per connection, and never by the
agent. That is possible because **the guest never initiates an operation** — everything the
agent sends is an event on a stream the host opened. The benefit is not just a simpler
allocation rule with no collision handling; it keeps the direction of causation one-way, so the
host is the sole scheduler of work inside the guest and there is no path by which a hostile
guest can create load by asking for it.

Per-stream flow control (a credit window) prevents one noisy stream from consuming the
connection. Without it, a process printing in a tight loop would starve every other stream
sharing the socket.

### Keepalive is per stream, not only per session

`Ping` measures the session, and the session is not the thing that goes quiet. A long-lived
stream — a watch that reports nothing for an hour, an attach to a process that produces no
output — is byte-for-byte indistinguishable from a stream whose other end is dead, and anything
between the two that keeps idle state is entitled to decide the quiet one has finished with it.
A session-level ping does not resolve that: it proves the connection is alive while saying
nothing about whether a particular stream is still attached to anything at either end.

Each long-lived stream therefore carries **its own keepalive**, emitted by the sending side
after an idle interval and **reset by real data**, so a busy stream never pays for it. A stream
that misses its window is failed rather than left open. That is safe precisely because of the
addressing rule below: the guest-side object outlives the stream, so failing the stream costs a
reattach and nothing else, while leaving a dead stream open costs a client that waits forever
for output from a process nobody is reading.

### Additional connections for bulk transfer

The host may open **additional connections**. Multiplexing solves fairness at the message
level, but a large file transfer still occupies the socket for the duration of each frame it
writes, and enough of them in sequence will delay an interactive keystroke behind them. This is
head-of-line blocking, and no amount of stream fairness above the socket removes it.

The rule is therefore: interactive and control traffic on the primary connection, bulk
transfers on their own. Each connection performs its own handshake and carries the same epoch.

## The handshake

The first exchange after connect, before any operation is legal.

| Direction | Message | Carries |
|---|---|---|
| host → guest | `Hello` | Protocol version, the **epoch** the host is assigning to this instance, host-side frame and chunk limits |
| guest → host | `HelloAck` | Protocol version, the **capability bitset**, agent build identifier, agent-side frame and chunk limits |

Effective limits are the minimum of the two sides. The agent build identifier has **exactly one
permitted behavioural use**, described in
[when a capability bit is honest and wrong](#when-a-capability-bit-is-honest-and-wrong): the
host may subtract bits from a build it knows to be defective. It may never be used to conclude
that a capability is *present*, it is never ordered or compared as a version, and beyond the
deny-list it exists so that a human reading a trace knows what they are looking at.

The protocol version is a generation number for the wire format itself — the framing, the frame
envelope, the handshake — and not a feature level. It changes essentially never. A mismatch is
fatal, because there is no way to interpret the bytes.

## Capability negotiation replaces version comparison

The host does not ask what version the agent is. It reads the bitset and adapts. Calling an
operation whose bit is clear returns an explicit `UNSUPPORTED` error naming the bit that would
have been required, rather than a timeout, a parse failure, or a generic error.

The reason this is the design rather than a version comparison is worth spelling out, because
version comparison is the obvious first instinct and it fails in a specific, compounding way
here.

A sealed agent means **the host must speak to agents older than itself indefinitely**. Under
version comparison, each new feature acquires a minimum-version constant, and each call site
acquires a branch comparing against it. After a year that is dozens of constants, each one a
fact about history that must be looked up to be maintained, and a test matrix that is the cross
product of feature set and agent version. Worse, the constants encode an assumption that
capability is totally ordered — that any agent new enough for feature B necessarily has feature
A — which stops being true the first time a feature is backported into a template line, or
built into a specialised template, or removed.

A bitset makes capability a set rather than a point on a line. Each feature is one bit, one
runtime check at the one call site that needs it, and one test that exercises the feature both
present and absent. Adding a feature touches exactly the code that uses it.

Two further properties fall out of it:

- **Bits are permanent.** A bit is never recycled, and a retired feature retires its bit
  forever. Reusing a number would make an old agent's honest advertisement into a lie.
- **Capabilities are known before restore.** The agent's bitset and its build identifier are
  both recorded in the artifact manifest, as `runtime.steward_capabilities` and
  `runtime.steward_build` — see [snapshots](../architecture/snapshots.md) — so the host knows
  what it will be talking to before it restores anything, and a request for a feature the
  template cannot support can be rejected with an actionable message ("this template predates
  the feature; rebuild it") instead of failing halfway through a create. The build identifier is
  in the manifest and not only in the handshake because the deny-list below has to be applied
  before a restore is attempted, not after one has already succeeded.

### When a capability bit is honest and wrong

A bit can be set truthfully and still be wrong, and the rules above answer only one cause of
that. Bit reuse is covered: a retired number is never reissued, so an old agent's honest
advertisement can never be read as a claim about a feature invented after it was sealed. But
reuse is the rare cause. The common one is a **shipped bug** — an agent that implements a
capability, sets its bit in good faith, and implements it incorrectly.

That case is worse here than anywhere else in the system, because the lie is sealed. Every
template built during the window carries an agent advertising a capability it does not correctly
have; the host is contractually obliged to believe the bitset; no deploy fixes it, because there
is nothing to deploy to. Without a remedy the only correction is a fleet-wide template rebuild,
begun at the moment the bug is discovered. The freeze path is the concrete worry rather than a
hypothetical: ours confirms the transition through `cgroup.events` under a guest-side deadline
and carries an auto-thaw deadline on top of that, so it has materially more moving parts than a
bare write to `cgroup.freeze`, and correspondingly more ways for a shipped version of it to be
subtly wrong while reporting success.

The remedy is a **capability quarantine list**: a host-side, deployable mapping from agent build
identifier to a set of bits to *subtract* from whatever that agent advertises. It is applied at
the handshake, and against the manifest field before a restore is attempted. Once the bits are
gone the host takes the path it already has for an agent that never had them — the `UNSUPPORTED`
degradation this protocol treats as a routine outcome rather than an error — so the affected
templates get rebuilt as scheduled work instead of during an outage, and the sandboxes already
sealed against that agent keep running with a reduced feature set rather than a broken one.

The list is a deny-list and can only ever be a deny-list. Subtracting a bit is always safe,
because the host must already work correctly against an agent that never advertised it. Adding
one would be the host asserting a capability the agent did not claim, on the strength of a build
string — which is version-sniffing with extra steps, and reintroduces every compounding problem
the bitset exists to avoid. Presence therefore stays monotone and strictly bit-driven; absence
gains an escape hatch that does not require a fleet rebuild.

## Reconnect is normal, not exceptional

Taking or restoring a snapshot **resets the vsock device**. Open connections are severed; the
listening socket survives (`references/firecracker-docs/snapshotting/snapshot-support.md:55-60`).
The reset is deliberate rather than incidental — it exists so that device and driver cannot come
back from a restore disagreeing about which connections are open
(`references/firecracker-docs/snapshotting/snapshot-support.md:643-650`) — so it is not a defect
that might one day be repaired out from under this design.

The reason the listener survives is not that it lives in guest memory. So do the connected
sockets, and they are destroyed. It survives because of what the guest driver does on reset: the
reset handler walks the *connected* sockets and tears them down, and leaves listeners alone
(`references/firecracker-docs/snapshotting/snapshot-support.md:650-653`). That is a property of
the driver's implementation rather than something this protocol arranged, which is a good reason
to assert it against a real pause and restore instead of assuming it.

**The listener is bound to the wildcard context identifier**, and the reason is not the one it
first appears to be. A restore can give the guest a different context identifier than it held
when the snapshot was taken, which sounds like it should strand a listener bound to the old
value — but the driver rewrites it, updating the listeners it spares to the current `guest_cid`
as part of the same reset that destroys the connections
(`references/firecracker-docs/snapshotting/snapshot-support.md:651-653`). Binding the wildcard is
therefore not a fix for a breakage; it is a refusal to depend on that rewrite. The agent is
sealed, the driver is a kernel chosen alongside it at template build, and a sealed binary whose
reachability rests on one branch of somebody else's reset handler carries a dependency nobody
will remember the next time the guest kernel moves.

This is not a failure to recover from. It happens on every single pause and every single
restore, so it is the ordinary case, and the session model is built around it rather than
patched to tolerate it.

| Across a snapshot | Fate |
|---|---|
| Agent's listening socket | Survives — the driver's reset handler destroys connected sockets only, and rewrites the listeners it spares to the guest's current context identifier |
| Open connections | Severed |
| Frames in flight, in either direction | Destroyed, with no error on either side |
| Host-side stream state, pending requests, buffers | Lost |
| Guest process table, PTYs, output rings, watches | Survive — they are guest memory |
| Epoch | Replaced by a new one at the next handshake |

The asymmetry in that table is the whole design. Guest-side objects persist across a restore,
so a reconnecting host can pick up a running process where it left off; host-side connection
state does not, so nothing may depend on it. Every long-lived operation is therefore addressed
by a **durable guest-side identifier** — a process ID, a watch ID — and not by the stream that
created it. Reattaching is a first-class operation, not a recovery path.

### The channel is not usable when the restore returns

A host that restores a VM and immediately connects will fail, and this is not an occasional race
— it is the expected result of connecting too early.

The device sends its transport-reset event to the guest driver at snapshot **create** time
(`references/firecracker-docs/snapshotting/snapshot-support.md:368-371,646-650`), and the driver
acts on it at the far end of the gap: the teardown of the severed connections runs when the
restored VM becomes active, which is to say once the vCPUs are running
(`references/firecracker-docs/snapshotting/snapshot-support.md:650-652`). Until that work has
happened the guest end is not in a state to accept, and a port request issued inside the gap does
not queue and does not wait — it is answered the way the transport answers every request for a
port nobody is listening on, by terminating the host's connection.

So **every reconnect after a restore is a connect with retry and backoff**, never a single
connect. A host that reads the first refusal as a dead sandbox destroys healthy sandboxes at a
rate that scales with how fast its own restore path is, which is a bug that gets worse as the
system gets better.

The consequence for `PostRestore` follows directly: it is delivered by that retry loop and can
therefore be delivered more than once. **Every step of it must be idempotent**, including the
steps that are not naturally so — stepping a clock and reseeding a random pool both cause harm
when repeated blindly. How [vm-steward](vm-steward.md) makes each step idempotent is described
there; that it has to be is a property of this contract, because the retry loop is here.

Two rules about the payload follow from the loop being here rather than there. **The host
re-stamps the wall time on every attempt** instead of computing it once before the first: a loop
that runs for seconds against a slow or wedged guest would otherwise land a value that was
accurate when the retry began. And the payload carries a **monotonically increasing stamp**, so
the guest resolves ordering by last-write-wins and discards an attempt older than one it has
already applied. That is both cheaper and more exact than a general idempotency key for this one
operation, because successive attempts legitimately carry different bytes and are therefore not
retries of the same request in the sense the key cache means.

### In-flight traffic is destroyed at pause, in both directions

The transport does not persist connections through a snapshot and makes no attempt to drain them
first. Whatever is in flight when the device resets is gone, in both directions, with no error
on either side. A response the agent wrote successfully — the write returned, the bytes left the
agent — can vanish, and the host sees nothing but a connection that ended.

The idempotency cache covers one half of this: a side-effecting request whose response was lost
can be retried under its key and returns the recorded result instead of executing twice. It is
worth naming the half it does not cover, because the cache invites the assumption that it covers
everything.

| Lost to the reset | Recovered by |
|---|---|
| The response to a side-effecting request | Retry under the idempotency key |
| The response to a read-only request | Re-issuing it, which is safe but must actually happen |
| An event — output, a watch notification, an exit event | Nothing retryable, because there was no request. Reattach to the durable guest-side object and resume from the last sequence number the host actually observed |

The third row is why every long-lived stream carries a sequence number rather than relying on
delivery. An event is not a reply, so there is no key under which to ask for it again; the only
recovery is for the guest to still hold it and for the host to know where it got to.

### Epochs

After every restore the host reconnects and handshakes with a **new epoch**. Every frame carries
the epoch it was issued under, and an operation tagged with a stale epoch is rejected with
`STALE_EPOCH`.

The agent enforces this even though the host is authoritative for lifecycle, and the case it
catches is real: an operation issued before the pause, still queued somewhere in the host,
arriving after the restore. Without the tag it would apply to a sandbox generation that no
longer expects it — a write into a filesystem that has since been snapshotted, a signal to a
process the caller believes is in a different state. With the tag it fails deterministically
and the host retries under the current epoch if it still makes sense to.

Epochs are the same epochs that appear in capability tokens; a token minted for a previous
instance fails closed without any revocation list. See
[security](../architecture/security.md).

**Conflicts have a defined resolution, because the agent cannot verify the convention it would
otherwise be trusting.** Epochs are assigned by the host, and the additional connections above
carry the same epoch as the primary by convention — but from inside the guest, a second
handshake presenting a *different* epoch is indistinguishable from the correct behaviour of a
host that restored in between. Leaving it undefined means two hosts, or one host and one stale
retry, can disagree about which generation the sandbox is in, and the agent picks whichever
arrived last.

The rule is that **epochs are monotonic**. A handshake presenting an epoch lower than the
current one is rejected with `STALE_EPOCH` and the connection is closed, rather than admitted at
a downgraded generation. A handshake presenting a higher one supersedes: it becomes current, and
frames still arriving under the previous epoch are rejected from that moment. An equal epoch is
the ordinary case and simply joins the session.

The asymmetry is the safe direction. A lower epoch can only be a stale host or a forged frame,
and admitting it would let an operation from a previous generation execute against the current
one, which is the entire thing epochs exist to prevent. A higher epoch can only come from a host
that has moved the sandbox forward, and the agent is in no position to argue with that.

### Idempotency keys

Operations with side effects carry a host-generated **idempotency key**. The agent keeps a
bounded, time-limited cache of completed keys and their responses; a retry with a known key
returns the recorded response instead of executing again.

Without this, reconnection would be unsafe by construction. A host that sends "spawn this
process" and loses the connection before the response arrives cannot know whether the process
was spawned, and retrying risks two of them. Since reconnection is routine rather than rare,
that ambiguity would occur constantly.

The guarantee is stated precisely, because an unbounded cache would be a memory leak an
attacker could drive: **a retry is safe within the reconnect window.** The window is sized to
cover the longest expected gap — a restore — and a retry arriving after the entry has expired
is treated as a fresh operation. It is not exactly-once delivery for all time, and nothing
should be built as though it were.

## The operation set

| Area | Operation | Kind | Notes |
|---|---|---|---|
| Session | `Hello` / `HelloAck` | unary | Version, capability bitset, epoch, limits |
| Session | `Ping` | unary | Liveness and round-trip measurement; also the post-restore readiness probe |
| Session | `Info` | unary | Build identifier, uptime, counters. Diagnostic only |
| Lifecycle | `SetEnvironment` | unary | Replace the environment and metadata applied to new processes |
| Lifecycle | `PostRestore` | unary | Step the clock within tolerance, re-apply environment, metadata and hostname, reseed entropy, regenerate the machine identity, then thaw the tenant cgroup. Idempotent, because it is delivered by a retry loop; each attempt carries a freshly stamped wall time and a monotonic stamp for last-write-wins |
| Lifecycle | `PrePause` | unary | Stop accepting work, flush, freeze the tenant cgroup and confirm the freeze, acknowledge. Under a host-side deadline |
| Lifecycle | `FreezeTenant` / `ThawTenant` | unary | Freeze and thaw the tenant cgroup explicitly. Idempotent; the freeze carries a guest-side auto-thaw deadline |
| Lifecycle | `FreezeFilesystem` / `ThawFilesystem` | unary | `FIFREEZE` and `FITHAW` on the guest root. Idempotent; the freeze carries a guest-side auto-thaw deadline. Never used around a memory capture |
| Process | `Exec` | server stream | Spawn from a raw argv vector; emits output and lifecycle events |
| Process | `Shell` | server stream | Spawn a command line explicitly wrapped in a shell |
| Process | `Attach` | server stream | Re-attach to a running process from a given sequence number |
| Process | `Stdin` | client stream | Write to a process's stdin; carries an explicit end-of-input, which is rejected for a PTY-backed process because a PTY has only one stream |
| Process | `ResizePty` | unary | |
| Process | `Signal` | unary | To a process or its group. Delivered through a process descriptor, not a raw pid |
| Process | `ListProcesses` | unary | |
| Process | `Wait` | unary | Await and return a terminated process's exit status |
| Filesystem | `Stat` | unary | |
| Filesystem | `List` | unary | Directory entries with metadata, paginated by cursor |
| Filesystem | `MakeDir` | unary | |
| Filesystem | `Move` | unary | |
| Filesystem | `Remove` | unary | |
| Filesystem | `Read` | server stream | Chunked |
| Filesystem | `Write` | client stream | Chunked; the final message commits |
| Filesystem | `Watch` | server stream | Recursive subtree; emits change and overflow events |
| Statistics | `Stats` | unary | Guest filesystem usage from `statfs`, and the used-versus-page-cache split of guest memory from `/proc/meminfo`. Behind its own capability bit. The two figures a host cannot obtain from outside the guest — see [vm-steward](vm-steward.md#guest-statistics) |
| Relay | `ListPorts` | unary | Listening sockets, enumerated via netlink. A dump, not a subscription: observing a port *appear* means calling this on a timer |
| Relay | `Relay` | bidirectional stream | Byte copy to a guest loopback port |

`Relay` is the only bidirectional stream, and that is deliberate. Bidirectional streams are the
hardest case for both flow control and reconnection, since neither side can treat the other's
silence as completion. Everything else is decomposed into unary calls and single-direction
streams addressed at a durable guest-side object: stdin is a client stream against a process ID
rather than the reverse channel of `Exec`, which is precisely what allows a client to reattach
to a process's output without disturbing whoever is writing to its input. A byte relay cannot
be decomposed that way — it is inherently two copies running against each other — so it gets the
one exception.

### Relay stream lifecycle

Being the one bidirectional stream, `Relay` needs its lifecycle written down rather than
inferred from the others.

**Half-close is carried in both directions.** Either side may close its write half and keep
reading, and the stream ends only when both halves are closed or one side errors. Without it the
request-response protocols most likely to sit behind a published port simply hang, because a
server reading until end of input never sees one. A reset from the guest side is reported as an
error rather than a clean close, so a client can tell a complete response from a truncated one.

**Concurrent relay streams are capped per sandbox,** and a request past the cap is refused with
`RESOURCE_EXHAUSTED` rather than queued. This is a guest-memory limit rather than a fairness
knob: each stream costs a socket, two buffers, and a task inside a component with a
ten-megabyte budget, and inbound connections to a published port are not something the guest
gets to decline.

**Stream identifiers are exhaustible, and a published port is how it happens.** Identifiers are
allocated by the host, monotonically per connection, and never reused — the right rule when
streams are interactive calls, but a busy published port opens one per inbound request, and a
connection that stays up for a long time can walk the space. The identifier is wide enough that
this is a distant prospect rather than a live risk, and the host handles it by retiring the
connection and opening a fresh one, which costs a handshake. It is stated because the
alternative way to discover it is a sandbox that stops accepting relay streams after an uptime
nobody has tested to.

That also reconciles relay with the bulk-transfer rule, which otherwise reads as a
contradiction. Interactive and control traffic belong on the primary connection and bulk on its
own — and a published port serving large downloads is bulk traffic that happens to arrive as
relay streams. **Relay streams for published ports therefore belong on a bulk connection**, not
on the primary, because a tenant serving a large file should not be delaying the keystrokes of
the person watching it happen.

### Freeze and thaw are operations, not host-side writes

Freezing and thawing are guest syscalls, so all four are operations in this contract. The host
does not reach into the guest's cgroup hierarchy or its filesystem, and there is no mechanism by
which it could.

**All four are idempotent.** Freezing an already-frozen cgroup succeeds and changes nothing;
thawing an already-thawed one likewise. This is not politeness. Every one of them is reachable
from a retry loop, and a thaw that errors because the tenant was already thawed is a result the
caller has to interpret — which is how a recovery path acquires a branch that is only ever taken
during an incident.

**Every freeze carries a guest-side auto-thaw deadline, and what that deadline does depends on
what happened while the freeze was held.** A freeze the agent took with no clock disruption
observed since is the pause-abort case: the host froze the tenant, the pause failed, and the
host then went away, but the guest left behind is the guest the freeze was taken in. Its clock,
its environment, and its identity are all still the ones it had, so nothing needs to happen
before tenant code runs and the agent releases the freeze itself when the deadline expires. The
two failures are not comparable there: a sandbox thawed early is wrong in a visible and
survivable way, while a sandbox frozen forever is indistinguishable from a hung one — every
process exists, none runs, nothing is logged, and it stopped at an unremarkable moment. The
deadline is measured on the monotonic clock, which does not advance while the VM is paused, so a
freeze captured into an artifact does not expire while the sandbox sits in object storage.

**A freeze the agent is still holding after a clock disruption does not auto-thaw at all.** A
disruption means the sandbox was restored, and a restored sandbox whose thaw never arrived is
one whose post-restore hook never ran — which is the ordinary consequence of a host that is
wedged or partitioned after a successful restore. Its realtime clock reads the pause instant,
its hostname and machine identity are still the template's, and its environment and metadata
were never applied, because they arrive over vsock at that moment and are deliberately never
baked into an artifact. Every condition the hook exists to establish is unmet, so a deadline
firing there releases tenant code into precisely the guest the ordering guarantee was written to
prevent. The agent instead takes the behaviour
[vm-init](vm-init.md#supervision-and-restart-backoff) already specifies for an agent that cannot
start: stay frozen, present as a sandbox that never answers, and let the host destroy it from
outside on its own timeout. A sandbox that dies loudly is recoverable; one running tenant code
with a week-old clock and another tenant's machine identity is not.

The agent can only tell the two cases apart because the hypervisor tells it. Everything in the
guest is measured on the monotonic clock — correct, and it stays that way — and a monotonic
clock is exactly what makes a pause invisible, so nothing in the guest's own timekeeping
separates "the host aborted a pause a minute ago" from "the host restored this sandbox a week
later and then stopped answering". The [clock-disruption device](#the-clock-disruption-device)
supplies the missing fact, and it is the only thing that can.

**All four are reachable on the pause-abort path,** and that is the gap the earlier design left.
The tenant-cgroup freeze taken by `PrePause` is deliberately captured into the artifact and
released by the post-restore hook of whatever is restored from it — but a pause that *fails*
after the freeze has no restore, so there was nothing to run the hook, and the only thaw in the
system lived inside it. A host putting a sandbox back into service without having paused it
needs to thaw it, so the thaw cannot exist only as a step of the restore hook. The auto-thaw
deadline is the backstop for the worse case, where the host cannot reach the agent at all — and
the pause-abort path is precisely the path where that backstop is safe, which is why the split
above falls where it does.

### Exit status is ordered against trailing output

Output and lifecycle arrive as separate events on separate streams, so their relative order is a
decision rather than an accident. Undecided, a client can observe a process's exit and then
receive bytes the process wrote before it — and clients reasonably treat the exit as the end,
close their handle, and lose the tail.

The rule is that **the exit event is emitted after the agent has drained what it can read from
that process's streams**, and the event carries the sequence number up to which output is
complete. A client that has the exit event knows exactly how much output it should have.

The counterpart has to be stated in the same place, because the rule as written is not
achievable in general. A process can fork a daemon that inherits its standard output, so the
pipe stays open after the process itself exits, held by something the caller never asked about.
Waiting for end-of-file there means waiting forever. **The side this contract accepts is the
exit status:** the agent reports exit when the process is reaped and bounds the drain with a
short deadline rather than waiting for the pipe to close. Output arriving after that deadline is
still delivered on the stream with its sequence numbers intact, and the exit event says whether
the drain completed or was cut short — so a client can distinguish "this is all of it" from
"this is what there was in time", which is the distinction that actually matters when a build
log ends mid-line.

### Chunked write commits explicitly

`Write` is a client stream of chunks and **the final message is the commit**. Chunks are written
to a temporary file in the destination directory, and the commit renames it into place, so the
destination either does not exist or is the complete file and no reader ever observes a partial
one. The temporary lives in the destination directory specifically so the rename stays within a
single filesystem and is therefore atomic.

An abandoned upload — a dropped connection, a cancelled stream, a client that disappeared —
leaves the temporary and nothing else; the destination is untouched. The agent removes the
temporary when the stream fails, and separately sweeps temporaries whose stream no longer exists
once they exceed a bounded age, because the failures that skip the first path are exactly the
ones that skip cleanup generally. The age is measured on the monotonic clock, for the same
reason process records are: a sandbox can be paused mid-upload and resumed a week later, and the
week is not evidence about the upload.

## Error model

Errors carry an enumerated **code** plus a human-readable message. The code is part of the
contract and callers branch on it; the message is for logs and may change freely.

| Code | Meaning |
|---|---|
| `UNSUPPORTED` | The operation's capability bit is clear. Carries the required bit |
| `STALE_EPOCH` | The frame's epoch is not the current one |
| `NOT_FOUND` | No such process, watch, or path |
| `PERMISSION` | The guest kernel refused |
| `INVALID_ARGUMENT` | Failed validation |
| `RESOURCE_EXHAUSTED` | A guest-side limit was reached: watch count, process count, buffer cap |
| `FAILED_PRECONDITION` | Valid request, wrong state. Spawning while the tenant cgroup is frozen, or waiting on a process record that has expired rather than one that never existed |
| `INTERNAL` | An agent fault. Distinguished from the above so it can be alerted on separately |

`UNSUPPORTED` is a first-class outcome rather than an error of last resort. It is the expected
answer whenever a current host meets an older sealed agent, which in a system whose snapshots
outlive its deployments is a routine occurrence.

## The guest kernel is part of the sealed contract

The wire format is not the only thing a template seals. The agent is compiled against a set of
kernel features it uses unconditionally, and the template build is the moment a kernel and an
agent are paired for good.

**There is no negotiation path for any of this.** Capability bits describe what the agent can
do, not what the kernel beneath it can do, and an agent that finds a feature missing has no way
to say so in advance — the manifest already advertised the capability, the host already planned
around it, and the discovery arrives as an operation failing in a template that has shipped. So
the requirements are asserted by the template build, which fails rather than producing an
artifact that fails in the field.

| Requirement | Used for | If absent |
|---|---|---|
| Netlink socket diagnostics | Enumerating listening sockets | `ListPorts` answers nothing, and a tenant's server looks like it never started |
| cgroup2 with the freezer | The tenant cgroup: placement, freeze, thaw, kill | Freeze and thaw fail, so a pause captures a running guest |
| Unix98 PTYs with `devpts` | Every PTY-backed session | No interactive sessions at all |
| Atomic clone-into-cgroup | Creating a tenant process already inside its cgroup | Not a clean error — see below |
| Child subreaper | Keeping a tenant's descendants attached to the agent | Descendants escape to PID 1, which consumes their exit statuses |
| Process descriptors | Signalling without a pid-recycling race | Signals fall back to raw pids, reintroducing the race the descriptors exist to remove |
| The generation-identifier device | Reseeding the guest's random pool on resume | Every sandbox from one template shares its random state until something else reseeds |
| The `virtio-rng` front-end driver (`references/firecracker-docs/entropy.md:59-64`) | Drawing on the per-VM entropy device, both as an extra kernel entropy source and as `/dev/hwrng` for tenant code (`references/firecracker-docs/entropy.md:10-14`) | The device is attached and nothing reads it. The generation-identifier device still says *reseed*, and the only pool left to reseed from is the one every clone of this template already shares |
| The clock-disruption device | Telling the agent that a restore has happened at all, which the auto-thaw rule above depends on | The agent cannot distinguish a restore from an aborted pause, and auto-thaws tenant code into an uncorrected guest — see below |
| vsock loopback **off** | Keeping the control channel unreachable from guest userspace | The agent presents a connectable management channel inside the guest |
| A panic timeout on the kernel command line | Turning a guest kernel panic into a VMM exit | A panicking guest hangs with its memory still allocated instead of dying — see [vm-init](vm-init.md) |

One row is only half a kernel requirement, and the halves are delivered by different things. The
hypervisor permits a single entropy device per VM and it is attached by the host
(`references/firecracker-docs/entropy.md:16-20`), while the driver that reads it is compiled into
the guest at template build; either half without the other is inert, and neither reports
anything. [vm-host](vm-host.md) owns the attachment and the device model that records it. The
template build asserts the driver, because that is the half that cannot be changed once the
artifact exists.

The list is short and it is a contract. Adding to it is a template-rebuild event, exactly like
changing the agent, and for exactly the same reason.

### Atomic cgroup placement has preconditions

Two configuration preconditions, and both fail in ways worse than an error.

**The mount must genuinely be cgroup2.** On the older hierarchy the directory operations the
placement depends on appear to succeed — the directory opens, the descriptor is valid, nothing
complains — and the kernel then rejects the placement at clone time. What has to be checked is
the mount's actual filesystem type, not the existence of a path that looks correct.

**Properties are written without creating missing files.** Writing a cgroup property with the
usual create-if-absent behaviour converts "this controller is not enabled" into an ordinary file
sitting in the cgroup directory holding a number the kernel will never read. Nothing errors, the
limit is not applied, and the sandbox runs unconstrained until somebody investigates why. Opening
without creation turns a missing controller into an error at the moment it is missing.

There is also a state precondition rather than a configuration one. **Spawning into a frozen
tenant cgroup produces a process that is created already stopped.** During the pause window the
cgroup is frozen deliberately, so a spawn arriving then returns a valid process identifier for a
process that never runs, never emits a byte, and never exits — the worst available shape of
failure, because every observable thing about it looks like success. Spawn is therefore refused
with `FAILED_PRECONDITION` while the tenant cgroup is frozen.

### The clock-disruption device

The generation-identifier device answers "is this guest a second instance of an image somebody
has already run", which is the question entropy has. The freeze rules have a different one —
"has this guest been restored since I last looked" — and it is not answerable from inside,
because the guest measures everything on a clock that a pause does not advance.

The hypervisor therefore attaches a **clock-disruption device** unconditionally at boot,
alongside the generation-identifier device. On restore it bumps a disruption marker and a
generation counter, raises an interrupt **before the vCPUs resume**, and reports its clock status
as unknown — a standing statement to the guest that its own realtime clock is not to be trusted
until something corrects it. The ordering is the load-bearing part. The notification cannot
arrive after tenant code has observed the stale clock, because no guest instruction runs before
it, which is what makes the marker usable by a decision that has to be right the first time.

The agent reads it in one place, the auto-thaw rule above, and reads it as a fact about the
sandbox rather than as a time source. It supplies no wall time and is not consulted by the clock
step; the host remains the only source of a trustworthy time, for the reasons in
[vm-steward](vm-steward.md#post-restore-hook).

## Evolution rules

| Allowed | Forbidden |
|---|---|
| Adding a capability bit | Recycling a retired capability bit |
| Adding a new message type | Changing the meaning of an existing message |
| Adding a new field with a new number | Reusing a field number |
| Adding an enum variant | Changing an existing variant's number or meaning |
| Loosening validation on an existing field | Tightening it |

The two entries that look surprising both follow from the same asymmetry.

**Tightening validation is forbidden** because an old host will keep sending the old thing.
Validation is not only about what a current caller sends; it is about what every sealed
counterpart ever built might send. Rejecting input that used to be accepted breaks pairs that
worked yesterday.

**Changing the meaning of an existing message is forbidden** even when both sides are updated
simultaneously, because they are never simultaneously updated in the field. Somewhere a
snapshot holds an agent with the old interpretation. If a field's meaning changes, resuming
that snapshot silently does the wrong thing rather than failing — the bytes still decode. Adding
a new field and a new capability bit costs a few lines and fails loudly instead.

Enums always define an explicit zero `UNSPECIFIED` variant, so an absent field is
distinguishable from a deliberate one. Removed fields have their numbers reserved permanently.

### Golden serialization tests

The evolution rules are enforced by tests, not by review, because review does not survive
turnover.

The crate carries a directory of recorded encodings: for each message type, a set of canonical
values and their exact bytes, committed as fixtures. Two assertions run in CI. Every stored
fixture must still decode into the structure it decoded into when it was recorded — this catches
a field number reused, a type changed, or a meaning quietly redefined. And the current encoder
must reproduce the stored bytes for those canonical values, which catches an encoding change
that would be invisible from the decode side alone.

Adding a field is expected to add new fixtures and leave the existing ones passing untouched.
A change that modifies a stored fixture is, by definition, a change to the sealed contract, and
the failing test is the point at which somebody has to justify it.

A compatibility test runs alongside them, exercising the host against agents advertising
reduced capability bitsets — including a bitset with everything clear — to confirm the host
degrades to `UNSUPPORTED` rather than misbehaving.

## Concurrency and failure model

| Situation | Behaviour |
|---|---|
| Frame exceeds the maximum | Connection closed immediately, before allocation |
| Frame nests deeper than the recursion limit | Connection closed, before the decoder recurses further |
| Malformed protobuf | Connection closed. The host additionally treats repeated parse failures from one sandbox as grounds to terminate it, per [security](../architecture/security.md) |
| Connection drops mid-stream | Streams fail; guest-side objects survive; the host reconnects and reattaches |
| A response or event is lost to the device reset | Nothing is reported on either side. Recovery is by idempotency key, by re-issuing a read, or by reattaching from the last observed sequence number, per the table above |
| The port request after a restore finds no listener | Expected, not evidence of a dead sandbox. The unix connect will have succeeded; the hypervisor terminates the connection after the port request. The host retries with backoff |
| Stream credit exhausted | The writer blocks on that stream only |
| A stream misses its keepalive window | That stream is failed; the guest-side object it addressed is untouched and can be reattached |
| Unknown stream identifier | The frame is dropped and counted; it is a bug indicator, not a fatal condition |
| Operation not in the capability set | `UNSUPPORTED`, immediately |
| Epoch mismatch | `STALE_EPOCH`, immediately |
| Handshake presents a lower epoch than the current one | `STALE_EPOCH` and the connection is closed. A higher one supersedes |
| An auto-thaw deadline expires on a freeze held across a clock disruption | Nothing is thawed. The sandbox stays frozen and never answers, and the host destroys it from outside on its own timeout |
| The agent advertises a bit that its build is on the quarantine list for | The host subtracts the bit and degrades to `UNSUPPORTED`, before the restore where the manifest carries the build identifier |
| Spawn while the tenant cgroup is frozen | `FAILED_PRECONDITION`, rather than a process that exists and never runs |

There is no in-protocol reconnection or retry loop. Reconnection is the host's, because the
host is the side that can decide whether the sandbox still exists and is worth reconnecting to.

## Configuration

Almost everything here is a compile-time constant rather than configuration, and that is the
point: a configurable protocol parameter would be sealed into templates at whatever value it
held on build day, producing pairs that disagree with no way to reconcile them.

| Parameter | Where it lives |
|---|---|
| vsock port | Compile-time constant on both sides |
| Maximum frame size | Compile-time constant, exchanged in the handshake; the effective value is the minimum |
| Chunk size | Compile-time default, advertised in the handshake |
| Idempotency window | Compile-time constant on the agent |
| Per-stream credit window | Compile-time constant |
| Maximum decoder recursion depth | Compile-time constant on both sides |
| Per-stream keepalive interval | Compile-time default, advertised in the handshake |
| Auto-thaw deadline | Compile-time constant on the agent, measured on the monotonic clock, and suppressed entirely once a clock disruption has been observed |
| Capability quarantine list | Host-side configuration, deployable — it exists precisely because the agent it corrects cannot be |
| Concurrent relay streams per sandbox | Compile-time constant on the agent |
| Handshake and quiesce deadlines | Host-side configuration — the host is the side that can be redeployed |
| Post-restore connect retry and backoff | Host-side configuration, for the same reason |

The pattern to notice: anything that must be agreed is negotiated at handshake rather than
configured on both sides, and anything that is purely a host policy decision stays on the host.

## Observability

The crate itself emits nothing; it exposes counters and spans that its embedders export.

Host-side, `vm-host` exports per-sandbox: frames and bytes in each direction, active streams,
operation latency by operation, error counts by code, reconnects, handshake failures, rejected
oversized frames, and stale-epoch rejections. Three of those are the ones that matter
operationally. Reconnects should track pause and restore counts exactly; an excess means
connections are dropping for reasons nobody intended. `UNSUPPORTED` counts by capability bit
show which sealed agents are in the field and which templates need rebuilding. Stale-epoch
rejections should be near zero in steady state, since each one is an operation that outlived
its sandbox generation.

Every span carries the sandbox ID, the epoch, and the stream identifier, so a single PTY
session can be followed across a pause, a restore, and a reconnect. No message payload is ever
recorded: it is tenant data, and much of it is process output or file contents.

## Testing

| Layer | What it covers |
|---|---|
| Golden serialization | The evolution rules, as above. The load-bearing test suite for this crate |
| Fuzzing | The frame decoder, continuously, from both directions. Both sides parse input from outside their process. The corpus includes deeply nested messages, because nesting depth is the one dimension the size limit does not constrain |
| Ordering | An exit event never precedes output written before it, and a process that forks a daemon holding the pipe still produces an exit within the drain deadline rather than hanging |
| Freeze and thaw | Every operation applied twice, applied out of order, and applied on an abort path with no restore in sight; plus a freeze left unmatched, asserting the auto-thaw deadline releases it, and the same unmatched freeze carried across a real restore, asserting the deadline does *not* release it and the sandbox stays silent |
| Epoch conflict | A second handshake presenting a lower epoch is rejected and the connection closed; a higher one supersedes and frames under the previous epoch stop being accepted |
| Property | Chunking and reassembly round-trip for arbitrary payload sizes, including exactly at and either side of the frame boundary |
| Multiplexing | Interleaved streams under load, asserting fairness and that a saturated stream does not stall its neighbours |
| Reconnect | Sever the connection at every point in a long-lived operation and assert reattachment resumes correctly and without duplication |
| Idempotency | Replay every side-effecting operation inside and outside the window and assert the documented semantics in both cases |
| Compatibility | The current host against synthetic agents with reduced capability bitsets, and against an agent whose advertised bit is subtracted by the quarantine list, asserting the host takes the `UNSUPPORTED` path rather than a new one |
| In-VM | The real transport, including a real pause and restore, which is the only way to exercise the vsock device reset |

The in-VM snapshot test is not redundant with the reconnect test. The reconnect test simulates
a severed connection; only a real pause and restore exercises the device reset, the surviving
listening socket, and the interaction between a new epoch and guest-side objects that outlived
the connection. It is also the only test that can catch three things nothing else can: that the
agent's listener still accepts connections after a restore that changes the guest's context
identifier, that a connect issued immediately on restore is refused after the port request rather
than at `connect()` and the retry then succeeds, and that a `PostRestore` delivered twice by that
retry has the same effect as one delivered once.

## Rules that must not be violated

1. **The meaning of an existing message never changes.** Add a capability bit and a new message.
2. **Field numbers and capability bits are never reused.**
3. **Validation is never tightened on an existing field.**
4. **Never version-sniff, with exactly one exception.** The build identifier may never be used
   to infer that a capability is *present*; presence keys off capability bits and nothing else.
   Its one permitted use is the host-side quarantine list, which subtracts bits an agent
   advertises. Removing a capability is always safe; asserting one never is.
5. **Every frame carries an epoch, and a stale epoch is rejected.**
6. **Never allocate on an unvalidated length prefix.**
7. **The guest never initiates an operation.** All streams are host-opened.
8. **Long-lived operations are addressed by durable guest-side identifiers,** never by the
   connection or stream that created them, because connections do not survive a snapshot.
9. **Public API types never enter this crate.** The product API changes on a deploy cadence;
   this contract changes on a template-rebuild cadence, and the two must never be coupled.
10. **A change that modifies a golden fixture is a change to the sealed contract** and requires
    a justification recorded alongside it.
11. **Bound decoder recursion explicitly.** The frame size limit does not bound nesting depth,
    and a stack overflow in a decoder is a dead agent rather than an error.
12. **Epochs are monotonic.** A lower epoch is rejected and its connection closed; a higher one
    supersedes.
13. **Freeze and thaw are idempotent, and every freeze has an auto-thaw deadline — except one
    held across a clock disruption, which never auto-thaws.** A freeze that can only be released
    by a restore is a sandbox that can be frozen forever; a freeze released by a deadline *after*
    a restore is tenant code running against a stale clock and the template's identity, which is
    worse.
14. **Reconnect after a restore is always a retry with backoff,** and anything that retry loop
    can deliver more than once is idempotent.
