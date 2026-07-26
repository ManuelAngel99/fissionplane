---
type: Architecture
title: Networking
description: Per-sandbox network isolation, egress policy, public port exposure, host-to-guest transport, and coexistence with the cluster CNI.
tags: [architecture, networking, nftables, netns, ingress]
timestamp: 2026-07-27T07:33:00Z
---

# Networking

Every sandbox gets its own network namespace on the node. This document covers how that
namespace is built, how traffic reaches it from the internet, how the guest reaches out, how
`vm-host` talks to the guest, and how all of this avoids disturbing the cluster's own
networking.

## Goals and constraints

1. A sandbox must not reach another sandbox, the node's services, or the cluster network.
2. A guest port must be publishable at a stable public hostname, on demand.
3. Setting up and tearing down a sandbox's network must be fast, because it is on the create
   path.
4. None of it may interfere with the CNI that other workloads in the cluster depend on.

## Per-sandbox topology

Each sandbox occupies a *slot*: a numbered, reusable bundle of network resources.

```
       host root netns (vm-host runs here, hostNetwork: true)
       │
       │  veth-<slot>  10.<v>.<slot>.1/30    nftables table "fissionplane"
       │      │        + host route for the  ├─ forward: slot ↔ uplink
       │      │          slot address        │    drop @floor — one set, node-wide
       │      │                              └─ nat: masquerade slot → uplink
       ▼      ▼
   ┌─────────────────────────────────────────────────────────┐
   │  netns  sbx-<slot>                                      │
   │    eth0 (veth peer)   10.<v>.<slot>.2/30                │
   │      + slot address   10.<s>.<slot>/32                  │
   │                                                         │
   │    nftables table "fissionplane"                         │
   │      ├─ egress:  src 169.254.0.2  → slot address        │
   │      ├─ ingress: dst slot address → 169.254.0.2         │
   │      └─ policy:  @allow / @deny for this sandbox        │
   │                                                         │
   │    tap0               169.254.0.1/30  ◄── Firecracker attaches here
   │                                                         │
   │        guest: 169.254.0.2, gw 169.254.0.1               │
   └─────────────────────────────────────────────────────────┘
```

Three address ranges, each doing a different job:

| Range | Scope | Purpose |
|---|---|---|
| **Slot address** — one `/32` per slot | Node-wide | The sandbox's identity on the host side. Egress is translated to it *inside* the namespace; the root namespace holds a host route for it via the veth peer. |
| **Point-to-point pair** — one `/30` per slot | The veth link | Carries packets between the root namespace and the slot, and nothing else. |
| **Guest-facing block** — `169.254.0.0/30`, identical in every slot | Inside one namespace | `169.254.0.1` on `tap0`, `169.254.0.2` in the guest. |

**Address translation happens inside the namespace.** This is the part that makes return
traffic routable, and the earlier shape of this design — one identical guest address per slot
with translation only in the root namespace — could not deliver a reply. A packet arriving for
`169.254.0.2` matches as many candidate interfaces as there are slots, and carries nothing that
distinguishes them; the host cannot disambiguate on a connection-tracking entry either, because
the flow was tracked in the namespace rather than here. Translating on the way out fixes it by
making every flow unique before it leaves the slot: the root namespace only ever sees the slot
address, routes on it like any other host route, and its masquerade to the uplink is then an
ordinary translation of an already-unique source. The claim that all per-sandbox uniqueness
lives on the host side of the veth pair is true only once in-namespace translation exists to
create that uniqueness.

**The guest-facing block is identical in every sandbox**, and **both** ends of it are pinned —
the tap's address and MAC on the host side of the boundary, and the guest's own address and MAC
on the other — so the guest's routing table and ARP cache stay valid across a resume and it
never notices it moved.

The tap's MAC is the half most easily dropped, because nothing complains when it is missing.
Upstream's own recipe for restoring many clones from one snapshot pins the tap's *address* and
lets the kernel invent its MAC (`references/firecracker-docs/snapshotting/network-for-clones.md:56-60`),
and then has to flush the guest's neighbour table after every restore to compensate
(`references/firecracker-docs/snapshotting/network-for-clones.md:133-139`) — the same per-restore
guest step this design rejects for addressing, arrived at from the same corner. Doing neither is
what produces the interesting failure, and upstream states its shape: the guest keeps sending to
the link-layer address it cached before the pause, and connectivity does not return until the
entry ages out, after which it works in both directions with no intervention at all
(`references/firecracker-docs/snapshotting/network-for-clones.md:141-144`). A restore that is
dead for the neighbour timeout and then recovers on its own is the signature, and it is one that
gets attributed to the artifact store, the uplink, and the tenant's own code before anyone
suspects a MAC address. Pinning the tap's MAC makes the cached entry correct rather than stale,
and costs nothing on the path the pin protects.

The reason the block is identical is not that per-slot guest addressing is impossible. It is
possible, and upstream describes both halves of doing it: the VMM takes an override on the
restore call remapping a guest interface onto a different host tap
(`references/firecracker-docs/snapshotting/network-for-clones.md:146-177`), and the guest's own
configuration is then rewritten from inside, after being told over vsock or a comparable channel
that it must (`references/firecracker-docs/snapshotting/network-for-clones.md:180-201`) — which
is our post-restore hook. The argument against is latency and failure surface on the restore path.
Every resume would gain a guest round trip that must complete before the sandbox can serve
traffic, on the one path the whole system is optimised for, and a step that can fail — a guest
whose reconfiguration does not land is a sandbox that restored successfully and has no network,
which is a worse failure than one that did not restore.

The reason the design *has* to put each sandbox in its own namespace is different, and has
nothing to do with addressing: **the device-state file records the host tap by interface name**,
and a restore reattaches to a device of that name
(`references/firecracker-docs/snapshotting/versioning.md:104-108`). Every sandbox from one
template therefore wants the same host device name. Even with per-slot guest addressing solved,
the names collide the moment two of them run concurrently on a node, and the alternatives are
patching the device name on every restore — the same per-restore step, on the same path — or
giving each sandbox a namespace in which the name is unambiguous. Separate namespaces make the
collision disappear instead of managing it.

**So the tap is `tap0` in every slot on every node, and that name is a constant rather than a
construction.** Saying it outright matters, because "the names collide" is a premise a reader can
resolve in exactly the wrong direction: the obvious way to stop names colliding is to make them
unique, and a `tap-<slot>` would do it. It would also write the slot number into every snapshot
ever taken of that sandbox, since the name in the state file is whatever the capture saw. Such an
artifact restores only where that slot number happens to be free — one slot on one node, held by
an allocator with no idea it is being constrained — and placement cannot offer that, nor should it
be asked to. The per-sandbox distinction lives in the namespace, which no restore reopens. It must
not live in the name, which every restore does.

