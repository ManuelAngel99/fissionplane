---
type: Component
title: control-plane
description: The replicated API service that admits callers, enforces quotas, places sandboxes onto nodes, owns the durable catalog, and mints capability tokens, without ever sitting on the data path.
tags: [component, control-plane, api, placement]
timestamp: 2026-07-27T07:33:00Z
---

# control-plane

`control-plane` decides *what should exist* and *where*. It is a Deployment of several
replicas on ordinary nodes, fronted by an HPA, and every replica is interchangeable with every
other.

## Purpose

The component exists to be the only place where a decision requiring durable state or
cross-node knowledge is made: whether a caller may act, whether an organisation has room,
which node should run a sandbox, and what the fleet currently contains. Everything that
follows from a decision — actually creating the microVM, moving bytes, proxying traffic — is
someone else's job.

**It is off the sandbox data path.** No tenant byte destined for a sandbox passes through it.
The concrete consequence, and the property the rest of this document is organised around:

> If every `control-plane` replica is down, running sandboxes keep serving traffic on their
> public hostnames. Only lifecycle operations stop — no creates, pauses, resumes, or deletes.

The property holds for outages shorter than the maximum sandbox lease, and the qualification is
load-bearing rather than pedantic: sandbox deadlines are enforced by the node and extended only
from here, so being off the data path is not by itself sufficient to keep sandboxes alive through
an outage. What makes the statement true is a specific mechanism on the node, described under
[deadlines](#deadlines) below.

This is not an incidental resilience property; it is the reason the component is allowed to be
as complicated as it is. Admission, quota arithmetic, placement scoring, and catalog
bookkeeping all involve judgement, schema, and change. Keeping them off the data path means a
bad deploy, a slow query, or a schema migration degrades the management experience rather than
dropping a tenant's live terminal session. It also means the deployment strategy can be
ordinary: roll replicas whenever, drain nothing special, tolerate brief total unavailability
during a migration.

The corollary is a discipline: any proposal that puts `control-plane` in front of tenant
traffic — a "smart" proxy hop, a synchronous authorization callback on each request, a metering
sidecar in the request path — forfeits this property and must be rejected on that basis alone.

## Responsibilities

| Responsibility | What it means concretely |
|---|---|
| Authentication | Verify an organisation API key or an OIDC bearer token on every request. |
| Authorization | Resolve the caller to an organisation and project, and check the requested operation against that scope. |
| Organisation and project scoping | Every row the API can reach is owned by an organisation; projects subdivide it for quota, naming, and audit purposes. |
| Quota enforcement | Concurrent sandboxes, memory and vCPU in flight, paused sandboxes, template count, artifact bytes stored, and request rate. |
| Template registry | Own template records and mutable aliases; resolve an alias to an immutable artifact ID at admission time. |
| Artifact bookkeeping | Own the rows describing artifacts — ownership, kind, lineage, lifecycle state — that the collector and placement consult. Every artifact is self-contained, so lineage is provenance and never something a read has to resolve. |
| Sandbox records | Create, update, and retire the durable record of every sandbox, including its node, epoch, deadline, state, egress policy, and tenant metadata. |
| Port exposure | Record explicit per-port `public` opt-ins, reject reserved platform ports, propagate versioned policy to the owning node, and audit every change. |
| Placement | Choose the node for a create or resume, and retry elsewhere when a node declines. |
| Node connectivity | Discover `vm-host` instances, hold one connection to each, and subscribe to its state. |
| Capability token minting | Issue the single credential type described in [security](../architecture/security.md). |
| Deadline management | Record and extend sandbox leases; the node enforces them. |
| Idle detection | Consume the node's traffic-liveness signal as an input to lease extension and to idle auto-pause. |
| Snapshot ageing | Refresh paused snapshots onto a supported VMM build before their format leaves support, or expire them with warning. |
| Usage metering | Open and close a usage period for every interval a sandbox consumes compute, in the transaction that moves its state. |
| Audit log | Write an immutable entry for every lifecycle and authorization decision. |

## Explicit non-responsibilities

| Not responsible for | Owner |
|---|---|
| Proxying tenant traffic, terminating TLS, routing by hostname | [gateway](gateway.md) |
| Anything touching Firecracker, cgroups, network namespaces, or slots | [vm-host](vm-host.md) |
| Moving artifact bytes, or deciding what a node caches | [vm-host](vm-host.md) and [artifact-store](artifact-store.md) |
| Building templates | [template-builder](template-builder.md) |
| The authoritative check that a request may reach a sandbox | [vm-host](vm-host.md) |
| Knowing a node's true capacity | The node itself |

Placement *influences* cache contents, by preferring nodes that are already warm, but it does
not instruct a node to fetch or evict anything. The distinction matters: cache policy is local,
measurable, and cheap to change; if the control plane started prescribing it, every eviction
decision would need a round trip and a durable record.

## Internal structure

The service is a Rust binary composed of modules with one-directional dependencies: the API
layer depends on the domain services, the domain services depend on the repositories and the
node client, and nothing depends back upward.

```
        ┌──────────────────────────────────────────────────────────┐
  REST  │  api          generated types + trait; routing by hand   │
  ─────►│  stream       hand-written event surface (small)         │
        └───────────────┬──────────────────────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────────────────────┐
        │  authn/authz · quota · catalog · placement · tokens       │
        │  deadlines · idle · usage · audit · reconciler            │
        └───────┬─────────────────────┬────────────────────┬───────┘
                │                     │                    │
        ┌───────▼──────┐      ┌───────▼───────┐    ┌───────▼───────┐
        │ PostgreSQL   │      │ Redis         │    │ nodes         │
        │ source of    │      │ routes/public │    │ informer +    │
        │ truth        │      │ limits, locks │    │ gRPC clients  │
        └──────────────┘      └───────────────┘    └───────┬───────┘
                                                           │ gRPC
                                                           ▼
                                                      vm-host ×N
```

### The API is specification-first

A hand-maintained OpenAPI document is the source of truth for the REST surface. From it are
generated the types and validation used by this component, and the Python and TypeScript
client libraries shipped to tenants. Handlers are written against generated types; the
generated code is never edited by hand, and CI fails if regenerating produces a diff.

The reasoning is about which artifact gets reviewed. In a code-first arrangement the
specification is an output: it is emitted from handler signatures and annotations, so it is
correct about types and silent about everything else — semantics, error taxonomy, pagination
shape, naming consistency across resources. Because it is derived, nobody reviews it; a change
to a handler quietly changes the contract, and the generated clients follow the handlers
wherever they go. The specification then trails the implementation, and the client libraries
drift apart from each other because each generator makes its own choices about whatever the
specification failed to pin down. The shape of that drift is not hypothetical: a platform of
this kind that went code-first ships a post-processing step in its build whose only job is to
repair enum names its generator mangled in one of its client languages — a permanent fixture,
maintained indefinitely, correcting a contract nobody reviewed.

Specification-first inverts that. The contract is a reviewable artifact in its own right: an
API change is a diff to a document, in a pull request, where naming, breaking-change risk, and
error semantics are visible before any handler exists. Both client libraries are generated
from the same reviewed document, so they agree by construction.

The cost is real and worth stating: the document must be written by hand, and it is another
thing that can be wrong. That cost is paid once per API change and is bounded; contract drift
is unbounded and is discovered by tenants.

#### What is generated, and what the compiler does not check

The rule that generated code is never edited by hand is only worth having if the toolchain can
deliver it, so the artifacts are named rather than implied.

| Artifact | Origin |
|---|---|
| Request and response types, and their validation | Generated from the specification |
| A handler trait with one method per operation | Generated from the specification |
| The Python and TypeScript client libraries | Generated from the specification |
| Routing, middleware, and the wiring from a route to a trait method | Hand-written |

The last row is the honest part, and it is why "a handler that fails to implement the contract
fails to compile" is not the claim being made. No comparable platform generates a **Rust**
server, and Rust's OpenAPI server generators are materially weaker than the equivalents in the
languages where this pattern is well trodden. The trait does buy a genuine compile-time
guarantee — a missing operation, a mistyped field, or a response body of the wrong type will
not build — and that is most of the value. What it cannot check is everything the hand-written
layer decides: that a request arrives on the path and method the document declares for that
operation, that no status code outside the declared set is ever returned, and that error
bodies match the shape the document promises.

Conformance for that layer is therefore enforced by a **test that drives the specification
against the running server**: every operation is exercised at its declared path and method, and
every response is validated against its declared schema and status set. It runs in CI beside
the regeneration diff. This is a weaker mechanism than compilation and is named as such rather
than left for someone to discover; an assumption that the types were doing the work is worse
than a test that says exactly what it covers.

### The streaming surface is separate and deliberately small

OpenAPI describes request and response *documents*. It cannot describe an unbounded sequence
of frames, a bidirectional channel, or a stream whose termination is itself meaningful. The
streaming parts of the product therefore live outside the generated surface: a small,
hand-written set of endpoints — principally subscription to sandbox lifecycle events — with
hand-written client support in both SDKs.

Keeping this surface small is a standing constraint rather than an accident. Every endpoint
moved into it is an endpoint that loses generated validation, generated clients, and
review-by-diff, and gains two hand-maintained client implementations that can disagree. The
test for whether something belongs here is narrow: the response must be genuinely unbounded in
time. Anything that merely returns a large result is paginated and stays in the specification.

Note that the high-volume streaming in the product — process output, PTY sessions, file
watches — is not here at all. It runs on the sandbox data path through [gateway](gateway.md)
to [vm-host](vm-host.md), which is exactly what keeps this component off that path.

## Interfaces

| Direction | Peer | Transport | Purpose |
|---|---|---|---|
| Inbound | Tenant SDKs, dashboards, CI | HTTPS, REST, generated from the specification | Sandboxes, templates, artifacts, organisation administration |
| Inbound | Tenant SDKs | HTTPS, hand-written frame stream | Lifecycle event subscription |
| Inbound | Cluster | HTTP | Health, readiness, metrics |
| Outbound | `vm-host` on every node | Unary gRPC calls over one persistent connection, dialled by this component | Lifecycle commands: create, pause, resume, delete, extend deadline |
| Outbound | `vm-host` on every node | One server-streaming gRPC call on that same connection | Node state up: capacity, cache warmth, sandbox inventory, per-sandbox traffic liveness |
| Outbound | Kubernetes API | Watch, via a pod informer | Node discovery over the `vm-host` DaemonSet label selector |
| Outbound | PostgreSQL | Pooled SQL | Source of truth |
| Outbound | Redis | Pooled | Routing cache, rate limits, short locks |
| Outbound | Object storage | S3-compatible API | Artifact prefix deletion for the collector; never artifact payloads |
| Published | `gateway`, `vm-host` | HTTP, cached by the reader | Token verification key set, keyed by key ID |

The verification key set is published rather than shared as a secret because the signing key is
asymmetric. Data-path components can verify tokens but cannot mint them, so compromising
`gateway` or a single node does not yield the ability to issue credentials. Verifiers cache the
key set and tolerate its absence for the lifetime of that cache, which is another way of saying
that token verification does not depend on this component being up.

## State owned

### PostgreSQL — source of truth

| Table | Purpose |
|---|---|
| `organisations` | Tenancy root. Everything else is owned by exactly one row here. |
| `projects` | Subdivision of an organisation for naming, quota, and audit scoping. |
| `quotas` | Limits per organisation and optionally per project. Usage against them is computed from rows, not stored here. |
| `api_keys` | Hashed key material, scope, and revocation state. |
| `templates` | Template records: owner, visibility, description, current state. |
| `template_aliases` | Mutable name to immutable artifact ID mapping; re-pointed atomically. |
| `artifacts` | One row per immutable artifact: kind, lineage, owner, size, lifecycle state. |
| `sandboxes` | One row per sandbox: organisation, project, template artifact, node, epoch, deadline, state and failure reason, tenant name and metadata, and egress allow and deny lists. Node-side resources are named by the identifier and epoch together. |
| `port_exposures` | Desired and active exposure revision for each explicitly recorded tenant application port. Absence means private; reserved platform ports are rejected before insert. |
| `paused_snapshots` | The artifact produced by a pause, the sandbox identity it can be resumed into, whether its upload is pending, published, or abandoned, the node currently preferred for its resume, and the time past which it is no longer restorable. |
| `usage_periods` | One row per interval a sandbox consumed compute: sandbox, resource shape, `start_at`, and `end_at`. |
| `audit_entries` | Append-only record of lifecycle and authorization decisions. |

Two schema rules are load-bearing. Every table that a tenant request can reach carries the
owning organisation, so scoping is a predicate on an indexed column rather than a property
enforced in application logic and forgotten in one handler. And sandbox state transitions are
guarded in the database, not just in code, so two replicas racing on the same sandbox produce
one winner and one clean conflict — which is a claim about the state machine below rather than
a general property of writing to PostgreSQL, and it holds only because that machine has the
transitional states it has.

There is no reservation table for quota. Quota is a **predicate over the organisation's rows in
resource-consuming states** — `creating`, `running`, `pausing`, `resuming`, and `terminating`
for the concurrency and memory limits, `paused` for the paused-sandbox limit — evaluated in the
transaction that inserts the row the next evaluation will count. That follows from the create
ordering, and the reasoning is
[below](#why-the-row-is-written-before-the-node-is-called).

### The durable state machine

The node has a state machine and it is not this one. That one is specified exhaustively in
[vm-host](vm-host.md); it is ephemeral, per-instance, per-node, and it dies with the daemon
that holds it. This one is the durable record. It survives the instance, the node, and the
replica, and it lands in three places that are expensive to change afterwards: a PostgreSQL
enum type, the OpenAPI document, and both generated client libraries. It is therefore
enumerated before the first migration rather than accumulated one handler at a time.

| State | Meaning | Consumes node capacity | Tenant-visible |
|---|---|---|---|
| `creating` | The row exists and a node is being chosen or has been dispatched to; no acknowledgement yet. | Yes | No |
| `running` | A node has acknowledged the sandbox and it is serving traffic. | Yes | Yes |
| `pausing` | A pause is in progress on the node. | Yes | No — reported as `running` |
| `paused` | The snapshot is written. The row also records whether its upload is pending, published, or abandoned. | No | Yes |
| `resuming` | A resume is in progress: a node has been chosen and dispatched to. | Yes | No — reported as `paused` |
| `terminating` | A delete is in progress on the node. | Only if it was running | No — reported as the state it left |
| `terminated` | Terminal. The sandbox ended as asked. | No | Yes |
| `failed` | Terminal. The sandbox ended otherwise; carries a reason and a recoverable flag. | No | Yes |

**The four transitional states are the lifecycle mutex.** This reads as bookkeeping and is not.
The claim that two replicas racing on one sandbox produce one winner and one clean conflict,
guarded in the database rather than in application code, has nothing to guard with unless these
states exist. The guard is a conditional update: a pause moves the row from `running` to
`pausing` and requires that it was `running`, so a second pause arriving concurrently updates
zero rows, and zero rows updated *is* the conflict. Delete the intermediate state and both
requests find `running`, both write `running`, both proceed. The node's own idempotency absorbs
the duplicate pause, which is worse than it sounds, because it means the defect surfaces
nowhere near its cause — in the pair of requests that were a pause and a delete rather than two
pauses. The alternative is holding a row lock across the node call, which is the
transaction-spanning-a-network-call this component refuses everywhere else.

Every transitional state therefore has a bound and a sweep, because a row that enters one and
never leaves is a sandbox nobody can act on: the tenant's next request is rejected by a mutex
held by a request that no longer exists. The bounds differ — `creating` must exceed a cold
create, while `terminating` need only exceed a delete — and each expiry moves the row to
`failed` with a reason naming the transition that stalled.

**`failed` carries a reason and a recoverable flag**, and this is the difference between a
terminal state and a shrug. A single bucket is the cheaper schema and it fails two people
simultaneously. The tenant asking why their sandbox died gets "it failed", which is not an
answer and generates a support request. The operator gets nothing to sweep on, because "every
failed sandbox" is not a set anyone can act on, while "every sandbox that failed recoverably in
the last hour" is exactly the set a retry or a page should be driven from. So the reason is an
enumerated cause — node lost, restore failed, deadline expired, drained without capture, no
node ever acknowledged, snapshot upload abandoned — with free text for detail, and the flag
answers the only question the caller's next line of code is asking: would issuing this request
again plausibly work.

**The tenant-visible set is the smaller one, and the OpenAPI enum contains only it**:
`running`, `paused`, `terminated`, `failed`. Transitional states collapse onto the state the
transition started from, and `creating` is not visible at all — the only caller entitled to
that sandbox is blocked inside the create call that will hand back its identifier, so there is
nobody to show it to. The reason is not tidiness. A tenant cannot act on a transitional state:
every request against one is rejected by the mutex, so publishing it offers a caller a status
whose only correct response is to wait. What publishing it costs is concrete — the enum becomes
something both SDKs and every tenant's exhaustive match must track, so adding an internal state
stops being a migration and becomes a breaking API change. The internal machine should be free
to grow states as the node protocol does; the contract should not have to move with it.

### Usage is metered as it happens

`usage_periods` holds one row per interval during which a sandbox consumed compute: the
sandbox, the resource shape it consumed, a `start_at`, and an `end_at` that is null while the
period is open. A **unique partial index over the sandbox, restricted to rows whose `end_at` is
null**, enforces at most one open period per sandbox — the invariant every billing question
rests on, expressed as a constraint the database rejects violations of rather than as a rule
one handler forgets under a retry.

Periods open and close **in the same transaction as the state transition that caused them**.
Entering `running` opens one; leaving it closes one. A resume opens a new period rather than
reopening the closed one, because it is a new instance, possibly on a different node and
possibly at a different shape. A paused sandbox's stored snapshot is not metered here: that is
a stock rather than a flow and it is counted as artifact bytes.

**The reason this cannot wait for there to be something to bill is that usage is the one thing
in the system that cannot be backfilled.** Every other derived table can be rebuilt from the
rows it summarises. A record of when a sandbox was running cannot be recovered from a database
that only ever stored what each sandbox's state is now. The audit log is the substitute
everyone reaches for and it is not one: it is designed to answer "who did what, and were they
allowed to", so it records decisions and the authorization context around them. Turning a
stream of decisions into intervals requires that every decision was written, that none was
written twice, and that a state change nobody requested — a node reporting that a sandbox died
— produced an entry at all. None of those is a property an authorization log is built to have.
An audit log is not a billing ledger with different column names, and the month that difference
first matters is the month it is too late to discover it.

### Network policy is scoped to the sandbox

Egress allow and deny lists are set **per sandbox, at create**, and stored as indexed columns
on the sandbox row. Elsewhere in this bundle they are described as a property of the
organisation, and the row has no column for them either way — so this is a decision that was
never made rather than one being reversed, and it is a column now or a migration later.

Per sandbox is right because the organisation is the wrong unit to reason about exposure with.
One organisation runs a build that needs the public package registries and, on the next call,
an agent evaluating model output that should reach nothing at all. An organisation-scoped list
has to be the union of what every workload in it needs, which is to say the least restrictive
policy any single workload required, applied to all of them. Setting it at create also makes it
part of the sandbox's identity rather than mutable state a caller can widen after the occupant
is already running, which is the only ordering that makes the constraint mean anything. The
node enforces the list; see [networking](../architecture/networking.md).

### Public ingress is explicit and per port

Every tenant application port is private without a `port_exposures` row. A `public` row admits
anonymous traffic to that exact `(sandbox, port)` and is created only through the control-plane
API. The configured sandbox agent port is reserved and rejected; platform-management surfaces
never participate in exposure policy.

The node remains the authoritative enforcement point. Exposure changes carry a monotonically
increasing policy revision over the existing control link and the API waits for the owning
`vm-host` to acknowledge it before activating that revision in the gateway's routing view. The
desired revision is written first so a replica crash is reconcilable. This order fails closed in
both directions: widening may leave a node prepared while the edge still says private, and
narrowing may leave a stale edge forwarding requests that the node now denies.

A paused sandbox has no owning runtime to update. Its desired exposure is stored and applied to
the selected node before resume publishes the route. Every create, update, and deletion writes an
audit entry in the transaction that activates the revision.

### Tenant metadata and names

A sandbox carries **arbitrary tenant key-value metadata**, listable and indexed, and an
optional **name unique within its organisation**. Both are columns rather than features,
because both are free now and a migration under load later.

Metadata is what makes the API usable by the thing that actually calls it, which is usually not
a person. A framework creating a hundred sandboxes needs to find *its* sandboxes, by run, by
user, by task — and a caller with no way to label a sandbox keeps that mapping in its own
database and reconciles it against ours, which it will do badly and which will be our incident
when it drifts. Indexing it is the part that is a schema decision: metadata nobody can filter
on is a comment field, and retrofitting an index onto a JSON column across a large table is
exactly the migration this is written down to avoid.

The name is a different mechanism wearing similar clothes. It is a uniqueness constraint, so it
gives a caller a stable handle it chose itself and a create that collides fails cleanly instead
of quietly producing a second sandbox — which is idempotency for callers that have a natural
key and did not want to invent one.

### Redis — cache only

Redis holds the sandbox routing view read by [gateway](gateway.md) — owning node plus active
public ports and policy revision — rate limit counters, and short locks used to keep periodic
jobs from running concurrently in several replicas. Nothing in Redis is authoritative, and
nothing is written there that cannot be recomputed from PostgreSQL.

A reconciler rebuilds the routing and exposure view from PostgreSQL on a schedule and exports a repair
counter. **In steady state that counter reads zero.** It is a defect signal, not a routine
maintenance statistic: if entries are being repaired, some write path failed to update the
cache, or something is writing to Redis that should not. Treating it as ordinary background
noise defeats the purpose of exporting it, so it is alerted on rather than merely graphed.

### Not state

Nothing durable is held in process memory. Capacity views, node sets, and cached key material
are all reconstructible, and a replica that starts cold reaches parity within one informer sync
and one round of node-state subscriptions.

## Placement

Placement is a pure function from a candidate node snapshot and a request to an ordered
decision, wrapped in a retry loop that talks to nodes. Keeping the decision pure is what makes
it testable, because the interesting failures are distributional rather than functional.

### The pipeline

1. **Eligibility.** Keep nodes that have a live connection, report ready through their
   Kubernetes readiness probe, are not draining, and whose reported restore compatibility key
   matches the artifact's `runtime` block **in every field it covers**: host CPU architecture,
   CPU family and model or the CPU template identifier, host kernel version, snapshot format
   version, guest kernel identity and boot args, and the device model set.

   This is a **hard filter, not a score contribution**, and none of it may be softened into a
   preference. Guest CPU and device state are captured verbatim and reloaded verbatim, with no
   renegotiation, so a mismatch is a corrupt restore rather than a degraded start. The two ways
   to violate it are ordinary rather than exotic — a node pool containing more than one instance
   type, and a node-image rollout that leaves half the fleet on a new host kernel — and both
   produce a fleet where most placements work and some silently do not. See
   [snapshots](../architecture/snapshots.md).

   **The hypervisor does not enforce the CPU half of this, which is precisely why placement
   must.** It is tempting to justify the filter as saving a create budget that a failed restore
   would consume, and that justification is wrong: a mismatched restore is not refused. The
   hypervisor logs a warning and proceeds, and the guest runs — until it executes an instruction
   the boot-time feature set promised it and the host does not have. The fault then lands
   arbitrarily far from the restore, inside tenant code, attributable to nothing. A refused
   restore would be the good outcome. The filter exists because the failure the hypervisor
   actually permits is silent, delayed, and paid by the tenant.

   **`vmm_version` is deliberately not in this filter.** A node carries more than one VMM build
   and the artifact's manifest names the one its device state was written by, so restoring
   selects a *binary on the node* rather than restricting which nodes are eligible. Filtering on
   it instead strands every paused sandbox produced before a VMM rollout on the shrinking set of
   nodes still running the old build — during the rollout, which is the moment the fleet is
   least uniform and the constraint is most often violated in practice. `snapshot_format` stays
   a hard filter, because that one the hypervisor genuinely does enforce: a device-state file in
   a format no binary on the node can parse is rejected outright, and there is no build to
   select.
2. **Capacity.** Keep nodes whose last reported free memory covers the artifact's `guest.mem_mib`
   plus per-sandbox overhead, whose sandbox count is under the node's cap, and whose slot pool
   is not exhausted. **If that leaves nothing, fall back to the eligible set from step 1, scored
   pessimistically, and let the nodes refuse.**

   The fallback is the same one warmth already has and it is needed for a stronger reason. This
   filter is a stale local view of a quantity the node owns, and a view that has just gone empty
   is the view most likely to be wrong — a fleet that has finished a wave of deletes reports as
   full for exactly as long as its reports are old. Without the fallback, a stale control-plane
   view vetoes a placement the fleet would have accepted, which contradicts the rule that the
   node is the authority on its own capacity. Refusing on our own belief is the one thing this
   component is not entitled to do here; asking and being told no is.
3. **Warmth.** Keep nodes whose cache already holds the required artifact. **If that leaves
   nothing, fall back to the full set from step 2.** A cold start is slower; a refusal is an
   error. Slow beats refused.
4. **Sample.** Draw a small random subset of the survivors — a handful of nodes, not a fraction
   of the fleet.
5. **Score and select.** Compute a weighted sum over the sampled nodes only, and take the best
   of them.
6. **Dispatch, and retry on refusal.** Call `CreateSandbox` over the existing connection. If the
   node refuses, handle it according to the classification below and re-enter at step 2 with the
   remaining candidates, drawing a **fresh sample** rather than taking the runner-up from the
   previous one — the previous sample was chosen against a fleet view that the refusal has just
   corrected.

| Scoring dimension | Direction | Rationale |
|---|---|---|
| Committed CPU | Lower is better | Spreads compute demand; committed rather than instantaneous, because instantaneous is noisy and lags creates. |
| Free memory | Higher is better | Memory is the binding constraint on sandbox density. |
| Sandbox count | Lower is better | Bounds per-node blast radius and keeps slot pools from concentrating. |
| In-flight creates against this node | Lower is better | Creates this replica has dispatched and not yet seen accounted for. See the accounting gaps below; without this term a node's attractiveness does not change until it answers, which on a cold create is seconds. |
| Cache warmth degree | Higher is better | Only distinguishes candidates when step 3 fell back; a partially filled memory file still beats an empty one. |

Weights are configuration, not constants in code, because the right balance depends on the
node shape an operator runs.

### Why the candidates are sampled before they are scored

Always taking the fleet-wide maximum is the obvious choice and it is wrong here, for a reason
that has nothing to do with the quality of the score.

Several replicas place concurrently, each against its own slightly stale view of the fleet.
Capacity updates arrive on the subscriptions asynchronously, and a sandbox that one replica has
just placed is not yet visible to the others. If every replica deterministically maximises the
same function over nearly the same inputs, they all reach the same answer at the same time and
stampede one node — the same node that is, by construction, the most attractive one in the
fleet. It absorbs a burst of creates, refuses the tail of them, and the retry loop redirects
that tail to the next-best node, which is now also being maximised toward. The result is
oscillation and a burst of avoidable retries at exactly the moment the system is busiest.

The obvious repair is to score everything and then pick at random among the top few, and it is
worth being precise about why that is not what happens here, because it reads as equivalent and
is not. **Scoring every survivor and drawing from a global top-k does not get better as the
fleet grows.** The candidate group is derived deterministically from inputs that every replica
shares, so every replica computes the *same* group of k nodes whatever the fleet size, and the
chance that two concurrent placements collide stays at roughly one in k on a fleet of ten nodes
and on a fleet of a thousand. Randomising the choice within a fixed-size shared group buys a
constant factor, not a property that scales.

Sampling first inverts that. Each replica draws its own random subset, so the sets two replicas
consider are usually different, and the probability that they collide falls as the fleet grows
rather than staying fixed. Taking the best of a small random sample is also the arrangement with
the known load-balancing result behind it: a sample of a few candidates captures nearly all of
the benefit of full knowledge, and the improvement over a single random choice is large while the
improvement from sampling more is quickly negligible. The sample size is the knob. One degenerates
to uniform random placement and ignores the score; a sample approaching the fleet size degenerates
to global maximisation and stampedes.

One consequence has to be accepted rather than engineered away: **the best node in the fleet is
not always chosen, by construction.** That is the mechanism working. The score exists to avoid bad
placements, not to identify a single optimal one, and the difference between the best node and a
good node is small next to the cost of every replica agreeing on it simultaneously.

### The node is the authority on its own capacity

Replicas maintain optimistic local views and **do not coordinate with each other**. There is no
shared capacity ledger, no lease on a node, and no lock taken before a placement. A view can be
wrong; the mechanism for being wrong is a refusal from the node, after which the control plane
excludes it and retries elsewhere.

Distributed locking is the alternative, and it is worse on every axis that matters.

A lock would have to be held across the whole create operation, because the capacity it
protects is not consumed until the node has actually allocated memory, a slot, and a disk. That
operation includes a restore, which is the slowest thing in the system on a cold node. So the
lock serialises the create path against the fleet's slowest operation, converting a
parallelisable workload into a queue.

It would not even be correct. A lock protects the control plane's *belief* about capacity, not
the capacity itself. The node is the only party that knows its true free memory, the state of
its slot pool, and whether an eviction is in flight, so the node must check regardless. Once
the node checks, the lock protects nothing — it only makes the common case slower and adds a
lease-expiry story for replicas that die mid-placement.

And it would be a new dependency in the create path, with its own availability, its own
failure modes, and its own operational surface. The refusal-and-retry design needs none of
that: refusal is a normal, cheap, well-tested return value, and the cost of a wrong guess is
one extra round trip on an existing connection.

Refusal rate is therefore a metric to watch rather than a condition to eliminate. Near-zero
means views are fresh. Persistently high means capacity reporting is lagging or the fleet is
genuinely full, and those two causes are distinguishable from the accompanying capacity
staleness metric.

### Refusals are classified, not merely counted

Treating every refusal identically is the natural implementation and it fails in the one
situation that matters, which is a burst of creates against a busy fleet.

**Resource exhaustion is transient, and often transient on the timescale of a single request.**
A node that has no slot right now may have one within the drain delay; a node at its memory
ceiling may be seconds from a delete completing. If an exhaustion refusal permanently excludes
that node for the remainder of the request *and* spends one of a small number of retries, then a
burst arriving at a fleet running near capacity walks a handful of candidates, exhausts the
budget, and fails — while returning an error to a tenant the fleet could have served moments
later. The failure is worst exactly when the platform is busiest and its customers care most.

So refusals divide in two, and the two are handled oppositely.

| Refusal | Meaning | Handling |
|---|---|---|
| Transient exhaustion — no slot, no headroom, semaphore saturated, fetch in flight | The node cannot take this work *now* | The node is **deprioritised, not excluded**: it moves to the back of the candidate order and may be reconsidered once other candidates have been tried. The refusal **does not count against the retry budget**. |
| Hard failure — compatibility key mismatch, node draining, artifact rejected, malformed request, node-scoped terminal error | The node cannot take this work at all | The node is excluded for the request, and the refusal counts against the retry budget. A hard failure repeated across candidates usually means the request itself is wrong, and the budget is what makes that fail fast. |

Not counting transient refusals against the budget requires something else to bound the loop, and
that is a **wall-clock deadline on the create**, derived from the caller's own timeout. A deadline
is the right bound here where a counter is not: the cost being controlled is the tenant's waiting
time, not the number of round trips, and a round trip over an established connection to a node
that answers immediately is cheap enough that ten of them are preferable to one avoidable
failure. When the deadline expires the create fails as resource-exhausted, which is an accurate
description of the fleet and a signal the caller can retry against.

### Two gaps in capacity accounting

The optimistic local view is not merely stale in the ordinary sense; it has two specific holes,
and both cause the same symptom of a node being chosen when it should not be.

**A sandbox that has been chosen but not yet accepted exists in neither view.** Between dispatch
and reply the node does not yet know about the sandbox, so it is absent from that node's reported
capacity, and the replica has not yet recorded it either. On a cold create that window includes an
artifact fetch and a restore and is measured in seconds — long enough for the same replica to
place several more sandboxes onto a node it believes is still empty. The remedy is the in-flight
term in the score: every dispatched-and-unanswered create counts against its target node's
attractiveness immediately, and the term is released when the node's reply arrives or the create
times out. It is a per-replica quantity and deliberately not shared; the point is to stop one
replica stampeding a node on the strength of its own unacknowledged work, and cross-replica
collisions are what sampling handles.

**A capacity report that predates a create overwrites the optimistic delta.** Nodes report
capacity periodically, and a report generated before a create was accepted describes a node
without that sandbox on it. Folding the in-flight deduction into the reported figure and then
applying the report verbatim erases the deduction, restores the node's apparent capacity, and
makes it attractive again — so the node attracts another create, and the cycle repeats for as
long as reports are older than dispatches. The symptom is a node that appears repeatedly in the
selected-node distribution and refuses repeatedly.

The remedy is a matter of where the deduction lives rather than of ordering the two against each
other. **In-flight creates are held in a term outside the reported snapshot.** A report replaces
what the node said about itself and nothing else; the deductions for creates this replica has
dispatched and not yet seen answered are applied on top of whatever the latest report says. A
stale report cannot erase them because it was never holding them, and the half of the problem
that matters is closed with no protocol addition at all.

What that leaves uncovered is one window, and leaving it uncovered is the decision. Between a
node accepting a create and its next report, the create has left the in-flight term — the reply
arrived — and is not yet in the reported figure. Closing it means a generation marker on every
report, a recorded dispatch position for every deduction, and a rule that applies a report only
when its marker postdates the dispatches it would erase. That is a protocol field, a per-dispatch
record, and an ordering rule, for a window one report interval wide, and no comparable platform
at scale has needed it. It is therefore recorded as a refinement rather than built, gated on the
two metrics already exported that would show it mattering: a refusal rate that stays elevated
while capacity staleness is low, and a selected-node distribution containing a node that
repeatedly appears and repeatedly refuses. Absent both, the machinery would be paying for a
symptom nobody has observed.

The **capacity staleness threshold stays**, and it was always doing separate work. A node whose
most recent report is older than the threshold is **scored pessimistically and dropped from
sampling** rather than being treated as accurate — a node not reporting is a node the control
plane knows nothing current about, and the safe reading of "no information" is not "unchanged
since last time".

## Node discovery and connectivity

Nodes are discovered through a Kubernetes pod informer over the `vm-host` DaemonSet's label
selector, keyed by **node name** and dialling the pod's host address. Node name is the right
key because it survives pod recreation on the same machine, which is precisely what "the
sandbox is on that machine" means. Because `vm-host` runs with `hostNetwork`, the pod address
is the host address and is reachable directly. The transport details and why a ClusterIP
Service would be actively wrong are covered in [networking](../architecture/networking.md).

**Every replica holds its own persistent gRPC connection to every node.** A fleet of R replicas
and N nodes therefore carries R×N connections, which is a deliberate trade: connections are
cheap, and what they buy is the absence of an entire class of coordination.

### Commands are unary calls, not a command stream

Lifecycle commands are **ordinary unary RPCs multiplexed over that one connection**. The
tempting alternative is to make the command path a bidirectional stream — commands framed down,
replies framed up, over one long-lived call — and it is tempting because a long-lived control
link *looks* like a stream. What it actually is, once written, is a reimplementation of the
transport underneath it.

Work through what a command sent down a stream needs. A correlation identifier, so a reply can
be matched to the command that caused it. A per-command timer, because the stream's own deadline
covers the whole call rather than any one command on it. A way to tell the node that a command
has been abandoned, since the caller may have gone away while the node is still restoring. A
bound on how many commands may be outstanding before the sender must stop, or a slow node
becomes an unbounded queue in a replica's memory. And an error taxonomy that distinguishes a
node refusing from a connection breaking, because the retry behaviour is opposite. gRPC supplies
all five — request/response correlation, per-call deadlines, cancellation propagated to the
server, flow-controlled backpressure, and a status code space the refusal classification below
is already expressed in. A hand-rolled command stream supplies them again, worse, in code that
is exercised in anger only during an incident.

Exactly **one call is server-streaming**: a node-state subscription carrying capacity,
per-artifact cache warmth, sandbox inventory, and per-sandbox traffic liveness. It qualifies
under the same test applied to the tenant-facing streaming surface — it is genuinely unbounded
in time — and two properties depend on it being one long-lived call rather than a poll. On
connect the node sends **full state** rather than a delta, so a replica never has to reason
about what it missed while disconnected, which is the property that makes reconnection
uninteresting. And the subscription dropping is the node's own evidence that its control link is
gone, which is the trigger for deadline suppression; a poll that stopped arriving is
indistinguishable from a poll that is merely late, and suppression cannot be built on a signal
that cannot tell those apart.

### Why the control plane dials outward

Having nodes dial in is the more familiar arrangement and it does not survive contact with
multiple replicas. An inbound connection lands on exactly one replica, so that replica *owns*
the node. Any other replica that needs to command that node cannot; it must forward the command
to the owner. That requires a message bus, which requires the bus to be available for lifecycle
operations to work, which requires knowing which replica currently owns each node, which
requires failover when a replica dies and its nodes reconnect elsewhere — and a way to detect
that the owner is gone rather than merely slow.

Dialling out deletes all of it. Every replica reaches every node directly. There is no
ownership, so there is no ownership transfer; there is no bus, so there is no bus outage; a
replica dying affects only its own connections, and the node notices nothing beyond one
connection closing. Any replica can serve any lifecycle request for any sandbox, which is what
makes the Deployment genuinely horizontally scalable rather than a set of shards wearing a
Service.

The arrangement depends on nodes being addressable from the control plane, which inside one
cluster they are. Should nodes outside the cluster ever be supported, the node transport sits
behind an interface and the direction can be inverted for that case specifically, paying the
bus cost only where it is unavoidable.

### Readiness and failure behaviour

Node readiness is **the Kubernetes readiness probe** — `vm-host` reports unready until its cache
is warm enough to serve. There is consequently no bespoke registration protocol, no heartbeat
table, and no node lifecycle state machine of our own to keep in sync with the cluster's. A
node that is unready is filtered out at step 1 of placement, and one that becomes ready becomes
placeable with no action from us.

There is one wrinkle worth naming, because it is the reason the DaemonSet's readiness is used
rather than the connection's health: a node can be connected and unready, or ready and briefly
unreachable, and those mean different things. Connected-and-unready is a node still warming its
cache, which should take no placements and should keep serving the sandboxes it already has.
Ready-and-unreachable is a node we cannot command, which is also unplaceable but for a different
reason and with a different remedy. Both are filtered at step 1; only the second one suspends
deadline enforcement.

If the Kubernetes API is briefly unavailable, **the informer cache keeps serving the last known
node set**. Placement continues against nodes that already exist, which is the overwhelmingly
common case, and the only lost capability is noticing nodes that arrive or depart during the
outage. A departed node is discovered anyway when its connection drops. This is why the informer
cache is read directly rather than the API being queried per placement: a per-request query
would make every create depend on the cluster's API server availability, for information that
changes on the timescale of node scaling rather than of requests.

Connections reconnect with jittered backoff, and the node-state subscription is re-established
with them. On connect, the node sends a full capacity snapshot, its current sandbox inventory,
and the traffic liveness of every sandbox on it, after which updates are deltas — full state on
connect removes any need to reason about what a replica missed while disconnected. A node that
cannot be reached is ineligible for placement, but its running sandboxes are unaffected: they
are served by `gateway` talking directly to that node, which is the off-the-data-path property
doing its work.

## Key flows

### Create

1. Authenticate the caller; resolve organisation and project.
2. Resolve the template alias to an immutable artifact ID, and authorise the organisation to use
   that artifact. Authorization happens here, before any node is asked to fetch anything.
3. **Allocate a secure 24-character lowercase-alphanumeric NanoID and `INSERT`
   the row in `creating`**, in one transaction that also evaluates quota
   against the organisation's rows in resource-consuming states and records
   the requested name, metadata, egress policy, and deadline. This transaction
   commits before any node is called.
4. Run placement; **record the chosen node on the row**; dispatch `CreateSandbox`, retrying
   according to the refusal classification and re-recording the node on each attempt.
5. On acknowledgement, move the row from `creating` to `running`, open its usage period in that
   same transaction, and publish the routing entry to Redis. On terminal failure, move it to
   `failed` with a reason.
6. Mint a capability token for the new sandbox and its epoch; write the audit entry; return the
   sandbox ID, hostname, and token.

The create is **synchronous**: the caller is blocked across all six steps and receives a usable
sandbox or an error. Only the ordering of step 3 against step 4 has changed from the obvious
arrangement, and that ordering is the subject of the next section.

### Why the row is written before the node is called

The natural arrangement is the other one: place, dispatch, and write the row when the node
answers. It has the appeal of never recording a sandbox that does not exist, and everything
awkward downstream follows from it.

Two things go wrong, and both are structural rather than incidental. **Quota has to be held
somewhere other than the row**, because the row does not exist yet — which means a second table,
a conversion step, an explicit release on every failure path, and an expiry sweep to cover the
replica that dies in between. That is a substantial mechanism whose entire purpose is to stand
in for a row that is minutes of work away from being written. And **a sandbox can exist on a
node with nothing in the database that knows about it**, which has to be reconciled by a timer
generous enough to cover the slowest cold create in the fleet — a timer whose failure mode, if
it is set even slightly too short, is destroying live sandboxes, preferentially on cold nodes,
which is to say preferentially during the traffic spike that made the fleet cold.

Inserting the row first deletes both. Quota stops being a reservation and becomes what it always
was: **a predicate over the organisation's rows in resource-consuming states**, evaluated in the
same transaction that inserts the row the next evaluation will count. Two creates racing at an
organisation's limit are serialised by the database, one commits and the other is refused, and
there is nothing to convert, release, or expire. The reservation table, the conversion step, and
the expiry sweep are gone, and so is the failure in which quota leaks because a replica died
holding some.

**No transaction is held open across the call to a node.** That rule is unchanged, and it is
what made the other ordering look necessary — a transaction spanning an artifact fetch and a
restore would pin a connection and its locks for the duration of the slowest operation in the
system, and under a burst that is a direct route to pool exhaustion across every replica at
once. The distinction is that this transaction *commits before* the dispatch rather than
spanning it. It is a short write, and the node call happens outside it.

The cost is that a row can exist for a sandbox that never starts. That is the correct direction
to be wrong in, and it is not close: a row with no sandbox is a small amount of quota an
organisation is briefly denied, reclaimed by a sweep and visible in a metric, while a sandbox
with no row is a tenant's untrusted workload running on a node with nobody accountable for it,
metered by nothing and reaped only by a heuristic.

Creates still accept an idempotency key, which now keys the sandbox row itself rather than a
separate reservation. Node RPCs are idempotent on the sandbox identifier and epoch, so a retry
after a lost response adopts the existing sandbox instance rather than creating a second one.

### The identifier alphabet excludes the hyphen

Step 3 mints the identifier, and the identifier is not an opaque key. It is a component of a
hostname label: a sandbox is published at `<port>-<sandbox-id>.<domain>`, and
[gateway](gateway.md) parses that label by splitting at the **first** hyphen and taking
everything to its right as the identifier. A second hyphen anywhere in the label is a rejection
today, deliberately, so that a third field can be added to the format later without every
hostname the platform has ever issued having to be reinterpreted.

That parse holds only if an identifier can never contain a hyphen, which makes it a constraint
on this component rather than a validation detail at the edge. **The alphabet excludes the
hyphen.** Permit it and this component mints hostnames the edge refuses — not all of them, only
the fraction that happen to draw one, and only once real traffic arrives. A defect that affects
some identifiers and not others, that no fixture with a hand-written identifier reproduces, and
that presents as an intermittent bad hostname in production, is the worst available shape for a
format mistake.

The asymmetry is what settles it. Excluding a character at the mint is a line in the generator
and costs nothing. Permitting it spends the hostname format permanently: the separator would
have to become some other character, or the format would stop being extensible, and neither is a
decision that can be made after tenants hold hostnames.

**The length is the same decision rather than an adjacent one.** The whole label is bounded by
the DNS limit of 63 octets, against which `gateway` already budgets the port, the separator, and
the third field it is keeping room for. What that budget leaves is the identifier's length. So
the alphabet and the length are chosen together and chosen once: a longer identifier is bought
out of the same 63 octets a future field would need, and the alphabet is restricted to
characters a resolver and a certificate both accept.

### Reconciling the node's inventory against the database

The node reports its sandbox inventory on the node-state subscription, in full on connect. Two
rules reconcile it against PostgreSQL. Between them they cover both directions of disagreement,
and neither can destroy a live sandbox that the database believes in — which is the property the
grace period used to be responsible for and used to get wrong.

**A node-reported sandbox with no row is destroyed immediately.** There is no grace period and
none is needed. The row is written before the node is called, so by the time a node can be
reporting a sandbox at all, the transaction that created its row has already committed. A
sandbox the database has never heard of was not created by any path this component takes.
Waiting does not make it more legitimate; it only leaves an unaccounted workload running on a
privileged node. The rule extends to a sandbox whose row is in a terminal state, for the same
reason and with the same immediacy: the durable record says this sandbox is over.

**A row in `creating` past the cold-create bound with no acknowledgement from any node moves to
`failed`**, with a reason recording that no node ever confirmed it. This is the other direction
— the replica died between dispatch and acknowledgement, or the acknowledgement was lost. The
bound still has to exceed a cold create, because that is how long a legitimate `creating` row
can be waiting on an artifact fetch and a restore. What has changed is the consequence of
setting it wrong. Too short a bound now marks a row `failed` and, when the node's late
acknowledgement arrives, destroys a sandbox the database has already disowned — loud,
attributable, counted, and reported to the tenant as a failed create. Too short an orphan grace
period used to silently destroy a sandbox the tenant was already using. Both bounds are guesses
about the same quantity; only one of them fails safely.

### A create that times out is retried where the cache is warm

A dispatch that exceeds its per-attempt timeout is not evidence that the node is unhealthy; on a
cold create it is most often evidence that the node is still fetching. Re-placing that request
onto a different node throws away everything the first node has done — a partially or fully
fetched artifact, a slot, a jail — and starts the same cold fetch again somewhere else, which is
both slower for the caller and more load on the object store.

So a timed-out create is **retried against the same node first**, with the same operation
identifier. The node's commands are idempotent, so the retry either finds the original create
still in progress and returns its eventual result, or finds it finished and returns that. Only if
the node refuses the retry, hard-fails it, or becomes unreachable does placement move elsewhere.
The warm cache is the asset worth preserving, and the party holding it is the party that just
spent the time to acquire it.

### Resume

As create, with placement biased toward the node that produced the snapshot: that node's cache
almost certainly still holds the artifact. The bias is normally a strong preference rather than a
pin — once the artifact is published, it is durable in object storage and any eligible node can
restore it.

**While the upload is still outstanding it is a pin, not a preference.** The node reports the
upload status of each snapshot it holds, and a snapshot reported as pending exists nowhere else:
placing its resume on another node would fail on a fetch of an artifact whose manifest has not
landed. So a resume against a pending snapshot goes to the producing node or waits, and a resume
against a snapshot whose upload was abandoned fails with a terminal error rather than being
retried around the fleet.

**A resume that times out records where the artifact was being warmed.** A dispatch that
exceeds its per-attempt timeout is, on a resume, almost always a node partway through fetching
the snapshot — and therefore a node about to hold the only warm copy of it in the fleet. If the
caller's retry is placed by ordinary resume affinity it goes to the node that *produced* the
snapshot, which may be neither warm nor available, and a second cold fetch of the same artifact
begins while the first completes and is never used. So the timed-out attempt writes that node
onto the snapshot row as its **preferred node** before returning the failure. Writing it durably
is the point rather than an implementation detail: the retry is a new request that may be served
by any replica, so a per-replica memory of who was warming what does not survive the single hop
it has to survive. The preference is advisory and expires; it displaces the producing node while
it is current and falls back to it afterwards.

The resumed sandbox gets a **new epoch**, so tokens minted against the previous instance fail
closed. Because the resume usually lands on the machine the previous instance just left, that
epoch is also what keeps the old instance's teardown from colliding with the new instance's
resources; every host-side name is keyed by sandbox identifier and epoch for exactly this reason.
See [vm-host](vm-host.md).

### Pause and delete

Both are a guarded transition into a transitional state, a command to the node, a routing cache
removal, the closing of the sandbox's usage period, a transition into the resting state, and an
audit entry. The guarded transition comes first and is what makes a concurrent conflicting
request fail cleanly rather than reach the node. Neither waits for the node's background upload:
the pause is complete for control-plane purposes when the node reports that the VM is
snapshotted, and the artifact becomes visible when its manifest lands.

The row records which of those has happened, because the two are materially different promises to
a tenant. A snapshot reported as **upload pending** exists on one machine and is lost if that
machine is; a snapshot reported as **published** is durable. The node reports the transition
between them, and it also reports the third outcome — an upload that exhausted its retry budget —
which moves the row to a terminal failed state rather than leaving a paused sandbox that can
never be resumed. Presenting a pending pause as durable would be the more comfortable choice and
is the one that produces an unrecoverable surprise later.

### Paused snapshots age out, and refreshing them is the default

A paused sandbox is restorable only for as long as some VMM build that can read its device-state
file is still deployed, and
[snapshots](../architecture/snapshots.md#how-long-a-paused-snapshot-stays-restorable) establishes
that this is a window with an end: essentially every change to the microVM state description
bumps the snapshot format's major version, each build reads exactly one version, and a release
leaves support in months rather than years. Because an artifact **selects** a binary rather than
filtering placement, nothing closes that window except our own willingness to stop carrying old
builds — and a build carried past its support window receives no fixes for critical bugs or
security issues while hosting a hostile guest. The bound is therefore a policy we choose rather
than a constraint the system imposes, and choosing it is this component's job.

It is this component's job because nobody else can do it. `vm-host` reports which builds it
carries and is right to stop there: a node sees one slice of the fleet, holds no durable record
of a snapshot it is not currently storing, and has no relationship with the tenant who owns it.
Acting on an ageing snapshot needs the artifact rows, the sandbox rows, the quota, and somebody
to tell. All four are here.

Two dispositions are honest, and only two.

| Disposition | What it costs | When it applies |
|---|---|---|
| **Refresh** — restore the snapshot on a supported build and pause it again | One create's worth of work, at a moment we choose | The default. The sandbox survives and the tenant is not involved. |
| **Expire** — release the snapshot and move the row to `failed`, recoverable false, with a reason | The tenant's state | Only where refresh cannot run: the organisation has been at its limit for the whole horizon, or refresh has failed repeatedly. |

**Refresh is the default and expiry is the fallback**, because the promise a paused sandbox makes
is that it resumes. A tenant pauses precisely in order to come back later, so expiry is the
platform failing at the one thing the feature exists for — and failing at it for an entirely
internal reason, an upstream release cadence the tenant has never heard of. Refresh costs a
restore and a pause, which is capacity we can schedule, spread, and plan for. Expiry costs
someone their work. There is no reading of that trade where the option that is cheaper for us is
the right default.

Nothing in refresh is a new mechanism. It is a resume followed by a pause, so the sandbox walks
`paused` → `resuming` → `running` → `pausing` → `paused` through states that already exist, and
what it produces is in the current format because **every pause writes the device-state file
fresh**. The format constraint binds that file alone and no part of it is inherited, so a refresh
of a parented snapshot is an ordinary merge-on-pause rather than a special case.

Two things about a refresh are not ordinary, and both follow from the tenant not having asked for
it. The sandbox's **tenant-visible state stays `paused` throughout**, rather than collapsing
`pausing` onto `running` the way a tenant-initiated pause does: a paused sandbox that appears to
start running by itself is a worse answer than a brief inaccuracy, and no token was minted
against that instance for anyone to be confused by. And its **usage period is marked
platform-initiated**, so the compute is measured — we want to know what refreshes cost — without
being billed to a tenant who did not request it. The at-most-one-open-period invariant is
untouched; only the attribution changes.

#### The sweep ages in cohorts, so it needs a rate limit

Ageing is a periodic sweep, single-flighted by the same short Redis lock as the routing
reconciler, the artifact collector, and the deadline sweep, and idempotent for the same reasons.
The sandbox's snapshot row records the bound directly rather than deriving it from a manifest on
every pass, so the sweep is an indexed range query rather than a scan.

What is not like the other sweeps is the shape of the population. **Snapshots do not age
uniformly; they age in cohorts**, because the bound is set by the support window of a format
version and every snapshot sharing that version reaches it within days of every other. Left
unbounded, the sweep answers by placing restores for a large fraction of the fleet's paused
sandboxes at once — a self-inflicted burst of precisely the cold, artifact-fetching creates that
placement is most expensive at, and one that competes with whatever real traffic is arriving. So
refresh is rate-limited and runs continuously **against** the horizon rather than at it, and the
horizon is sized to give that rate room to drain a cohort before the bound arrives.

#### The tenant is told before, not after

**A tenant discovering that a month-old paused sandbox is simply gone, with no prior signal, is
the failure this is designed against**, and it is what every implementation that treats ageing as
a cleanup job produces. Three things prevent it. The paused sandbox's API representation carries
the time past which it stops being restorable, so a caller that reads the sandbox at all sees the
bound without needing to know the mechanism exists. Crossing the warning horizon emits a
lifecycle event on the subscription surface, with enough of the horizon still left for a tenant
to resume the sandbox themselves if they would rather not rely on us. And an expiry writes an
audit entry naming its reason, because "why did my sandbox die" needs an answer that outlives an
event nobody was listening for.

Refresh makes all of this invisible in the ordinary case, which is the point of it being the
default. The warning exists for the sandboxes refresh could not save.

#### Quota and collection

Both interactions fall out of mechanisms already here, and neither wants a special case.

A refresh consumes what a resume consumes for as long as it runs, and it is placed like one, so
it counts against the organisation's concurrency and memory limits through the ordinary predicate
over rows in resource-consuming states. An organisation pinned at its limit defers its refreshes,
which is the correct behaviour and is also why the horizon is generous rather than tight. One
that stays pinned for the whole horizon has its snapshots expire, so refreshes deferred for quota
are exported as their own count — that outcome should be predicted from a rising number, not
discovered from a tenant.

A refresh produces a **new artifact ID**, because artifacts are immutable and a rewritten
device-state file is a different artifact. The snapshot row re-points to it, after which the
previous artifact is referenced by no alias and no paused sandbox and becomes collectable under
the collector's existing rule. An expiry drops the same reference without producing a
replacement. Neither path deletes bytes itself; both drop references and leave the collector to
act, which keeps deletion ordered manifest-first in the one place that knows to do it.

### Template publication and alias resolution

`template-builder` produces an artifact; `control-plane` records it and can re-point an alias to
it atomically. Aliases resolve at admission time, so a sandbox is always created from a concrete
immutable artifact ID and a re-point mid-flight cannot change what a caller gets.

### Traffic liveness comes from the node

Two decisions here need the same fact: when a sandbox was last used. Lease extension wants it so
that an active sandbox is not reaped mid-session, and idle auto-pause wants it so that a sandbox
nobody is using stops costing a node's memory. `vm-host` owns that fact and reports it on the
node-state subscription, as a **last-traffic timestamp and an open-stream count, per sandbox**.

It has to be the node, because the node terminates every data-plane connection there is. A PTY
session, a file upload, a published-port connection, and a process's output stream all end at
`vm-host`. Last-traffic time and the number of currently open streams are therefore quantities
it already holds exactly, and reporting them costs two fields on a message it was already
sending. Nothing else in the system knows them at all.

`gateway` is the obvious second candidate and is the wrong one. It sees the same connections,
but it is stateless by design, so recording activity would mean calling this component — a
control-plane round trip on the data path, for every request, which is the single thing this
component is organised around never doing. The rule against a synchronous callback in the
request path does not have an exception for a cheap one; a metering hop is exactly the proposal
that rule exists to refuse.

The two signals are reported separately rather than one being derived from the other, because
they answer different questions. A sandbox whose last traffic was twenty minutes ago and whose
PTY is still open is a developer thinking, and pausing it destroys a session someone is about to
type into. So **idle auto-pause requires both an idle last-traffic time and no open streams**,
while lease extension takes the timestamp alone.

`control-plane` treats both as input to a decision made here, never as an instruction. A node
that reports everything as busy delays auto-pause on that node and nothing else; it cannot
extend a lease, because extension is still an explicit command this component issues.

### Deadlines

`control-plane` records and extends a sandbox's deadline; **`vm-host` enforces it**, from
outside the guest. The split is deliberate. If expiry were driven by a timer in this component,
a control-plane outage would let every sandbox in the fleet outlive its lease, and a hung or
hostile sandbox would only be reaped when the control plane happened to be healthy. Pushing
enforcement to the node makes the lease self-executing: the authority that can actually kill the
VM is also the one holding the clock.

#### The split has a failure mode, and it needs a mechanism rather than a caveat

Deadlines are enforced by the node and extended only by the control plane. Those two facts
together mean that a total control-plane outage does **not** simply pause lifecycle operations:
extensions stop arriving while enforcement continues, so every sandbox dies at its current
deadline. An outage lasting longer than the shortest outstanding lease starts killing sandboxes,
and one lasting longer than the maximum lease kills the entire fleet. That is a data-plane
failure caused by a control-plane outage, and the claim that running sandboxes are unaffected by
one is false without something to close the gap.

The mechanism is on the node, because the node is where the clock is. **A `vm-host` whose control
link is down suspends deadline enforcement**, and resumes it a grace window after the link is
re-established. The reasoning is that a deadline is only meaningful if the party responsible for
extending it is reachable: enforcing a lease that nobody can renew is not enforcement, it is a
timer with the renewal path removed. The grace window after reconnect exists so that the control
plane has time to push the extensions it accumulated while disconnected, before any sandbox is
judged against a deadline that was current an outage ago.

Two properties are preserved deliberately. Suspension is scoped to the deadline and nothing else:
a sandbox that violates the guest protocol, whose VMM exits, or that is explicitly deleted still
dies immediately, because none of those depend on the control plane. And suspension is driven by
the node's own view of the link rather than by anything a sandbox can influence, so the
occupant-cannot-veto-its-own-termination invariant is untouched — an outage extends every lease
on the node uniformly, and no guest can cause one.

The cost is honest and small: during an outage, sandboxes that should have expired keep running
and keep consuming capacity. Set against a fleet-wide termination of live tenant workloads
because a management service was down for an hour, it is not a close comparison.

**This mechanism is unvalidated by prior art, and that is worth recording rather than
implying.** Comparable platforms enforce expiry from the control plane, so they do not have our
failure mode and consequently have no version of our fix; nothing here is a pattern borrowed
from a system that has run it. The reasoning stands on its own, the cost of being wrong is
bounded by the suppression window, and being wrong is observable — sandboxes outliving their
leases during an outage is a countable event. But it is our argument rather than a validated
one, and the first operator to hit it should know that.

Suppression is nonetheless **bounded**, by a window sized against the maximum sandbox lease. A
control plane that never returns must not leave a fleet running indefinitely with nothing able to
reclaim it, so past that bound the node resumes enforcement and sandboxes expire. The practical
reading is that an outage shorter than the maximum lease costs nothing, and an outage longer than
it does stop sandboxes — which is a much better boundary than the shortest outstanding lease, and
is stated in the failure table rather than left to be discovered.

One case the mechanism does not cover is worth naming, because it looks like the case it does
cover. **A control plane that is reachable but not extending deadlines is not an outage from the
node's point of view.** The connections are up, so suppression never engages, and deadlines are
enforced normally against leases nobody is renewing. A wedged deadline sweep is therefore more
dangerous than a crashed replica, which is why the deadline-extension rate is exported as a
signal in its own right rather than being inferred from overall health.

## Concurrency and failure model

The service is an async Rust binary. Each request is a task; blocking work does not exist on the
request path; database access goes through a bounded pool sized so that the sum across replicas
stays under the server's connection limit — a fleet of replicas each with a generous pool is a
common way to take PostgreSQL down.

Concurrency between replicas is handled by the database rather than by agreement between
replicas. The guarded transitions into the transitional states, together with unique
constraints, turn races into conflicts and conflicts into ordinary error responses — the
lifecycle mutex is a conditional update, and it is the only one there is. The only other mutual
exclusion in the system is the short
Redis lock that keeps periodic jobs — the routing reconciler, the artifact collector, deadline
sweeps — from running in several replicas at once. Those locks are advisory: if one expires
early and two replicas run the same sweep, the result is duplicated work, not corruption,
because each sweep is itself idempotent.

| Failure | Effect |
|---|---|
| One replica dies | Others continue. Its connections close; nodes notice nothing else. Rows left in a transitional state are swept to `failed` when their bound passes. |
| All replicas down, for less than the maximum lease | Running sandboxes keep serving traffic. No creates, pauses, resumes, or deletes. Tokens already issued keep verifying, because verifiers cache the key set. Nodes see their control links drop and suspend deadline enforcement, so no sandbox is killed for a lease nobody could renew. |
| All replicas down, for longer than the maximum lease | **Sandboxes do stop.** Deadline suppression is bounded, and past that bound nodes resume enforcement rather than run a fleet indefinitely with no management. This is the outer limit of the off-the-data-path property, and it is a bound on outage duration rather than an unqualified guarantee. |
| Replicas reachable but not extending deadlines | Worse than being down. The links look healthy, suppression does not engage, and sandboxes expire on schedule against leases nobody is renewing. Detected by the deadline-extension rate, not by liveness. |
| PostgreSQL unavailable | Lifecycle operations fail closed. Nothing is silently accepted. Data-path traffic is unaffected. |
| Redis unavailable | Routing falls back to PostgreSQL, rate limits degrade to local counters, periodic jobs pause. Latency rises; correctness does not change. |
| Kubernetes API unavailable | The informer cache serves the last known node set. Placement continues; node arrivals and departures are noticed late. |
| One node's connection drops | The node is excluded from placement. Its sandboxes keep serving, and it suspends their deadline enforcement until the link returns. On reconnect it re-reports full state and enforcement resumes after the grace window. |
| A node reports a sandbox no row accounts for | Destroyed immediately. The row is written before the node is called, so there is no legitimate window in which one can be missing. |
| A replica dies mid-create | The row stays in `creating` and is swept to `failed` once the cold-create bound passes. Quota is released by that transition; nothing separate holds it. |
| A node refuses placement for exhaustion | Deprioritised for this request and reconsidered if other candidates run out. Does not spend the retry budget. |
| A node refuses placement for a hard reason | Excluded for this request; spends one of the retry budget. |
| Object storage unavailable | Alias resolution and records are unaffected; cold creates fail at the node, warm creates succeed. |
| Refreshes cannot keep up with an ageing cohort | Snapshots reach their bound and are expired. Predicted by the time-to-bound distribution and the deferred-refresh count, both of which move well before any expiry. Never answered by retaining an out-of-support VMM build. |

Shutdown is unremarkable by design: stop accepting new requests, let in-flight lifecycle
operations finish or be swept, close connections. Because node RPCs are idempotent and every
transitional state has a bound, a replica killed at any point leaves no state that requires
manual repair.

## Configuration

| Setting | Purpose |
|---|---|
| Replica count and HPA targets | Capacity for the management API. Sized independently of sandbox load. |
| Placement weights | Relative importance of committed CPU, free memory, sandbox count, in-flight creates, warmth degree. |
| Placement sample size | How many eligible nodes are drawn at random before scoring. One degenerates to uniform random placement; the whole fleet degenerates to global maximisation. |
| Placement retry budget | Maximum **hard** failures tolerated before a create fails. Transient exhaustion does not count against it. |
| Create deadline | Wall-clock bound on the whole placement loop, derived from the caller's timeout. This, not the retry budget, is what bounds retries against transient exhaustion. |
| Per-attempt dispatch timeout | When a create is retried against the same node rather than re-placed. |
| Resume affinity strength | How strongly the snapshot-producing node is preferred. Ignored while that node reports the snapshot's upload as pending, when it is a pin rather than a preference. |
| Snapshot preferred-node lifetime | How long a node recorded by a timed-out resume outranks the snapshot's producing node. |
| Capacity staleness threshold | Age past which a node's reported capacity is scored pessimistically and the node is dropped from sampling. |
| Transitional state bounds | Per state, how long a row may sit in `creating`, `pausing`, `resuming`, or `terminating` before it is swept to `failed`. The `creating` bound must exceed the worst-case cold create. |
| Idle auto-pause threshold | How long a sandbox must report no traffic, with no open streams, before it is paused. |
| Maximum restorable age | How long a paused snapshot stays restorable. Derived from the support window of the build its format requires, not chosen freely. |
| Refresh warning horizon | How far ahead of that age a refresh is attempted and the tenant is warned. Must leave the refresh rate limit room to drain a whole format cohort. |
| Refresh rate limit | Concurrent and per-interval ceiling on platform-initiated refreshes, so a cohort ageing together does not become a burst of cold creates. |
| Deadline suppression bound and reconnect grace | How long a node may suspend deadline enforcement while its control link is down, and how long after reconnect before enforcement resumes. |
| Connection keepalive and backoff | gRPC ping interval, reconnect backoff bounds and jitter. |
| Informer resync interval | Periodic full reconciliation of the node set. |
| Token TTLs and signing key ID | Root and attenuated lifetimes; the active key for new signatures. |
| Key set publication cache lifetime | How long verifiers may serve a cached key set. |
| Default quotas | Per-organisation limits applied on creation. |
| Maximum sandbox deadline | Upper bound on a lease, independent of what a caller requests. |
| Database and Redis pool sizes | Bounded per replica so the fleet stays under server limits. |
| Reconciler and collector intervals | Frequency of routing repair, artifact collection, deadline sweeps. |

## Observability

| Signal | Why it is exported |
|---|---|
| Request rate, error rate, and latency per operation | Baseline health of the management API. |
| Placement outcome counts, split by refusal class: placed, deprioritised-for-exhaustion, hard-failed, deadline-exhausted | Transient refusals are expected and cheap; hard failures and deadline exhaustions are not, and folding them together hides the difference between a busy fleet and a broken one. |
| Placement decision latency | Separates scoring cost from node dispatch cost. |
| Selected-node distribution | Detects a degenerate score that concentrates load despite sampling. |
| Capacity staleness per node | The direct explanation for elevated refusals. Read together with the refusal rate and the selected-node distribution, it is also the gate on whether generation-marker reconciliation is ever worth building. |
| In-flight creates per node | The term the score depends on. A value that never returns to zero means replies or timeouts are being lost. |
| Rows swept out of each transitional state | Every one of these is a lifecycle operation that died holding the mutex. `creating` sweeps mean creates are being lost between dispatch and acknowledgement; the others mean a replica died mid-operation. |
| Sandboxes destroyed as unaccounted, and rows whose node acknowledged after the sweep | The two reconciliation rules firing. The second is the direct measure of a `creating` bound set too tight. |
| Open usage periods versus sandboxes in a compute-consuming state | These must agree. A gap in either direction is a billing defect that cannot be repaired retroactively, which is why it is a metric rather than a monthly reconciliation. |
| Deadline extensions issued per interval | The signal that distinguishes a healthy control plane from one that is reachable but wedged. Nodes cannot detect that case; this is what does. |
| Idle auto-pauses, and sandboxes idle by timestamp but holding open streams | The second is the population the open-stream count protects. If it is large, the threshold alone would have been paused sessions somebody was using. |
| Paused snapshots bucketed by snapshot format version and by time remaining to their bound | The leading indicator for snapshot ageing. It sizes the next cohort before it arrives, which is the only way the refresh rate limit can be set to a number rather than guessed. |
| Refreshes attempted, succeeded, deferred for quota, and failed | Deferred-for-quota is the one that predicts expiries. A rising count is an organisation whose snapshots are going to be expired unless something changes. |
| Snapshot expiries, by reason | Every one of these is tenant state the platform destroyed. It is a defect signal in the same sense the routing repair counter is, not a throughput statistic. |
| Connected nodes versus known nodes | The gap is the placeable fraction of the fleet. |
| Informer cache age | Reveals a silent Kubernetes API outage. |
| Routing cache repair counter | **Zero in steady state.** Non-zero means a write path is failing. Alerted, not merely graphed. |
| Quota rejections by organisation | Distinguishes platform faults from tenants hitting their limits. |
| Tokens minted by key ID | Confirms rotation completed and the old key can be retired. |
| Audit write failures | An audit entry that fails to persist is a compliance defect, not a log line. |

Every request carries a request identifier, generated if the caller did not supply one, that is
propagated into node RPCs and into traces so a single tenant action can be followed from the API
call to the node that served it. Tokens, API keys, and signing material are redacted in logs and
traces. The audit log is a durable, queryable table and is deliberately not the same thing as
application logging: logs are for operators and are allowed to be lossy, audit entries are for
tenants and auditors and are not.

## Testing

Placement is a pure function and is tested as one: a fixed node snapshot plus a request yields a
decision, with no clock, no network, and no database. Beyond the obvious unit cases, the
properties worth asserting are distributional and easy to lose in a refactor — a node failing
eligibility is never selected; a warm node is never passed over for a cold one when a warm one
has capacity; the selection is spread across the fleet rather than concentrated; and a node
mismatching any single field of the restore compatibility key is never chosen at any warmth or
score, which is asserted field by field rather than for the block as a whole. Two negative cases
belong in the same table and are easy to omit because they assert that a filter does *not* bind:
a node differing only in VMM version is selectable, and a candidate set emptied by the capacity
filter falls back to the eligible set rather than failing the placement.

The concurrency behaviour is tested against a fake node harness that accepts a configurable
number of sandboxes and then refuses: many replicas placing simultaneously against a small fleet
must converge without over-admitting and without failing creates the fleet could have served.
Two properties of the current design are asserted here specifically, because both are invisible
in a single-replica test. Collision rate must **fall as the simulated fleet grows**, which is the
property that distinguishes sampling from drawing at random within a globally computed group and
that would silently disappear if someone replaced one with the other. And a fleet that is
temporarily full but draining must still serve the burst, which is the property that disappears
if transient exhaustion starts counting against the retry budget.

The API contract is tested from the specification rather than from the handlers, and in two
layers, because the toolchain only covers one of them. CI regenerates the types, the handler
trait, and both client libraries, and fails on any diff, so the specification cannot silently
trail the code. On top of that, the specification is driven against the running server —
every operation at its declared path and method, every response validated against its declared
schema and status set — because the hand-written routing layer is where a Rust server's
generated surface stops and nothing about compilation reaches it. Breaking-change detection runs
against the previous published document, and the tenant-visible state enum is part of what it
guards. The identifier generator is property-tested against the alphabet and length the hostname
format depends on — no hyphen, nothing outside a host label, and within what the 63-octet budget
leaves — because the defect it prevents appears only for the fraction of identifiers that happen
to draw a bad character, which is exactly the shape an example-based test misses.

Everything touching state runs against real PostgreSQL and Redis in containers rather than
in-memory substitutes, because the behaviour that matters — guarded transitions, unique
constraint conflicts, pool exhaustion — does not exist in a substitute. Failure injection covers
the cases the failure table claims to handle: kill the informer, drop connections mid-command,
make Redis disappear, kill a replica after a successful node create and assert the row does not
stay in `creating` forever.

Four assertions deserve naming, because each is about a mechanism whose absence is silent rather
than loud. **The lifecycle mutex** is tested by issuing conflicting operations against one
sandbox from several replicas simultaneously and asserting exactly one reaches the node and the
rest receive a conflict — with the node harness counting commands, since the node's own
idempotency would otherwise hide a duplicate. **Usage periods** are tested by driving a sandbox
through create, pause, resume, and delete under injected failures at every step and asserting
that no sandbox ever holds two open periods and none is left open after a terminal transition;
the unique partial index should make the first of those unprovokable, which is the point of
trying to provoke it. **Both reconciliation rules** are tested from the node side: a node
reporting a sandbox with no row must see it destroyed on the first pass rather than after a
delay, and a `creating` row whose acknowledgement arrives after its bound must end as `failed`
with the sandbox destroyed rather than as a live sandbox with a dead row. And **a simulated
control-plane outage** must leave sandboxes running for its duration and expire them once the
suppression bound passes, which is the whole content of the availability claim and the one
mechanism here with no prior art behind it.

## Deferred, and deliberately

The [out-of-scope list](../architecture/overview.md#out-of-scope-for-the-first-release) records
the omissions that are architectural. These are the ones specific to this component: product
capabilities that comparable platforms ship, that nothing in this bundle currently mentions, and
that would each need durable state here, an API surface, or both. None is specified, and none is
half-built.

| Deferred | What it would need here |
|---|---|
| Persistent volumes attached to a sandbox | A volume catalog, an attachment model, and a new placement constraint, since a volume binds a sandbox to wherever it lives and that competes with every other placement input. |
| Forking a running sandbox | The node edge is close — a checkpoint already returns a sandbox to running — but forking needs a durable parent-child relationship and a decision on what the child inherits. Identity, deadline, egress policy, and metadata are each separately arguable. |
| Warm pools of pre-created sandboxes | Sandboxes with no owner, which every schema rule here assumes cannot exist. Quota, audit, and organisation scoping all key on a tenant that a pooled sandbox does not have until someone claims it. |
| Tenant webhooks on lifecycle events | An outbound delivery path with retries and a signing story. It is the same information the lifecycle event subscription already carries, pushed rather than pulled. |
| Snapshotting a sandbox that keeps running | The node-side edge exists and is specified in [vm-host](vm-host.md), and there is no control-plane flow, durable state, or API for it. This is the smallest of these and the closest to free. |
| Admin surfaces for terminating a tenant's sandboxes and cancelling their builds | An operator-scoped authorization path distinct from tenant scoping, which the current model has no notion of at all. |

Recording them is the point of the section. An omission nobody wrote down is indistinguishable
from one nobody thought of, and the second one gets re-litigated in a design review a year from
now with no record of why it was left out.

## Rules that must not be violated

1. **`control-plane` is never on the sandbox data path.** No proposal that routes, proxies, or
   synchronously gates tenant traffic through this component is acceptable, regardless of how
   convenient it is. A metering or activity-recording callback is the same proposal wearing a
   cheaper cost estimate.
2. **PostgreSQL is the source of truth; Redis is a rebuildable cache.** Nothing may be stored in
   Redis that cannot be recomputed, and nothing may read Redis as authoritative.
3. **The node is the authority on its own capacity.** A refusal is respected: the request goes
   elsewhere before that node is considered again, and the node's answer is never overridden by
   the control plane's view. A refusal for transient exhaustion deprioritises the node for the
   request; it does not permanently exclude it and does not spend the retry budget.
4. **Replicas do not coordinate to place.** No distributed locks, no leases on nodes, no shared
   capacity ledger. Short Redis locks exist only to keep periodic jobs single-flighted.
5. **Sandboxes are never Kubernetes objects.** The catalog lives in our datastore.
6. **The OpenAPI document is edited by hand and generated code never is.** A handler may not
   introduce a field, status code, or error shape that the specification does not describe. For
   the hand-written routing layer, which the generator does not cover, that rule is enforced by
   the spec-driven conformance test rather than by compilation.
7. **The hand-written streaming surface stays minimal.** Only genuinely unbounded responses
   qualify; everything else is paginated and stays in the specification. The same criterion
   governs the node protocol: exactly one server-streaming call — the node-state subscription —
   and every command is a unary RPC.
8. **A sandbox identifier is a 24-character lowercase-alphanumeric NanoID.**
   Its roughly 124 bits of entropy match UUID-v4-scale collision resistance
   without UUID punctuation. The identifier is a hostname label component and
   the hyphen is that label's field separator, so permitting one mints
   hostnames the edge rejects. The alphabet and length are one decision, taken
   against the 63-octet DNS limit that [gateway](gateway.md) budgets.
9. **Placement filters on the restore compatibility key as a hard filter.** Host CPU
   architecture, family and model or CPU template, host kernel version, snapshot format version,
   guest kernel identity and boot args, and the device model set. No field is a score
   contribution, and no field is skipped because a fleet is assumed homogeneous. `vmm_version` is
   deliberately not in the set: it selects a binary on the node, and filtering on it strands
   paused sandboxes across a rollout.
10. **No transaction is held open across a call to a node.** The sandbox row is inserted and
    committed before dispatch, never around it.
11. **The sandbox row exists before any node is called**, and quota is a predicate over rows
    rather than a reservation held anywhere else.
12. **Every lifecycle operation takes the mutex before it takes the network.** The guarded
    transition into a transitional state commits first; a request that updates zero rows is a
    conflict and never reaches a node.
13. **A node-reported sandbox that no live row accounts for is destroyed immediately**, and a
    transitional state that outlives its bound becomes `failed` with a reason. Neither rule ever
    waits on the other.
14. **A usage period opens and closes in the same transaction as the state transition that
    caused it.** Usage is never derived from the audit log and never backfilled.
    Platform-initiated compute is measured and attributed as such, never billed to a tenant who
    did not ask for it.
15. **A snapshot is never kept restorable by retaining an out-of-support VMM build.** The
    dispositions for an ageing snapshot are refresh and expiry. Extending the fleet's exposure to
    an unpatched hypervisor to avoid an expiry is not a third one, however loudly the expiry count
    argues for it.
16. **Deadline enforcement is the node's, and is suspended while the node cannot be reached to
    extend it.** The control plane never enforces expiry itself.
17. **Authorization precedes any node instruction.** The organisation's right to an artifact is
    checked before `vm-host` is asked to fetch it.
18. **Every minted token carries a sandbox ID, an epoch, a scope, and a short expiry.** There is
    no long-lived sandbox credential and no unscoped one.
19. **Signing keys never leave this component.** Verifiers receive public key material only, and
    no signing key is ever delivered into a guest.
20. **Every lifecycle and authorization decision produces an audit entry**, including denials.