### Nothing a restore reopens may be named after node-local state

The tap is the most visible instance of a general rule, and the rule deserves stating in its own
right because its other instances live in other documents. A restore reopens the host resources
external to the snapshot by the strings the capture recorded, and there are exactly three of them
(`references/firecracker-docs/snapshotting/versioning.md:104-120`).

| Reopened by name | What has to be identical on every node | Where the per-sandbox distinction lives instead |
|---|---|---|
| The tap device, by interface name | `tap0` | The slot's network namespace, which the VMM is placed into at launch |
| The guest transport socket, by socket name | The socket name | The per-sandbox jail root |
| Each disk, by backing file path | The path as the jailed process sees it | The per-sandbox jail root |

Two of those rows are [vm-host](../components/vm-host.md)'s, which owns the jail and carries the
argument for it. What belongs here is the shape all three share: **the name is the constant and
the container is the variable.** None of the three is resolved globally. The tap name is resolved
in whatever network namespace the restoring process sits in, and the socket and disk paths are
resolved relative to that process rather than as absolute host paths
(`references/firecracker-docs/snapshotting/snapshot-support.md:456-461`) — which is exactly what
lets one recorded string mean a different resource per sandbox, and why the enclosing namespace
and jail are load-bearing rather than tidy.

Two properties of the failure make this a rule rather than a convention, and both defeat ordinary
testing. It is **invisible on the node that took the snapshot**, because that node still holds the
slot and the name still resolves; the artifact is wrong only somewhere else, later, which in
practice means in front of a tenant resuming work they expected to find. And a load that cannot
find what the state file names does not degrade into something inspectable: the error is reported
and the hypervisor process is then ended, on the grounds that it may be in an invalid state
(`references/firecracker-docs/snapshotting/snapshot-support.md:483-484`). There is no half-restored
sandbox to look at and nothing to retry in place. A naming mistake here turns a resume into a dead
VMM.

Slot-derived names remain correct for everything a restore does *not* reopen, which is most of the
names in this document: `sbx-<slot>` for the namespace, `veth-<slot>` for the host end of the
pair, the per-slot address sets. The rule is not "keep slot numbers out of names". It is that
those three strings are part of the artifact, and an artifact must carry no fact about the machine
that produced it.

### One tap, one thread, and the ceiling that follows

The tap is not only plumbing; it is the per-sandbox throughput limit, and that limit is more
rigid than a tap device usually implies. Firecracker offers only a TUN/TAP backend and **no
multi-queue support** (`references/firecracker-docs/network-setup.md:7-10`), so the whole of a
sandbox's network load is emulated by a single thread, which copies every outbound frame from the
emulated interface to the tap file descriptor (`references/firecracker-docs/design.md:88-90`).
Measurements scoped deliberately to that thread put it at 25 Gbps in one direction, 18 Gbps with
both running (`references/firecracker-docs/network-performance.md:5-14`), and about 0.06 ms added
to a round trip (`references/firecracker-docs/network-performance.md:38-39`). Those are
per-sandbox numbers rather than a share of the node, and no host tuning moves them: the answer
for a sandbox that needs more is a different architecture, not a bigger machine.

Our topology sits below that ceiling rather than at it. Namespaced translation is the slowest of
the three routing arrangements upstream documents, and it is recommended anyway for exactly our
case — two clones of one microVM running at the same time
(`references/firecracker-docs/network-setup.md:21-32`). The cost is accepted rather than
unnoticed, and it belongs on the record beside the density targets. That same copy from the
emulated interface to the tap is also where the hypervisor applies its per-device rate limiter
(`references/firecracker-docs/design.md:88-90`), so a sandbox's configured cap and its emulation
ceiling are imposed at one point by one thread; [vm-host](../components/vm-host.md) owns the
values and re-applies them on every restore.

## Slot allocation

Slots are **node-local state**. `vm-host` owns a pool, allocates on create, and returns on
destroy after a short delay that lets in-flight connections drain. There is no external
coordinator: nothing outside the node needs to know which slot a sandbox occupies, so
introducing a distributed lock service would add a dependency and a failure mode for no gain.

Slot construction is the expensive part of sandbox creation, so the pool is pre-populated and
slots are reused rather than rebuilt. Reuse requires a scrub — flush the slot's connection
tracking, empty the per-slot policy sets, verify no stale routes — because a reused slot must not
inherit anything from its previous occupant, and both of those first two carry an isolation
property rather than a tidiness one. The connection-tracking half of that scrub is
harder than it reads, and involves a second table in a second namespace, so it is treated
separately [below](#connection-tracking-happens-in-two-namespaces-and-only-one-of-them-is-obvious).

### Startup reclaim is the most dangerous operation in the daemon

On startup, `vm-host` reclaims slots left behind by a previous instance. The naive
implementation — enumerate the named namespaces, match them against the lease file, destroy
anything unaccounted for — **deletes other pods' networking across the whole node.** The
directory of named network namespaces is shared: the cluster network plugin and the container
runtime put entries there for workloads that have nothing to do with us. An unaccounted-for
namespace is overwhelmingly likely to be somebody else's pod, not our leak, and destroying it
severs that pod from the network with no error anywhere near the cause. The symptom is a
cluster-wide network outage that appears to originate in our node pool, which is exactly the
failure the whole coexistence design exists to prevent.

Two constraints therefore gate every deletion, and **both must hold**:

1. **A name prefix we own.** Only names matching the `sbx-<slot>` scheme are candidates. On a
   dedicated host that would be sufficient. Here it is nowhere near it, because the directory is
   shared and nothing stops another component from choosing a colliding name.
2. **Positive proof we created it.** A namespace we built carries evidence: a lease entry naming
   that slot, and our own nftables table inside the namespace. Absence of proof is not proof of
   abandonment. This is the constraint that makes prefix matching safe, and it is the one that
   cannot be traded away — prefix matching alone is fine on a machine we own outright and
   catastrophic on a node where the network plugin writes the same directory.

A namespace that fails either is logged and left alone. The asymmetry is the whole point: leaking
a namespace costs a slot and a little memory until the node is drained, and deleting a foreign one
is an outage for unrelated workloads. Reclaim never deletes a namespace it cannot prove it
created.

### The ordering is the mechanism

There is a third protection — a **foreign set**, the names present that are not ours, held for the
life of the process so that nothing created later can be mistaken for a leak — and where it sits
in the startup sequence decides whether reclaim works at all. It is captured **after** reclaim
runs, not before.

Capturing it first is the intuitive order and it is a defect, not a conservatism. Every namespace
reclaim exists to delete is, by definition, present on the node at the moment the daemon starts:
that is what makes it a leak. A foreign set snapshotted before the first slot is created therefore
contains all of them, marks all of them permanently foreign, and reduces reclaim to a guaranteed
no-op that logs success while the slot pool shrinks by whatever the previous instance left behind.
The node degrades one restart at a time and every startup reports itself clean.

So the sequence is fixed, and it is an ordering rather than a set of independent conditions:

| Order | Step | Why here |
|---|---|---|
| 1 | Deal with the previous instance's hypervisors: adopt the live ones, kill the rest | Reclaiming a slot out from under a running VM removes the guest's network with no error near the cause. `vm-host` reclaims by resource type, and the process group goes first for this reason. |
| 2 | Reclaim, against the **adopted** set | The daemon re-adopts surviving sandboxes rather than killing them, so reclaim never runs against an empty node. A namespace belonging to an adopted sandbox satisfies both constraints above and is nonetheless in use, so reclaim is scoped to leases with no live sandbox behind them rather than to everything it could prove it created. |
| 3 | Capture the foreign set | Everything still present that is not ours is now genuinely somebody else's, because our own leftovers are gone. |
| 4 | Begin creating slots | Every name from here on is one we created during this lifetime. |

Step 2 is where the two constraints apply. Step 3 is what protects the rest of the process
lifetime, and it can only mean what it is supposed to mean once step 2 has finished.

The named namespace is deleted **last** during teardown, so a partially torn-down slot remains
discoverable — and provably ours — rather than leaking silently.

## Egress

**This is not default deny, and calling it that hides the risk.** Permitting outbound traffic to
the internet minus a list of private ranges is default *allow* with a deny list, and a deny list
is a record of what somebody remembered. The policy is what the product needs — a sandbox that
cannot install a package is not useful — but it must be described accurately, because the
mitigations for a deny list (enumerate it explicitly, review it per cloud, test it) are not the
mitigations for a default deny.

Policy has **two layers**, with different owners, different lifetimes, and — this is the part
that carries the isolation property — different namespaces.

**The floor** is node configuration. It is the deny list enumerated below, it is identical for
every sandbox on every node in the pool, and it exists to keep hostile code away from the node,
the cluster, and the cloud's own control surfaces. It also denies the sandbox range itself, so
root-namespace forwarding cannot become a path from one slot to another. No tenant setting
reaches it.

There is nothing underneath it. The hypervisor performs no traffic filtering of its own and says
so plainly — packets are forwarded from the guest's virtual interface to the tap unexamined, all
guest egress is to be treated as untrusted, and filtering is the host's job
(`references/firecracker-docs/design.md:93-95`,
`references/firecracker-docs/prod-host-setup.md:227-231`). Worth stating once, because a reader
who assumes the hypervisor filters *something* will read the rest of this section as defence in
depth when it is the only depth there is.

**The sandbox's own allow and deny lists** are per sandbox, fixed at create, carried on the
sandbox row and delivered to the node **as part of the create call** rather than read from node
configuration. They are installed as named sets in that sandbox's own namespace and live exactly
as long as the occupancy. [control-plane](../components/control-plane.md) carries the argument for
scoping them to the sandbox rather than the organisation; what matters here is that the node
receives them with the sandbox, so changing a tenant's policy is a property of the next create and
never a node reconfiguration.

Within the floor, each slot's namespace permits:

- DNS to the resolver `vm-host` designates, never the cluster's internal resolver, so sandboxes
  cannot enumerate cluster services.
- Outbound TCP and UDP to everything the floor and that sandbox's own lists both allow.
- Established and related return traffic, which is also what admits the ICMP messages path
  discovery depends on.

### A sandbox list can only narrow the floor, and cannot express widening it

This has to be true, because a tenant-supplied allow list that could widen the floor is a
supported way to reach the metadata endpoint. It is true structurally rather than by enforcement,
and the difference is the whole reason the two layers sit where they do.

A packet leaving a sandbox is evaluated **twice**: once in the slot namespace, where that
sandbox's own sets are, and again in the root namespace on the forward path, where the floor is.
It has to be accepted by both, so the effective policy is the intersection of the two. There is no
ordering in which an accept in the slot's table reaches around a drop in the root's, because they
are separate rulesets in separate namespaces on opposite sides of the veth and the first has to
forward the packet before the second ever sees it. Narrowing is the only thing a per-slot set can
do to the result; widening is not a mistake it is capable of making.

The alternative — copy the floor into each slot and merge the sandbox's list with it there — turns
that property into a claim about a merge function that runs once per create, on tenant input, on
the privileged side of the boundary. A bug in it is not a policy error but an isolation failure,
and it is the specific isolation failure the floor exists to prevent. Keeping the floor in the
other namespace means there is no merge to get wrong.

The lists are still validated at admission, because a list naming a floor-denied range should be
refused with an error rather than silently having no effect. That is a usability property. The
intersection is the security property, and the two must not be mistaken for each other.

One exception is written into the floor and cannot be written into a slot: the address of the
resolver `vm-host` designates, which may itself sit inside a range the floor otherwise denies. It
is a node-level entry for the same reason the floor is — a slot able to nominate its own resolver
address is a slot able to name any address and call it one.

### The sets, and which are per-node

The split matters at the level of individual nftables sets, because it is what makes the previous
section a structural claim rather than a convention.

| Set | Scope | Lifetime | Contents |
|---|---|---|---|
| Floor deny | **One per node**, in the root-namespace table | Node configuration, reloaded when it changes | The ranges below, the provider metadata endpoints, and the sandbox range |
| Resolver exception | **One per node**, root namespace | Node configuration | The designated resolver's address, and nothing a sandbox supplied |
| Sandbox allow | **One per slot**, in that slot's own table | The occupancy | Delivered with the create call. Empty means everything the floor permits |
| Sandbox deny | **One per slot**, in that slot's own table | The occupancy | Delivered with the create call |

Two things follow. Named sets are populated at slot construction without rebuilding the ruleset,
and the per-slot ones are not updated afterwards, because the lists are fixed at create and a
policy that can be widened while the occupant is running is not a constraint on the occupant. And
the per-slot sets are **emptied by the scrub before a slot is reused**, which is now an isolation
step rather than housekeeping: an allow set surviving into the next occupancy hands one tenant's
exemptions to another.

The floor is the security-relevant layer, and the obvious version of it — pod CIDR, service
CIDR, node subnet, link-local, metadata — omits enough to be worth enumerating in full:

| Range | Why the short list forgets it |
|---|---|
| All of IPv6 | An IPv4 deny list is not a policy for a dual-stack node. Addressed by disabling IPv6 in the namespace outright, below; if that ever changes, the list must be built for IPv6 *first*. |
| `100.64.0.0/10` | Carrier-grade translation space. Not private by the usual reflex, and used by cloud providers for node-adjacent services. |
| `0.0.0.0/8` | The reserved zero network, treated as local by some stacks and as a wildcard by others. Never a legitimate egress destination, and never something to let a hostile guest experiment with. |
| `127.0.0.0/8` | Loopback, which everyone assumes cannot be forwarded off a host. It mostly cannot, but that is a property of kernel settings other software on the node is entitled to change — `route_localnet` being the obvious one — rather than a property of the packet. A forwarded packet with a loopback destination is never legitimate egress, so denying it costs nothing and removes the dependency on an assumption we do not control. |
| `224.0.0.0/4`, `255.255.255.255` | Multicast and broadcast. Discovery and neighbour protocols, not unicast egress. |
| `169.254.0.0/16` | The node's own link-local range, of which the metadata address is one member. Denied on the forward path; the guest's own gateway inside the slot is unaffected, because traffic to `169.254.0.1` is delivered locally in the namespace rather than forwarded. |
| Provider metadata endpoints | `169.254.169.254` and its per-provider variants — including the credential endpoints that are not on that address — get their own explicit rule rather than relying on the link-local entry, so the intent survives someone narrowing that entry. |

A tenant that wants genuine default deny gets it one sandbox at a time, by supplying an allow list
on the create call; the platform default is not it, and no organisation-wide setting makes it so.

### Deferring hostname policy has a retrofit cost

Hostname-based policy requires inspecting the TLS server name and is deferred; CIDR-level policy
is what ships first. That is the right order, but the cost of retrofitting is worth recording
now, because both available mechanisms are structural rather than incremental.

Transparent interception — redirecting outbound connections to a userspace proxy — moves *every*
outbound byte through a process we operate, which adds a latency hop and a failure domain to
traffic that currently touches only the kernel, and forces a position on certificate handling for
clients that pin. Passive inspection avoids the proxy. The objection usually raised against it —
that it hangs on server-first protocols, the engine waiting for a client hello that a database,
mail, or shell protocol will not send until the server has spoken — is avoidable rather than
fatal. Inspection is selected **by destination port**, so only ports on which the client speaks
first are inspected and everything else falls through to address-level policy. A reference
implementation does exactly this, and says so in a comment at the selection point. Neither
mechanism is a rule change; both are new components on the egress path.

### The seam is already occupied, which is the argument for reserving it

Deferring the policy does not mean deferring the shape. **Slot create and teardown call a narrow
egress-policy hook**, and hostname-level policy attaches at those two points when it arrives
rather than needing new ones. The hook is not hypothetical: what it does today is install and
remove the per-sandbox address sets described above, which arrived on the create call after this
seam was written down and needed nothing new to land.

The cost avoided is not the hook; it is where the hook has to go. Slot construction is touched by
four paths — create, teardown, reclaim, and the scrub that precedes reuse — and a policy that
attaches to a slot has to be installed, removed, and proven absent in all four, consistently, or a
slot carries one tenant's policy into another tenant's occupancy. Those are the four places in
this document where a mistake is an isolation failure rather than a bug, and they are much easier
to get right while they are being written than while a node daemon is in production and every edit
to them is a change to live sandbox networking.

### Egress attribution is a known gap

Every sandbox on a node translates behind the same node address. To any third party, the node is
one client, so one abusive tenant gets the node's address rate-limited or blocklisted and every
other sandbox on that node inherits the consequence — including sandboxes created after the
abuser is gone, for as long as the blocklisting lasts. There is no per-sandbox source address and
therefore no attribution story: an abuse report naming our address identifies a machine, not a
tenant.

This is an accepted limitation for v1, not an oversight, and it comes with one thing we do owe
ourselves: **flow records keyed by slot**, logged from the namespace where the slot is still
unambiguous, so a report carrying a timestamp and a destination can be attributed after the fact
even though it cannot be attributed live. The fix, when it is worth its cost, is a pool of egress
addresses per node assigned per organisation, or an egress tier that owns the addresses; both are
deferred, and both are much easier to add once flow records exist.

### Per-namespace settings the ruleset depends on

A network namespace is not just a container for interfaces; it carries its own copy of most of
the network stack's configuration, and three of those settings decide whether the ruleset above
works at all. All three are set explicitly during slot construction rather than inherited,
because inheritance is where the silent failures live.

**Address forwarding.** IPv4 forwarding is copied from the creating namespace at the moment the
namespace is created, while the IPv6 equivalent resets to its compiled default. Egress therefore
depends on what the host's setting happened to be at the instant each slot was built — a node
where anything toggles that value produces working slots and broken slots that differ only by
creation time, which is close to undiagnosable from inside a single sandbox. Both values are set
explicitly, per namespace, after creation.

**IPv6 is disabled in sandbox namespaces.** This is a decision, not an omission. The deny list
above does not exist for IPv6, and shipping an address family with no egress policy is worse than
not shipping it; disabling it in the namespace removes the family from the node-facing path
entirely. The relay's need for `[::1]` is unaffected, because that loopback is inside the guest
and never crosses the tap. The cost is real and should be stated to tenants: an IPv6-only
destination is unreachable from a sandbox. Enabling IPv6 later is gated on building the deny list
for it, not on flipping the sysctl.

**Reverse-path filtering.** Strict reverse-path filtering interacts badly with in-namespace
translation and asymmetric paths, and the kernel takes the *maximum* of the global and
per-interface values rather than letting the more specific one win. Inside our namespace we own
both. In the root namespace we do not: the host end of every veth sits there, and another
component setting a strict global value silently raises it for our interfaces, with no way to
lower it per interface. We set our own values explicitly, and treat the root-namespace global as
an environmental precondition to check at startup and re-check per network plugin.

### Connection tracking happens in two namespaces, and only one of them is obvious

A sandbox's flows are tracked **twice**: once in the slot namespace, where the guest's packets are
first seen and translated to the slot address, and again in the root namespace, where the
masquerade to the uplink happens. The two tables are separate objects with separate contents, and
a scrub that addresses one of them leaves the other populated.

**The in-namespace table is the isolation problem.** Connection-tracking state lives in the
namespace, so there is no host-side operation that flushes a slot's entries: flushing from the
root namespace flushes the root namespace's table and nothing else. The scrub has to *enter* the
namespace and flush there, and the flush has to be verified rather than assumed. Getting it wrong
is an isolation failure, not an inefficiency. Because the guest address is identical in every
slot, an established entry left behind by the previous occupant describes a flow whose
in-namespace addressing is indistinguishable from the next occupant's traffic, and the default
established timeout is five days — so the window is not a race, it is effectively the whole life
of the slot. A packet belonging to one tenant's connection matching state created by another's
directly contradicts the property slot reuse is required to preserve.

**The root-namespace entries are a correctness problem and a capacity problem, not an isolation
one.** They are keyed by the slot address, which is unique per slot, so no other sandbox's traffic
can match them. But a reused slot keeps that address, and its new occupant can reuse a source
port; a stale entry for the same address, port, and destination then collides with a genuinely new
flow, whose translation is either refused or bound differently from what the namespace side
expects. These entries are also the ones that consume the **shared global hash table** the node
preparation sizing exists for, so leaving them to expire on their own is what makes a busy node's
table fill with flows belonging to sandboxes that no longer exist. They are flushed from the root
namespace, filtered by the slot address, at the same point the in-namespace flush runs.

The same split catches something teardown currently forgets: the veth peer leaves a **neighbour
entry in the root namespace**, and nothing removes it. Node preparation already budgets for these
by raising the neighbour-table thresholds, which is the right precaution and is not a substitute
for deleting the entry — a budget for entries that are never removed is a slower leak, not a
bounded one. The entry is deleted with the rest of the host-side state keyed to the slot, alongside
the forward and translation rules that also live outside the namespace.

Two rules follow. The scrub covers both tables and confirms each before the slot returns to the
pool, and **a slot whose scrub cannot be confirmed is destroyed rather than reused** — rebuilding a
slot costs create latency, and reusing a dirty one costs the isolation claim this whole document
rests on.

## Public port exposure

### Hostname scheme

```
https://<port>-<sandbox-id>.<sandbox-domain>
```

The port is encoded **in the same DNS label** as the sandbox ID, not as a deeper subdomain.
This is forced by wildcard certificates and wildcard host rules, which match exactly one
label: `*.sandboxes.example.com` matches `3000-abc123.sandboxes.example.com` but never
`3000.abc123.sandboxes.example.com`.

Two properties of the scheme are decided in
[gateway](../components/gateway.md) and are worth knowing before designing
anything against it. The sandbox identifier is a 24-character
lowercase-alphanumeric NanoID whose alphabet **excludes the hyphen**, so a
well-formed label carries exactly one and a third field can be added later
without reinterpreting hostnames already issued. And browser access depends on the hostname being
per-sandbox, because the session cookie is scoped to it: a shared hostname that names the target
sandbox in a header instead — the usual accommodation for clients that cannot arrange per-sandbox
DNS — is a token-only surface, and carries no cookie.

### Path into the guest

`gateway` terminates TLS, parses the hostname, and reads the active exposure policy. A port with
no record is private and requires a capability token or scoped cookie. A port explicitly marked
`public` admits anonymous traffic. The configured sandbox agent port is reserved and can never
have an exposure record.

The request then crosses to `vm-host` over a mutually authenticated hop. For private traffic the
credential travels with the request: `gateway` verifies it as a filter, `vm-host` verifies again
— signature, expiry, sandbox, epoch, scope — and strips it before anything reaches the guest.
Public traffic requires no client credential; `gateway` removes any platform credential supplied
anyway, and `vm-host` authoritatively checks the versioned exposure state from `control-plane`.
Having authorized either branch, it looks the sandbox up in its local table and connects to the
guest.

The shape is deliberate: user application ingress is distinct from the in-guest management API
and node-side policy is authoritative. Public access is default-off and per-port, never
default-on and sandbox-wide.

Because `vm-host` terminates every one of those connections, it is also where two per-sandbox
quantities are known exactly rather than estimated. The **concurrent-connection cap** is enforced
there, keyed by sandbox identifier and epoch and released when the slot is released; and
**last-traffic time and open-stream count** are reported upward, so a sandbox carrying a live PTY
session is not paused underneath its tenant for looking idle.

The last hop is a **relay inside `vm-steward`**, not a per-port helper process on the host or
in the guest. When traffic arrives for port 3000, `vm-steward` simply connects to
`127.0.0.1:3000` (or `[::1]:3000`) from inside the guest and copies bytes bidirectionally.

That choice deserves justification, because the obvious alternative — a rule redirecting external
traffic to the guest's loopback — does not work, and the reason it does not work is not the one
usually given first.

**The guest's loopback is inside the guest.** No rule in a host namespace can name it, so the
redirection would have to be installed in the guest's own kernel: a kernel in which the tenant is
root, and can flush the ruleset, delete the rule, or unload the module that implements it, at
which point their own published port stops working in a way we get paged for. A security control
the adversary administers is not a control. It also depends on address translation being compiled
into the guest kernel at all, which minimal guest kernel configurations commonly omit — and the
guest kernel is one we want to keep minimal, since every option enabled for our benefit is also
enabled for the occupant's.

Two further objections stand behind that one. A rule matching an IPv4 destination cannot redirect
to `::1`, because netfilter does not translate between address families, so services bound only
to IPv6 loopback are unreachable by construction. And redirection to `127.0.0.1` requires
enabling `route_localnet`, which loosens what the kernel accepts as a routable destination for
reasons unrelated to our use case.

Spawning a userspace forwarder per port avoids the address-family problem but costs a process per
published port and a loop to discover them. An in-agent relay costs neither: ports are used on
demand, and a connection attempt that fails returns an error to the caller instead of requiring
anything to have been provisioned in advance.

### The relay is visible to the tenant application

Relayed connections reach the tenant's server *from loopback*, and several things inside that
server will believe it.

- **Client addresses.** Everything the application can see says `127.0.0.1`. The
  **forwarded-client-address** header set by `gateway`, alongside the forwarded-host header
  carrying the name the client asked for, is the only record of the real client, so anything that
  logs, geolocates, or rate-limits by peer address must read it — and must be told to trust it,
  which is safe here only because the guest cannot receive external traffic by any other path and
  because `gateway` replaces any inbound copy rather than appending to it. The rest of that header
  family is deliberately not set; see [gateway](../components/gateway.md).
- **Address-based authorisation.** Frameworks that grant unauthenticated access to loopback
  callers — development servers, debug consoles, admin endpoints bound "safely" to `127.0.0.1` —
  extend that trust to the internet the moment the port is published. This is worth stating in
  tenant-facing documentation, not just here.
- **Bind address.** The relay dials loopback, so a server bound only to a specific non-loopback
  address is unreachable even though it is listening. Binding `0.0.0.0` or loopback works;
  anything else needs the relay to try the guest's own address as a fallback, at the cost of a
  failed connect on every attempt.

### Enumerating ports still needs a timer

`vm-steward` enumerates listening sockets over netlink rather than by scraping `/proc`, which is
cheaper, but it does not change the shape of the problem: the netlink diagnostic interface is a
**dump** interface. It answers the question "what is listening now"; the kernel sends no
notification when a socket begins listening. Genuinely event-driven discovery would require a
probe attached in the guest kernel to the listen path, which means a BPF or kprobe dependency
inside the sealed guest surface for a feature that is not worth it. Enumeration therefore polls.

The product consequence is the part that matters, because the on-demand relay hides it. Tenants
want an *event* when a port opens — that is what turns "my server started" into a URL appearing
in a UI — and on-demand relaying provides no such event, since nothing observes the listen; the
first evidence a port exists is a connection to it succeeding. The enumeration timer is therefore
not an optimisation over `/proc` scraping that we might one day remove. It is the only source of
that event, and its interval is the latency of the feature.

### No per-sandbox Kubernetes objects

Sandboxes never become Ingress, HTTPRoute, or Service objects. Ingress controllers typically
rebuild and reload their configuration when Ingress objects are created, and at our churn rate
that would keep the cluster's shared ingress in a permanent reload loop. Every such object is
also an etcd write whose revision is retained until compaction, and a watch event delivered to
every controller replica in the cluster — costs borne by workloads that have nothing to do
with us. `gateway` therefore does its own host parsing against routing state in our datastore.

Streaming passes through cleanly because we own the proxy: WebSocket upgrades, HTTP/2, and
long-lived byte streams for PTY sessions are all first-class. Application-level keepalives are
mandatory regardless, because cloud load balancers enforce their own idle timeouts.

## Host-to-guest transport

`vm-host` reaches `vm-steward` over **virtio-vsock**, not over the sandbox network. `vm-steward`
listens on a vsock port; `vm-host` connects through the Firecracker-provided unix socket.

The benefit is that the control channel does not exist on any network the tenant can route to,
so no listening TCP port inside the guest serves the management API.

Two properties are non-negotiable consequences of using vsock with snapshots:

- **Snapshot severs connections.** Taking or restoring a snapshot resets the vsock device;
  open connections do not survive, though the listening socket does. The protocol is therefore
  designed around reconnection: after every restore, `vm-host` reconnects and performs a
  handshake carrying a fresh **epoch**. Operations from a previous epoch are rejected.
- **A guest process can also reach a guest-local vsock listener.** vsock is not, by itself, an
  authentication mechanism. This does not matter, for reasons developed in
  [security](security.md): the occupant already has root in the guest and can do anything
  `vm-steward` can do. What follows is not that the channel needs a secret, but that `vm-host`
  must treat everything arriving on it as hostile input.

### There is no metadata service, for as long as the device stays off

The service is off — it is disabled by default and unreachable from the guest until a network
interface is explicitly configured to carry it
(`references/firecracker-docs/mmds/mmds-user-guide.md:9-13`,
`references/firecracker-docs/mmds/mmds-design.md:79-83`) — and the first reason to keep it that
way has nothing to do with metadata. Enabling it instantiates a purpose-built HTTP, TCP and IPv4
stack **inside the hypervisor process and outside the KVM boundary**
(`references/firecracker-docs/mmds/mmds-design.md:3-8`), on the same thread that emulates the
network, block and vsock devices (`references/firecracker-docs/design.md:71-79`), and splices it
into the data path in both directions: every frame the guest sends is examined by that stack
before it is written to the tap, and the device model asks it for traffic before it hands the
guest anything (`references/firecracker-docs/mmds/mmds-design.md:84-89,147-155`). The stack is
deliberately minimal — no congestion control, most TCP options and features unsupported, a
greatly simplified HTTP 1.1 server (`references/firecracker-docs/mmds/mmds-design.md:91-102`), no
VLAN tags and no IP reassembly (`references/firecracker-docs/mmds/mmds-design.md:140-145`). Those
are sound simplifications for the job it was built for and poor properties in a parser whose
input is chosen by hostile code.

That is the objection this document already raises against
[a host-side listener](#no-host-side-service-is-reachable-from-the-guest), with the parser moved
somewhere strictly worse. A listener would be a process in the host's namespace; this is a parser
in the address space that owns the guest's memory and its vCPUs. Every sandbox on the node would
pay for it on every packet, whether or not it ever asked for metadata.

Enabling it is further from a flag than it looks, which is a point in our favour and worth
recording accurately rather than overstating. The service is configurable **pre-boot only**
(`references/firecracker-docs/mmds/mmds-user-guide.md:55-56`) and its configuration is carried
across snapshot and restore (`references/firecracker-docs/mmds/mmds-user-guide.md:296-297`), so a
template built without it cannot acquire it at create or at resume: turning it on is a template
rebuild, on the same footing as changing the sealed agent. The data store itself is deliberately
*not* carried across a snapshot, and upstream's reason is precisely ours — so that one microVM's
contents do not leak into the clones restored from it
(`references/firecracker-docs/mmds/mmds-user-guide.md:291-294`). Every restore would therefore
need the host to seed the store before the guest asked, with a request that arrived first
answered `NotFound` (`references/firecracker-docs/mmds/mmds-user-guide.md:435-439`). That is a
host round trip racing tenant code on the one path the whole system is optimised for, which is
the trade this document refuses a few sections above for guest addressing.

The routing objection stands behind those, and it is the one that survives the device being
switched on anyway: the guest is root of its own view of the service. It controls its routing
table and can shadow the route from inside, either to answer its own processes with forged
responses or to send metadata requests past the device toward the node's provider endpoint
instead. Upstream reaches the same place from the other side, and its wording is close to a
warning: operators are told **not** to rely on the metadata stack to filter guest packets
addressed to it, and to put host-level firewall rules in place instead
(`references/firecracker-docs/mmds/mmds-design.md:158-167`,
`references/firecracker-docs/prod-host-setup.md:225-251`).

Two rules, and the second is the one that survives the first being changed. The device stays off.
And the floor carries an **explicit entry dropping guest traffic to the provider metadata
address**, independent of the link-local range beside it and independent of the device's state, so
the guarantee is enforced by the host rather than implied by a setting. It is in the floor rather
than in a slot for the reason the floor exists: no sandbox's own list can reach it.

The position is worth keeping because the alternative has been tried and its cost is on record. A
reference implementation enables the device, and its in-guest agent carries a self-heal loop that
re-pins a firewall rule at position one whenever the tenant's own rules push it down. That is the
platform losing a rule-priority fight to its own tenant, on a loop, inside a kernel the tenant
administers — and it is what the design necessarily reduces to once the control that matters lives
somewhere the occupant is root. Enforcing it from outside the guest is not a stricter version of
that arrangement; it is the only version that is a control.

### No host-side service is reachable from the guest

The guest has a gateway and there is nothing behind it. No resolver, no log receiver, no agent
endpoint, no health check: the tap address terminates no service at all, and the control channel
is the only guest-to-platform path that exists.

On the control channel the outward direction is closed too, and structurally rather than by
policy. A vsock connection opened by the guest is forwarded only to a host unix socket whose path
is the configured one suffixed with the destination port, and where no such socket exists the
device answers the guest with a reset
(`references/firecracker-docs/vsock.md:79-88`). The only socket we create is the one the host
dials in on; the per-port files a guest-initiated connection would be forwarded to are never
created, on any node, for any port. There is no rule to review here and nothing to get wrong at
create time — the absence of a file is the whole mechanism.

This is a deliberate exclusion and worth naming, because it is the seam every future feature
grows on. Log shipping wants a collector to send to. Name resolution wants a resolver close enough
to apply per-sandbox policy. Certificate distribution wants an endpoint to fetch from.

The reason to refuse them is cost, and it is worth being precise about that, because the reason
usually given is that such a service could not authenticate its caller — and **that reason is
false**, refuted by this document's own design. Address translation inside the namespace gives
every slot a source address that is unique per sandbox and that the guest cannot forge, since the
translation happens after the packet leaves the guest and in a namespace the occupant has no
access to. That is a host-attested sandbox identity, and it is the same identity the flow records
above are keyed by. A reference implementation authenticates a host-side endpoint by exactly this
means. Anyone arguing for a listener will notice, and they will be right.

What is true is that a listener costs three things we are not buying. It puts a process in the
host's namespace parsing bytes chosen by hostile code, on the machine where a parser bug is a node
compromise. It adds a per-node dependency to the create path, so a sandbox cannot start unless
that service is up. And it creates a **second guest-to-platform channel**, which then has to be
versioned, capability-negotiated, and reasoned about alongside the control channel for as long as
both exist — the sealed surface is deliberately small, and doubling the number of surfaces is not
a small change to it.

Stating it this way matters more than it looks. The unauthenticated-caller argument is the one
that loses the first serious debate, and whoever wins that debate will build the listener with an
in-guest bearer token, which genuinely is forgeable, because the occupant is root and can read it.
The cost argument survives the rebuttal; the capability argument hands the other side a design.

Anything that has to cross the boundary crosses it over the control channel, where the host dials,
the protocol is small and versioned, and the guest cannot initiate. A request for a host-side
listener is a request for a new capability in that protocol.

## Control-plane connectivity

`control-plane` dials `vm-host`, discovering nodes through a Kubernetes pod informer over the
`vm-host` DaemonSet's label selector, keyed by **node name** and dialling the pod's host IP.
Because `vm-host` runs with `hostNetwork`, pod IP and host IP are the same address, reachable
from anywhere in the cluster without involving kube-proxy.

A ClusterIP Service would be actively wrong here. gRPC multiplexes many calls over one HTTP/2
connection, so a Service in front of a DaemonSet pins a client to a single arbitrary node — but
a sandbox lives on exactly one specific node.

Node name is the correct key rather than pod name, because it survives pod recreation on the
same node, which is what "the sandbox is on that machine" actually means.

## Coexisting with the cluster CNI

This is the highest-risk integration point in the system, and **nothing in the prior art this
design draws on validates it.** Neither implementation we have taken lessons from runs on
Kubernetes: one schedules its VMs with a different orchestrator, the other runs them behind a
container daemon on hosts it owns outright. In both cases the machine has exactly one writer of
firewall rules and one owner of the named-namespace directory, which is the assumption every
mechanism in this section exists to survive not having. Everything below is reasoned from the
kernel's behaviour rather than from a system observed working, and it must be validated against
each CNI before rollout.

| Risk | Mitigation |
|---|---|
| Our rules are flushed or overwritten by the CNI's | All rules live in a dedicated nftables table with a unique name. Never append to shared chains. |
| The CNI's rules drop our traffic | Not solved by a dedicated table. See below: explicit base-chain priority in the root namespace, and per-plugin exemption. |
| Startup reclaim destroying foreign namespaces | Proof of creation before deletion, and reclaim ordered before the foreign set is captured; never delete what we cannot prove we created. |
| Address collisions with pod or service networks | All three sandbox ranges are configurable and validated at startup against the node's routes; `vm-host` refuses to start on overlap. |
| Connection-tracking table exhaustion | `nf_conntrack_max` and the bucket count raised together in node preparation, and monitored; the hash table is shared with everything else on the node. |
| Neighbour-table overflow from many veths | `gc_thresh1/2/3` raised from their defaults of 128/512/1024 to 4096/8192/16384 in node preparation, and the entry deleted at teardown rather than left to garbage collection. Each slot contributes a veth end in the root namespace. |
| A globally strict reverse-path filter breaking our return path | Detected at startup; the root-namespace global is not ours to set and the kernel takes the maximum. |
| MTU mismatch causing silent path failures | Derived, clamped, and re-derived if the path ever changes. See below. |

### A dedicated table gives isolation, not precedence

The dedicated table is doing less work than it looks. It guarantees that another writer's flush
does not take our rules with it, which is real. It does **not** give our verdicts precedence,
because netfilter does not work that way: every base chain registered at a hook is evaluated in
priority order, and an `accept` verdict terminates only the chain that issued it, not the hook.
Another plugin's base chain at the same hook runs afterwards and can still drop sandbox transit
traffic that we have already accepted.

The asymmetry is worth internalising, because it decides which half of our policy is robust. A
`drop` **is** terminal across the hook, so our deny list cannot be overridden by anyone else's
accept: the isolation direction holds. Connectivity does not — reachability is a negotiation with
whatever else is registered on the node.

### Base-chain priority is one number meaning two different things

The priority value is specified once in the code and it is worth separating the two cases it
covers, because they are not the same decision and only one of them is load-bearing.

**Inside a slot namespace it is arbitrary.** Nothing else registers a base chain there. The
namespace is created by us, is torn down by us, and holds exactly one table; whatever priority we
choose, our chains are the only ones at the hook. The value is set explicitly rather than
defaulted, for legibility and so that the two cases read the same in the source, but nothing
depends on it and no other component can contend with it.

**In the root namespace it is the entire question.** Every base chain registered at a hook is
evaluated in priority order and an `accept` terminates only its own chain, so the position of our
chain relative to the network plugin's and the service proxy's decides whether our verdicts are
reached before theirs. Our base chains there register at an explicit priority of **10 below the
conventional filter priority**, ahead of where plugins and the service proxy conventionally sit,
chosen for the direction priority can actually secure: our drops are evaluated and terminal before
anything else sees the packet, and our counters attribute the traffic.

For the other direction, sandbox transit is marked, and a plugin that drops unmatched forwarded
traffic — a common default for policy engines — must be configured to exempt that mark. That
exemption is not something we can assert from our side of the ruleset, and it is not a one-time
validation item either.

**The exemption is a standing compatibility matrix of plugin and version**, owned by someone and
re-run, on the same footing as the supported Kubernetes versions. The closest analogue available
is a product that has to coexist with a single other firewall writer, and even that reduced case
requires inserting rules at a position computed relative to the other product's terminal rule, and
tracking that the chain hosting them is renamed between the other product's versions. That is one
counterparty. A cluster has as many as the operator has installed, each with its own release
cadence, and a plugin upgrade that moves a chain or changes a default is a silent loss of sandbox
connectivity — or, in the direction priority does not protect, a silent loss of the exemption. The
matrix records which plugin at which version was validated, by whom, and when, and a combination
absent from it is unvalidated rather than presumed working.

### The tooling split on the node

Nodes carry two firewall interfaces that share the kernel's hooks and cannot read each other's
rules. Rules written through the modern backend are visible in one ruleset; rules written through
the legacy interface register separately, are evaluated by hook priority alongside ours, and are
invisible to the tooling we use. A node with both populated cannot have its effective policy read
from any single tool, and the failure that produces — an unseeable rule dropping our traffic — is
diagnosed by packet capture, which is an expensive way to find a configuration problem.

The position: we write nftables directly and never through the legacy interface. `vm-host`
inspects both at startup and reports a node condition when legacy tables are populated. It does
not refuse readiness, because the plugin's choice of backend is not ours to veto and refusing
would make the daemon unschedulable on an otherwise functional cluster — but a node in that state
is outside the configuration we validate isolation claims against, and it is recorded that way
rather than quietly tolerated.

### Table sizing

Connection-tracking capacity is two numbers, not one. The maximum entry count is per-namespace,
but the **hash table is a single global structure**: every namespace's entries hash into the same
buckets. Raising the maximum without raising the bucket count therefore does not add capacity so
much as lengthen every chain, converting a lookup into a scan on the busiest path in the kernel.
Both are set in node preparation, keeping the conventional ratio of four entries per bucket, and
sized against slots × expected concurrent flows rather than against a round number.

### MTU, and the failure it actually produces

Deriving the sandbox interface MTU from the node's uplink is right for the egress path, and
overlay plugins commonly reduce that value, so the derivation matters. But the silent failure is
not the derivation being wrong — it is **path MTU discovery not working**. Discovery depends on
receiving fragmentation-needed messages from intermediate routers, and cloud networks and
firewalls routinely drop them. What the tenant sees is a connection that establishes cleanly,
transfers small responses correctly, and then hangs the first time something large crosses the
path, which is reported to us as "the network is flaky" and never as an MTU problem.

Two consequences. The ruleset clamps TCP maximum segment size to the path MTU on the forward
chain, which fixes the TCP case without depending on any message arriving, and the deny list must
not swallow the ICMP messages that discovery needs when they *do* arrive. And if sandbox egress
ever traverses the cluster overlay rather than leaving directly by the uplink — a mesh, an egress
gateway, a policy tier — the uplink value is not merely stale but wrong, and the derivation has
to follow the interface the traffic actually leaves by.

### The coexistence prototype is a release precondition

Because nothing in the prior art covers this, the prototype is not a de-risking exercise to run if
there is time. It is the only evidence that will exist, and it gates the release. It is small, and
it is stated as a checklist because a partial run is worse than none — it produces confidence
without the property.

1. Bring up one node under the target CNI at the version the installation runs, with the plugin's
   own policy engine enabled rather than in a permissive default.
2. Start fifty sandboxes and confirm each has egress, that the floor holds, that a
   sandbox-supplied allow list narrows it and cannot widen it, and that no sandbox can reach
   another, the node, or the cluster network.
3. Confirm pod-to-pod traffic for unrelated workloads on that node is unaffected, in both
   directions, while the sandboxes are running.
4. Restart `vm-host` and confirm the sandboxes survive, are re-adopted, that reclaim ran against
   the adopted set, and that **no foreign namespace was touched**.
5. Pause a sandbox and restore it **onto a different slot number, on a different node**, and
   confirm it comes back with its network intact. Nothing about the naming rule above is
   observable in a test that restores a sandbox where it was captured, which is every convenient
   test; the slot and the node both have to change or the step proves nothing.
6. Destroy the sandboxes and confirm nothing is left behind in the root namespace: no rules
   referencing a returned slot, no neighbour entries, no connection-tracking entries for slot
   addresses.
7. Record the plugin and version in the compatibility matrix. A combination that has not been
   through this is not supported.

## Operational limits

| Dimension | Governing limit |
|---|---|
| Sandboxes per node | Slot pool size, and memory before it |
| Concurrent connections, node-wide | `nf_conntrack_max`, and the bucket count behind it |
| Concurrent connections, per sandbox | A cap held by `vm-host`, keyed by sandbox identifier and epoch |
| Published ports per sandbox | None architecturally; relay connections are cheap |
| Throughput per sandbox | One emulation thread per tap device, and no multi-queue backend, so this is a ceiling per sandbox rather than a share of the node (`references/firecracker-docs/network-setup.md:7-10`, `references/firecracker-docs/network-performance.md:5-14`) |
| Slot teardown latency | Deliberate drain delay, plus two conntrack flushes — one inside the namespace, one for the slot address in the root namespace — both of which must be confirmed |
| Latency of a port-opened event | The enumeration interval; nothing observes a listen |
| Egress source addresses | One per node, shared by every sandbox on it |
| Address families reachable from a sandbox | IPv4 only |
