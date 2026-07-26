---
type: Architecture
title: Security
description: Threat model, isolation layers, clone hygiene for snapshot-derived sandboxes and the point past which reseeding stops helping, the capability token model, credential handling at the guest boundary, the privilege boundary on Kubernetes and why its claims are untested, node configuration and hardware the isolation claims depend on, the supply chain for the hypervisor binary and the guest kernel, and residual risks.
tags: [architecture, security, threat-model, isolation, tokens, clone-hygiene, entropy, multi-tenancy]
timestamp: 2026-07-27T07:33:00Z
---

# Security

The product exists to run code its operator has no reason to trust. This document states what
we defend against, what each layer actually buys, and — importantly — which defences are
theatre and should not be relied upon.

## Threat model

| Actor | Capability assumed | What must hold |
|---|---|---|
| **Sandbox occupant** | Arbitrary code, root inside the guest, full control of `vm-steward` and the guest kernel's userspace. | Cannot escape the microVM. Cannot reach other sandboxes, the node, or the cluster network. Cannot exceed its resource lease or outlive it. |
| **Internet attacker** | Can reach any public hostname and guess sandbox IDs. | Cannot reach private sandbox ports without a token and cannot reach platform-management ports anonymously. May reach a tenant application port whose owner explicitly marked it public. Cannot enumerate private sandboxes. |
| **Cross-tenant attacker** | A legitimate tenant of the platform. | Cannot observe, reach, or influence another organisation's sandboxes or artifacts. |
| **Compromised guest agent** | `vm-steward` sends arbitrary, malicious bytes to `vm-host`. | `vm-host` does not crash, does not corrupt other sandboxes, and does not execute anything on the agent's behalf. |

One property belongs in the threat model but not in a row, because it is not an actor's
capability — it is a consequence of how sandboxes are made. **A pause turns guest RAM into an
object in storage.** Whatever a tenant process held in memory at the moment of capture — a
session key, a decrypted credential, a token fetched from somewhere else — is written into an
artifact, uploaded, cached on nodes, and kept for as long as the snapshot exists. Brooker et al.
list this first among the challenges snapshotting introduces, and note that it holds
"irrespective of the security properties of the snapshot storage and distribution layer"
(*Restoring Uniqueness in MicroVM Snapshots*, §1.1). Per-organisation ownership bounds who can
fetch that artifact; it does not change the fact that the tenant's memory is now at rest, and
the tenant has no way to say otherwise. [Clone hygiene](#clone-hygiene) records what we do not
offer them here.

Explicitly out of scope for the first release: side-channel attacks between VMs sharing a
physical core, and a malicious platform operator.

## The occupant is root, and what follows from it

The single most important consequence to internalise: **the occupant of a sandbox has root
inside it**. They can read `vm-steward`'s memory, replace its binary, kill it, forge its
messages, and manipulate the guest kernel's configuration.

Therefore:

- **Any secret placed inside the guest is already compromised.** Delivering a token to the
  guest and having the agent validate callers against it protects nothing from the occupant,
  because the occupant can simply read it.
- **In-guest authentication is not a tenant-isolation boundary.** The only boundary that
  matters against the occupant is the microVM itself.
- **`vm-host` must treat the guest channel as an untrusted network input.** Every message is
  size-limited, rate-limited, and strictly validated. The guest never supplies a value that
  the host uses to name a file, address a peer, or index a privileged operation.

### In-guest authentication is a trade, not an absence

The reasoning above stands: a credential the occupant can read authenticates nothing *against the
occupant*, so the internet-to-sandbox check belongs on the host side, where it cannot be tampered
with. But "protects nothing against the occupant" is not "protects nothing", and treating the
omission as self-evident is how it gets re-argued from scratch every six months. There are four
things on the other side of the trade.

- **It would authenticate the host to the guest.** Trust on the control channel is one-way today:
  the guest acts on whatever arrives on its vsock listener. A signature the guest could verify
  would let it refuse commands that did not originate with the platform — a protection the
  *tenant* wants, and one that becomes necessary the moment any guest-side operation is
  destructive on the tenant's behalf.
- **It would gate the lifecycle hook.** The post-restore hook carries the clock correction, the
  environment, the entropy reseed, and the thaw. A guest that can verify its caller can reject a
  replayed or misrouted hook instead of applying it. The epoch in the handshake already covers
  part of this and is the cheapest piece of what a full credential would buy.
- **It would enable delegable, offline-verifiable URLs.** File access is checked host-side on
  every request. A signed capability the guest could verify itself is what allows a tenant to
  hand a third party a URL that is validated where the bytes are, without a round trip per
  request. That is a product capability, not only a defence, and it is a shipped one elsewhere in
  this market — which makes it the trigger to expect rather than a hypothetical. A reference
  implementation also demonstrates how it goes wrong: its signature is a hash over the path, the
  operation, the user, and the guest's own access token, so the occupant, who is root and can read
  that token, can mint a valid signature for any path it likes; and verification is skipped
  entirely when the token is unset. The lesson is not that delegable URLs are unsound. It is that
  they need a key the occupant cannot read, which is the whole difficulty of doing this at all.
- **It would be defence in depth for the case this document already concedes.** Compromising
  `vm-host` compromises every sandbox on its node. Today that is a total loss. It is a smaller
  loss if the agent acts only on commands bearing a signature the attacker must separately steal.

**Conclusion: not in v1.** Every one of those four defends against an attacker who is not the
occupant, and the occupant is the adversary v1 is built to survive; and key material inside
`vm-steward` is baked into every artifact and cannot be redeployed, which makes getting it wrong
expensive in a way that ordinary code is not. One thing follows and is cheap now: the capability
negotiation the guest protocol already performs is where this would have to be introduced, so
leaving room for it there costs nothing today and avoids a protocol break later. Revisit when
delegable file URLs become a product requirement, or when we decide that a node-daemon compromise
should be less than total.

## Isolation layers

Defence in depth, outermost first.

1. **Hardware virtualisation.** Firecracker gives each sandbox its own kernel. This is the
   boundary that actually contains a hostile occupant; everything else is damage limitation.
2. **The jailer.** Firecracker runs under its jailer even though the pod is already privileged,
   because the pod boundary provides almost no isolation once it has `hostNetwork`, `hostPID`,
   and full privileges. The jailer contributes a per-VM chroot, a per-VM unprivileged uid and
   gid, and namespace entry. Its cgroup handling is configured to compose with ours rather than
   create a competing hierarchy.
3. **seccomp.** Firecracker's own filters constrain the VMM process itself, limiting what a
   hypothetical VMM escape reaches. They are installed **per thread and before any guest code
   runs** — on each vCPU thread immediately before it enters the guest, and on the API thread
   before its server accepts anything
   (`references/firecracker-docs/seccomp.md:7-12`) — which is what makes the credit meaningful.
   A filter applied after the guest is already executing protects nothing about the window
   before it, and that window is where an escape would be attempted.
4. **cgroups.** Each sandbox gets a cgroup with CPU, memory, and PID limits, placed outside the
   pod's own cgroup subtree so that restarting `vm-host` does not kill running VMs. Memory
   limits are enforced here, not by the kubelet, which cannot see sandboxes at all.
5. **Network namespace and nftables.** No route to the cluster network, no route between
   sandboxes, and egress filtered by a deny list — which is default *allow*, and is described
   that way in [networking](networking.md) rather than dressed up as default deny.
6. **Node pool isolation.** Sandboxes only run on labelled, tainted nodes, so a hypothetical
   escape lands on a machine that hosts no other tenant's workloads.

### Work the guest causes that the host accounts to nobody

Layer four has a class of exception, and it is worth naming as a class rather than as incidents:
**host kernel threads doing work a guest caused, living in the root cgroup, carrying no
attribution back to the sandbox that caused them.** The sandbox's CPU and memory limits do not
apply to that work, and the guest responsible cannot be identified from the thread. Two instances
are known. They differ in whether anything can be done about them, and the difference decides a
configuration choice that is made elsewhere in this bundle on latency grounds.

**The timer thread, which can be mitigated.** On x86 a guest that injects timer interrupts drives
a `kvm-pit` kernel thread on the host, created by the kernel *after* the guest starts and placed
in the root cgroup rather than in the microVM's. Firecracker cannot move it: by the time the
thread exists, the VMM has dropped privilege
(`references/firecracker-docs/prod-host-setup.md:177-192`). So a guest that programs its timer
aggressively bills host CPU to nobody. Two mitigations exist and one of them has to be chosen
rather than assumed. An external agent — `vm-host`, which is privileged and already knows both the
VMM's process and the cgroup it belongs in — moves the thread once the guest is running. Or the
virtualisation module's minimum timer period is raised at load time, which is a node-preparation
setting needing no per-sandbox action, but which applies to every guest's timer interrupts on the
node and therefore has to be measured against the workloads we intend to run rather than set to a
number that sounds safe. The first is precise, the second is cheap, and doing neither leaves a
documented layer with a documented gap.

**The asynchronous block engine's workers, which cannot be.** The asynchronous IO engine spawns
`io_uring` kernel workers in the root cgroup. They do not inherit the VMM's cgroup, they cannot be
moved out of the root cgroup, and their names carry nothing identifying the microVM they serve, so
the CPU and memory a guest's block traffic costs can be neither attributed to it nor limited by
cgroups (`references/firecracker-docs/api_requests/block-io-engine.md:140-149`). That is the
timer thread's hole without either of the timer thread's answers: there is no relocating a thread
the kernel refuses to move, and no module parameter that bounds the work. The same source records
a second cost that bites precisely at the densities we are targeting: the worker count per block
device scales with ring size and host CPU count, so a node full of microVMs can exhaust the host's
PID limit, after which nothing on the machine can create a process at all
(`references/firecracker-docs/api_requests/block-io-engine.md:120-138`). Neither cost is one we
could configure our way out of. The worker bound becomes settable only on newer kernels and is not
exposed through the drive configuration interface at all, and the attribution gap closes only on a
host kernel that does the inheriting itself — which upstream still documents as unsupported for
this purpose even though its own kernel-support table has since moved past that version. Density
built on a fact that unsettled is density built on nothing.

**So sandboxes run the synchronous engine, and this is the stronger reason.**
[Snapshots](snapshots.md) reaches the same conclusion from restore latency and
[vm-host](../components/vm-host.md) records the engine as a configuration choice; what belongs
here is why the usual argument is the weaker one. That argument is maturity — the asynchronous
engine is a developer preview and not yet production-ready — and maturity is a reason to wait for
a later version. Unattributable root-cgroup CPU on a node deliberately packed with mutually
hostile tenants is a reason not to adopt the feature at all, because it is not a defect that gets
fixed in the engine: what would have to change is the host kernel, and it is what the engine's own
documented path to production is gated on. Throughput bought by suspending a layer this document
calls load-bearing is not a trade available to us.

### A CPU template is not one of these layers

CPU templates appear elsewhere in this bundle as part of the restore compatibility key, and that
is their entire purpose: masking CPU features makes a memory snapshot portable across a wider set
of host machines than the one that captured it. But masking looks like sandboxing, and the
conclusion a reader draws unaided — that hiding a vulnerable instruction from a guest protects the
host from it — is wrong. Upstream says so directly: templates are not a security protection
against malicious guests, because disabling a feature *advertises* its absence rather than
enforcing it, and a guest that declines to consult the feature bit can execute the corresponding
instructions anyway (`references/firecracker-docs/cpu_templates/cpu-templates.md:25-30`).

Nothing in this document's isolation argument therefore rests on a template. The occupant is
contained by the layers above, and exposure to a processor-level vulnerability is handled where
such things are actually handled: microcode, disabled multithreading, and the rest of the node
configuration below. A template narrowing the guest's view is a portability decision that happens
to reduce what a well-behaved guest asks for, and the occupant is not a well-behaved guest.

## Authentication and authorization

### One token type

The system mints a single kind of credential: a **signed, attenuable capability token**. It
carries the sandbox ID, the epoch, the set of permitted operations, and an expiry, and it is
signed by `control-plane` with a rotating key identified by a key ID.

Attenuation is what removes the need for a zoo of credential types. A tenant's full-access
token can be narrowed — by `vm-host` or by the SDK — into a token good only for, say, ingress to
port 3000 of one sandbox for fifteen minutes. A browser preview link is exactly that: the same
token format, attenuated and delivered as a cookie.

| Surface | Credential |
|---|---|
| Control-plane API | Organisation API key, or OIDC bearer token |
| Sandbox data plane (SDK) | Capability token in a header |
| Sandbox data plane (browser) | Attenuated capability token as a scoped cookie, set by `gateway` after a one-time link exchange |
| Public tenant application port | None; both data-path hops verify the explicit per-port exposure record |
| Service to service | Workload identity with mTLS |

### Verification and explicit public exposure

Both `gateway` and `vm-host` verify. `gateway`'s check is an optimisation and a cheap filter;
`vm-host`'s is the authoritative one, because it is the component that can actually reach the
sandbox. For private traffic they verify the capability token. For anonymous traffic they
independently verify that the addressed tenant application port has an active `public` exposure
record.

> **No port is implicitly exempt.** Anonymous access exists only for a tenant application port
> whose owner explicitly marked that exact port `public`. Management, agent, health, and
> debugging surfaces can never be made public.

Public exposure is an authorization decision, not absence of one. It is explicit, per sandbox
and port, durable, audited, default-off, and enforced at both hops. A port with no exposure record
is private. The reserved sandbox agent port is rejected by the exposure API, so no request can
turn the process and filesystem API into an anonymous surface.

The separation is the point: user application traffic and the in-guest tool API are separate
surfaces, and the node-side proxy is the enforcement point for application ingress. Every port
defaults to private and exposure is per-port rather than sandbox-wide. There is no agent-port
bypass: the management surface always requires its capability token.

### Credentials stop at the trust boundary

> **Verify twice, strip once. Nothing that authorised a request crosses into a guest.**

Nothing the platform issued or accepted as proof of authorisation reaches a guest: not the
organisation API key, not the capability token that authorised an ingress request, not the
preview cookie `gateway` set, not object storage credentials, and not the platform's own workload
identity. What arrives at the tenant's process is the request, minus the credential that got it
there.

*Which* hop strips is not an implementation detail, because `gateway`'s upstream **is** `vm-host`.
An edge that stripped would leave the node with nothing left to check, and the property that makes
the node authoritative — that a routing mistake at the edge cannot become an authorization bypass
— would be unimplementable rather than merely unimplemented. So **the edge verifies and forwards;
the node verifies again and strips the token header and the session cookie before anything reaches
the guest.** The credential is consumed at the last hop that checks it, which is the hop adjacent
to the hostile side.

An explicitly public tenant port requires no client credential. If a browser or SDK supplies a
platform token or cookie anyway, `gateway` removes it because the node authorizes this branch from
exposure state; `vm-host` strips defensively as well. The equivalent invariant is **check the
exposure twice**: `gateway` filters against its cached view, and `vm-host` authoritatively checks
its versioned exposure state before opening the relay. The edge-to-node hop remains mutually
authenticated; public means anonymous at the product boundary, not unauthenticated
service-to-service traffic inside the cluster.

For authenticated requests that hop carries a live bearer credential, which changes what it has
to be: the
edge-to-node connection is **mutually authenticated with workload identity**, not plain traffic on
the host network. A listener that accepts forwarded tokens without authenticating its caller is a
token-harvesting endpoint for anything that can reach the node's address space, and on a
host-networked pool that is a larger set than it sounds.

The stripping rule needs stating because the default behaviour of every proxy library is the
opposite — forward the headers you were given — and the guest is hostile. A forwarded token is a
token handed to the attacker, and an attenuated one is still a working credential for whatever it
was attenuated to. The one thing that legitimately crosses is the tenant's *own* material:
environment variables they supplied, and headers their own clients sent for their own
application. Those were never ours.

### Sandboxes are same-site with each other

Every sandbox is a hostname under one registrable domain. Browsers compute "same site" from the
registrable domain, so two sandboxes belonging to two different organisations are same-site with
each other: **the `SameSite` cookie attribute does not isolate them**, and a page served by one
sandbox can issue credentialed requests to another. That is cross-tenant request forgery with the
browser supplying the credential, and it exists precisely because the hostname scheme is what
makes preview links work.

Three mitigations, the first of which is the structural one:

- **Register the sandbox domain on the Public Suffix List.** This makes each sandbox hostname its
  own registrable domain, which restores same-site separation and fixes the class rather than
  instances of it. It is also slow — submission plus browser release cycles — so it has to be
  started long before it is needed.
- **Check `Origin` and fetch-metadata headers at `gateway`** on any request carrying a preview
  cookie, rejecting cross-site ones. This works today, does not depend on anyone else's release
  schedule, and stays as defence in depth afterwards.
- **Scope preview cookies as narrowly as the scheme allows** — host-only, never domain-wide — so
  a cookie minted for one sandbox is at least not *sent* to another.

### Epochs and revocation

Every sandbox instance carries an epoch, and **it advances whenever a new sandbox instance is
created**. A resume is one, and so is a checkpoint; neither is a transition of the instance the
caller was holding a token for. It deliberately does **not** advance when `vm-host` restarts and
adopts a running sandbox, because there the instance is unchanged and only the connection is new
— advancing it would invalidate every live token for a VM that never stopped. Tokens embed the
epoch they were minted for, so credentials from a previous instance fail closed without any
revocation list. Combined with short expiry and a refresh flow in the SDK, this
covers the realistic revocation cases: killing a sandbox invalidates everything about it
immediately, because the sandbox no longer exists.

That line is drawn in the same place the hypervisor's generation identifier draws it, reached
from the other end. Brooker et al. ask the question directly — under what circumstances is a VM
still the same VM — and record the established answer: the identifier changes on restore, copy
and clone, and not on reboot, live migration, or the pause and resume of a machine that was
never duplicated (§3.5). Both are tracking whether a second instance of one image now exists,
rather than whether a machine was interrupted, which is why the epoch advances on a resume and
sits still through a `vm-host` restart. They remain separate things: the generation identifier
is a counter the guest reads, the epoch is the platform's name for an instance, and the paper
makes the same distinction when it observes that a generation identifier is not the identity of
the microVM and that choosing one is a separate concern.

## The privilege boundary on Kubernetes

`vm-host` requires `privileged: true`, and the reason is worth recording so nobody spends a
sprint trying to remove it.

The usual answer — mount propagation — is one gate but not the only route, and giving it as *the*
reason invites someone to solve that one thing and conclude the rest will follow. It will not.
Per-sandbox network namespaces must be bind-mounted into the host's namespace directory to
survive a daemon restart, and bidirectional mount propagation is indeed permitted only to
privileged containers. Device access is genuinely not a blocker: `/dev/kvm` and `/dev/net/tun`
can be granted with a device plugin.

The honest framing is that **the jailer alone requires a capability set that is privileged in all
but name.** Enumerating it is more useful than arguing about the label:

| Requirement | For |
|---|---|
| Namespace creation | The jailer's own namespaces, and entering the sandbox's |
| Root pivoting | The per-VM chroot |
| Device node creation | The VM's device nodes inside that chroot |
| Ownership and credential changes | Dropping to the per-VM unprivileged uid and gid |
| Network administration | The tap device and the slot's ruleset |
| A writable control-group hierarchy | Per-sandbox limits, in a subtree outside the pod's |
| An unconfined system-call filter | The container runtime's default profile gates the very calls the jailer makes, including the fault-handling device the restore path depends on |
| An unconfined mandatory-access-control profile | The default profile denies the mount and device operations above |

Any container holding all of that can trivially obtain the rest. Chasing a narrower set is
therefore effort spent on the appearance of least privilege rather than on its substance, and
the engineering response is instead to **bound the blast radius** — an argument that is entirely
unaffected by how the privilege is spelled:

- `vm-host` lives in its own namespace, and only that namespace is labelled for the privileged
  Pod Security Admission profile. Every other component runs Restricted.
- That namespace schedules only onto the tainted sandbox node pool.
- Node preparation happens in an init container of the same pod, so the privileged surface is
  one workload rather than several.

### Nobody has run this shape on Kubernetes

Everything above is reasoning, and it is worth stating plainly that reasoning is all it is. No
comparable system runs sandboxes this way. The production platforms in this space either run their
node component outside Kubernetes entirely, as a bare host process under a different scheduler, or
run it as a root host service and place tenant workloads in privileged containers on a shared
container daemon — which is not a hardware-isolation boundary at all, and so is no reference for
anything in the threat model above. There is no prior art for a privileged DaemonSet that owns
hypervisors, and therefore none for any of the specific claims made here: that bidirectional mount
propagation behaves as documented under live sandbox load, that `hostPID` and out-of-pod cgroups
really do carry sandboxes across a pod replacement, that node-pressure eviction can be kept away
from this pod by priority alone, that a privileged namespace on a tainted pool bounds the surface
in practice rather than only on paper.

Each of those is defensible and each is untested by anyone. **An assertion nobody has tested is a
different risk from one that is wrong**: a wrong assertion fails once and gets corrected, while an
untested one fails at whatever scale it is first run at, and every one of these fails by
destroying running sandboxes. That is the argument for a conformance suite that exercises these
behaviours against a real cluster — pod replacement under load, eviction pressure, drain,
autoscaler interaction — before an installation depends on them, and for treating the first
production installation as the experiment it is.

### The service account holds no node write

It is tempting to write that the service account is scoped to exactly what it needs — watching
its own pods, and patching its own node's annotations. The second half is not achievable, and the
resolution is to stop needing it.

Node objects are cluster-scoped, so the permission has to come from a cluster role, and
role-based access control offers no per-object scoping for the verbs involved: the object-name
restriction that exists does not apply to `list` or `watch` at all, and a DaemonSet shares one
service account across every one of its pods, so restricting by name would have to name every
node in the cluster anyway. The mechanism that solves this properly exists only for kubelet
credentials, and we are not one. Granting the write therefore grants **the ability to modify every
node in the cluster** — annotations, labels, and with them a cluster-wide scheduling primitive —
inside the section whose whole purpose is bounding blast radius.

The only write the daemon ever wanted was the autoscaler's do-not-disrupt hint, and that hint is a
backstop rather than a mitigation. The documented installation default is that **the sandbox node
pool does not scale in**, and accurate resource requests are what make a node holding fifty
microVMs look as busy as it is. A hint whose value never changes belongs on the node pool at
install time, written by the chart or by whatever configures the pool's nodes — not set at runtime
by a privileged daemon that needs cluster-wide permission in order to set it.

So **the daemon's Kubernetes access is read-only.** It watches its own pod and reads what it needs
to report status; it holds no write against any object, node or otherwise. This is what keeps the
argument above honest: a section claiming the blast radius is bounded to one node pool cannot also
hand that same process a primitive that reaches every node in the cluster, and the cheap way to
resolve the contradiction is to drop the permission rather than to justify it.

If a runtime node write ever does become necessary, the shape is decided here rather than reached
for under deadline. The daemon reports intent over the gRPC stream it already holds, and a small
separate controller performs the patch after checking that the node named is the node that asked.
The privileged daemon still holds nothing, and the component that does hold the write is
unprivileged, tiny, and auditable. Nothing needs it today.

### `hostPID` is not free

The overview justifies `hostPID` as a correctness requirement, and it is one — without it,
restarting the daemon kills every running sandbox. The cost is not counted there, so it is counted
here: sharing the host's process namespace exposes every process on the node to this container,
including each one's command line, its **environment**, and its root directory and open files
through the process filesystem. Any secret another workload holds in its environment is readable
by us.

The node pool's taint does not remove this, because the workloads that land there anyway are
exactly the ones that tolerate every taint: the cluster network plugin, the node proxy, storage
and logging agents. Two consequences. It is one more reason nothing but sandbox infrastructure
should run on these nodes. And the daemon must never collect, log, or ship node-wide process
listings, since doing so would launder other workloads' secrets into our telemetry pipeline.

## Tenant isolation

- **Compute and memory**: separate microVMs, separate cgroups.
- **Network**: separate namespaces, no inter-sandbox route, and a per-namespace ruleset whose
  connection-tracking state must be provably scrubbed before a slot is reused.
- **Artifacts**: every artifact is owned by an organisation; `control-plane` authorises before
  `vm-host` is ever asked to fetch, and cache keys are artifact IDs that a tenant cannot forge
  into another tenant's namespace.
- **Node cache**: a shared cache means a tenant can observe *timing* differences that reveal
  whether another tenant recently used the same public template. Templates are immutable and their
  contents are not secret, so the timing channel itself is accepted; private templates are never
  shared across organisations in the same cache entry. **Non-secrecy is not what makes template
  sharing safe**, and the next section is why: two tenants restoring the same template share more
  than bytes on disk.

## Clone hygiene

A sandbox does not boot. It resumes from a memory image that was booted exactly once, at build
time, which means every piece of state a machine is supposed to generate for itself is **identical
in every sandbox created from that template** — not similar, identical, bit for bit, forever.

| Shared state | Consequence |
|---|---|
| The guest kernel's random pool | Until it is reseeded, two sandboxes produce the same bytes from the random device: the same keys, session identifiers, nonces, and process address-space randomisation. |
| The machine identity file | Anything deriving an identifier from it collides across every clone, and some libraries derive stable secrets from it rather than merely an identifier. |
| The boot identifier | Same, for anything that treats a boot as unique. |
| A random seed file written for the next boot | Captured along with everything else, so every clone seeds from the same file — the mechanism intended to add entropy across boots removes it across clones. |
| Host keys and TLS material baked at build time | Every clone presents the same key, so any two sandboxes can impersonate one another to anything that trusts it. |

The guest is not entirely passive about this: the hypervisor exposes a generation identifier that
changes when a VM is restored, and the guest kernel treats the new value as randomness — not
credited as entropy, because it is unique rather than secret, but enough to force an immediate
reseed of the CSPRNG behind the random devices
(`references/firecracker-docs/snapshotting/random-for-clones.md:104-124`). That mechanism is real
and insufficient, for three independent reasons.

**There is a race, and the post-restore hook is on the wrong side of it.** The reseed happens
after the vCPUs resume, and nothing synchronises it with the hook — and the hook is what thaws the
tenant cgroup. Tenant code can therefore execute inside the window between resume and reseed, and
the window does not need to be long: reading the random device is one system call. This is not
our inference. Upstream states it in the same terms: values from `getrandom` and the random
devices differ across clones only *after* the kernel handles the notification, which "leaves a
race window between resuming vCPUs and Linux CSPRNG getting successfully re-seeded"
(`references/firecracker-docs/snapshotting/random-for-clones.md:127-130`), and its recommendation
even for kernels that implement the device is to perform an explicit reseed before tenant code
resumes, for that reason alone
(`references/firecracker-docs/snapshotting/random-for-clones.md:168-169,180-183`).

**It only covers the pool.** Machine identity, boot identifier, seed files, and baked keys are
files on a disk. No kernel mechanism regenerates them, and no amount of reseeding touches them.

**It stops at the kernel.** A userspace pseudorandom generator seeds itself once, from the kernel
or from a hardware instruction, and then stretches that seed deterministically. Reseeding the
kernel pool after a restore does nothing to a generator that took its seed before the capture,
and every sandbox from that template inherits the same generator in the same state. Brooker et
al. state the consequence without qualification: even where the platform follows best practice by
reseeding kernel randomness *and* the tenant follows best practice by using a cryptographically
secure PRNG, "the combination is not secure" (§2). Upstream arrives at the same place and offers
no remedy — it scopes itself to the kernel interfaces and can do no more than recommend against
userspace pools "in pre-snapshot logic"
(`references/firecracker-docs/snapshotting/random-for-clones.md:6-12`). Everything below is
therefore the strongest thing available at this layer rather than a fix, and the difference is
recorded in [residual risks](#residual-risks) instead of being left for a reader to notice.

Three requirements, all of which are cheap and none of which is optional:

1. **A virtual entropy device on every VM**, so the guest has a host-backed source to reseed
   *from*, rather than only the pool captured in its own image. It is a source and not the
   reseed: the guest kernel decides when to draw from the device, and nothing outside the guest
   can force that to happen at the instant a restore completes
   (`references/firecracker-docs/snapshotting/random-for-clones.md:166-167,191-193`), which is
   why the next requirement exists alongside it rather than instead of it.
2. **An explicit reseed in the post-restore hook, before the thaw.** Ordering is the entire point.
   The tenant cgroup is captured frozen and the hook is what releases it (see
   [snapshots](snapshots.md)), so a reseed placed before the thaw closes the race by construction
   rather than narrowing it; a reseed placed after the thaw is the same race with extra steps. The
   hook regenerates the machine identity in the same window, and the boot identifier with it —
   though not by writing it. `/proc/sys/kernel/random/boot_id` is initialised at boot and is
   **read-only afterwards**, so the only thing that changes what a reader sees is a bind mount of
   another file over it (`references/firecracker-docs/snapshotting/random-for-clones.md:150-155`).
   The mount is established once at boot by [vm-init](../components/vm-init.md), and the hook
   writes the per-sandbox value into the file underneath it.
3. **Build-time hygiene.** The template build strips what should never have been captured: seed
   files removed, machine identity emptied so the guest regenerates it, host keys and TLS material
   generated on first use rather than baked in. A template that never contained a key cannot leak
   one, and this is the only one of the three that also protects sandboxes created *before* the
   hook ran correctly.

### The freeze is the fence, and a fence is what the guarantee needs

The ordering above is not a local convenience, and it is worth knowing that the team who wrote
the hypervisor reached the same construction independently. Brooker et al. observe that a
serverless platform tracking the requests in flight in a VM can "fully quiesce a VM and ensure
that it does not handle any requests until the notification process is complete", and that this
is what makes the guarantee hold rather than merely become likely (§3.7). That is precisely the
shape here: the tenant cgroup freeze is captured *into* the artifact, so a restored guest starts
with tenant code already stopped, and the thaw at the end of the hook is the fence. It is the
strongest corroboration any claim in this document has.

The same section states the limit, and the limit is fundamental rather than an implementation
gap. **No mechanism strongly prevents reuse.** A program that does not atomically generate, use,
and discard a value can be cloned between generation and use, or between use and discard, and
atomicity over operations of that shape is not generally available; what closes it is "some
external fence provided by the environment" (§3.7). Our freeze is that fence for everything after
the restore. It is not a fence for a value the template already generated and still holds — a key
established while the build warmed a service, a counter in a process that was running when the
capture was taken. Those were duplicated before there was a hook to run, which is why build-time
hygiene is a requirement above and not an optimisation, and why
[template-builder](../components/template-builder.md) documents consuming randomness before a
capture as unsupported.

**And a tenant cannot keep anything out of a snapshot.** The mechanism exists: a memory-advice
flag that marks pages to be wiped when the VM is suspended, so a library holding a key or a
generator state has it zeroed at capture and detects the zeroing on the far side. Wiping at
suspend rather than at restore is deliberate and buys two things — restore is the latency-critical
path, and an application gains a way to exclude high-value secrets from the snapshot entirely, or
to re-fetch them from a key management service after it (§3.2). The cost is not the obstacle: the
guard-page check measures around 600 nanoseconds per generation and amortises to nothing against
any real work (§3.2, §4). We expose no such capability, so every byte of a tenant's memory is in
the artifact and there is nothing they can mark. Stated as the product gap it is: a tenant holding
material they do not want written to durable storage should not hold it across a pause.

**For a shared public template, all of this is cross-tenant.** Two sandboxes belonging to two
different organisations, created from the same public template, begin life with the same random
pool and the same machine identity; if either generates a key before reseeding, so can the other.
That is what makes clone hygiene a tenant-isolation control rather than a hardening nicety, and
it is why the argument that shared templates are safe *because their contents are not secret*
does not hold. The contents were never the issue. Sameness is.

## Hardening the host against the guest

Concrete rules for anything that processes guest-supplied data:

- Length-prefixed framing with a hard maximum frame size; oversized frames close the connection.
- Per-sandbox rate limits on message volume and on expensive operations.
- No guest-supplied string is ever interpolated into a path, a command line, or an identifier
  used by the host. Host-side filenames derive from host-side identifiers only.
- No shelling out anywhere in the pause or restore path.
- Parsing failures terminate the sandbox rather than attempting recovery.

## Node configuration the isolation claims depend on

A handful of node-level decisions do more for tenant isolation than most of the code in this
repository, and none of them is engineering. Most are configuration, belong in node preparation,
and are verified at startup like everything else there. Two are properties of the machine rather
than settings on it, which is exactly why they have to be written down: a preflight check catches
a sysctl nobody set, and catches nothing at all about a machine nobody specified correctly.

**The sandbox node pool is bare metal, or has nested virtualisation enabled.** Firecracker needs
`/dev/kvm` and the processor's virtualisation extensions, and on a managed Kubernetes cluster the
default node type frequently provides neither. Nothing else in this bundle says so, and this is
the single most likely reason a first installation fails. It will also present badly: the
symptom is "sandbox creation fails", not "these nodes cannot run virtual machines", because the
component that discovers the missing capability is several layers below the person who chose the
machine type. A reference implementation makes it an explicit variable of its infrastructure in
three separate places, separately for its sandbox nodes and its build nodes, which is the right
instinct. So it is a stated requirement of the node pool, and `vm-host` asserts it at startup —
the device exists, it is usable, and hardware virtualisation is genuinely available — and refuses
readiness otherwise, exactly like every other preparation check.

**Simultaneous multithreading is disabled.** Sibling threads on one physical core share
microarchitectural state, and the cross-VM attacks that survive current mitigations largely
depend on that co-residency. This document places physical-core side channels out of scope for
the first release; disabling SMT is what makes that scope statement defensible rather than
aspirational. It costs throughput, and that is the trade being made deliberately.

**Kernel same-page merging is off.** Same-page merging scans memory and deduplicates identical
pages **across tenants**, and the write-timing difference on a merged page is a cross-tenant
memory-disclosure primitive. It contradicts every isolation claim made here, and it is a one-line
node setting rather than a research problem. It needs writing down as forbidden rather than merely
left unenabled, because a fleet of near-identical clones is exactly the workload for which someone
will eventually propose it as a memory saving.

The page-cache sharing the warm restore path relies on is a different mechanism and is fine: it
shares clean pages of one file among VMs mapping that same file, with no scanning, no comparison
of one tenant's memory against another's, and no merge of pages that merely happen to be equal.

**Microcode is loaded early in the boot process.** Mitigation for speculative-execution issues is
split between the kernel and the processor's own firmware, and a kernel applying its half on top
of un-updated microcode produces a host whose mitigation status is not what its configuration
claims. Loading it as early in boot as the distribution permits closes the window in which the
machine runs unmitigated, and keeping it current is a standing patching obligation rather than an
install-time step — the hardware half of these mitigations changes as often as the software half.

**Memory is ECC and supports target row refresh.** Rowhammer is a cross-tenant memory-*corruption*
primitive, not merely a disclosure one, and no hypervisor design addresses it: it is one tenant's
access pattern flipping bits in a physical row belonging to another, underneath every boundary
named in this document. The mitigation is the hardware itself. This is a procurement requirement
rather than a setting, which is precisely why it needs recording — a missing setting is caught by
a preflight check on the first boot, while a machine bought without a property is caught by
nobody, and the sandbox node pool is the one place in the installation where it matters.

**The serial device is disabled at boot and given a bounded sink anyway.** Guest console output is
guest-controlled and unbounded, and a guest that finds the console disabled can re-enable it from
inside, because the boot-time setting is a request to a kernel the tenant controls. Disabling it on
the kernel command line handles the accidental case; the sink handles the hostile one. Without the
second half, a guest can spend the host's CPU and disk on console writes from inside its own VM.

**The VMM must be killable without its cooperation.** Its signal handling is not
async-signal-safe, so a wedged process may not honour a polite signal and its shutdown path can
hang. Termination therefore never depends on the process agreeing to it: an overwatcher tracks
each VMM, escalates to an unconditional kill after a deadline, and reports the escalation. The
same escalation governs the drain path, where the alternative is a node that never finishes
terminating.

## The VMM binary and the guest kernel are not artifacts

The artifact supply chain is strong. Every artifact is described by a manifest, whole-file digests
are verified before a file is allowed to back a guest, and the manifest is written last so a
partial upload is invisible rather than half-readable. Two files every sandbox depends on
completely sit outside that chain.

The hypervisor binary and the guest kernel do not arrive through the artifact store. They arrive
on a host path — baked into the node image, or placed on a host-path volume at install time, which
is where they have to live anyway because a running VM must not depend on a filesystem that
disappears when its pod does. Nothing downstream checks them. A reference implementation mounts
both from object storage with no verification of either. Whoever can write those paths owns every
sandbox created afterwards, and owns them *beneath* the layer that every other control in this
document is built on.

**The jailer trusts everything it is handed, and counts whoever hands it as trusted too.** Its
documentation is explicit that *all* of its inputs are trusted — the executable path, the chroot
base directory, the network-namespace path, and any resource placed inside the jail root — and
that the operator invoking it is part of the trusted computing base, whose responsibility it is to
ensure those paths cannot be modified by anyone else on the machine
(`references/firecracker-docs/jailer.md:266-274`). Two things follow that are easy to miss. The
namespace path is trusted like the rest, so handing over the wrong one **places a sandbox inside
another sandbox's network namespace rather than failing** — a tenant-isolation failure produced by
a string, with no error anywhere, which is why those paths derive from host-side identifiers and
never from anything a guest influenced. And the chart that supplies these arguments is not
deployment plumbing: it is the artifact that populates the jailer's trusted input set, and it is
security-relevant in the same way the signing key is.

So both are pinned and verified: the chart carries the expected digest of the VMM binary, the
jailer, and the guest kernel image, and `vm-host` checks each file against its pinned digest
before reporting ready. This is the rule the artifact store already applies — bytes are not
trusted until a digest says so — extended to the two files that escaped it only because they
happen to be installed rather than fetched.

**A digest says the bytes are the ones intended. It does not say they were the right ones to
intend.** The hypervisor's default system-call filters are compiled in at build time, and **debug
builds and experimental targets ship with no default filters at all**, on the reasoning that they
are not for production use (`references/firecracker-docs/seccomp.md:14-17`). A node pinned to such
a build passes its digest check perfectly and runs every sandbox with an isolation layer this
document enumerates simply absent — no error, no warning, and nothing in the pinning mechanism
that would notice, because integrity verification answers a different question from provenance.
The pinned digest must therefore be of a release build for a production target, which is a
property of how the binary was produced rather than of the file, and belongs with whoever
publishes the chart. It is the clearest case in this document of a control that looks like it
covers something it does not.

## Secrets

Tenant-supplied environment variables are delivered to the guest at restore time over vsock,
never baked into artifacts and never written to logs. Platform secrets — signing keys, object
storage credentials, database passwords — are mounted into the components that need them and
are never present inside a guest. Tokens are held in memory, redacted in logs and traces, and
never appear in a URL path that gets logged, which is why browser preview uses a cookie rather
than a persistent query parameter.

## Auditing

`control-plane` records an immutable audit entry for every lifecycle and authorization
decision: who, what, which organisation, which sandbox, and the outcome. Sandbox stdout is
tenant data and is deliberately *not* captured centrally.

## Residual risks

Stated plainly, because pretending otherwise is worse.

- **A Firecracker escape is fatal to the node's isolation.** Mitigated by keeping Firecracker
  current, running the jailer, and confining sandboxes to their own node pool.
- **The privileged DaemonSet is a high-value target.** A compromise of `vm-host` is a
  compromise of every sandbox on that node and of every secret in the environment of every other
  process on it. It is not a compromise of the cluster's scheduling, and that is the reason the
  daemon holds no write against the Kubernetes API.
- **Shared node cache leaks coarse timing information** about template popularity.
- **Clone hygiene is enforced by a hook, not by the hardware.** The isolation boundary is the
  microVM; the guarantee that two clones diverge is a sequence of steps in the post-restore hook
  and the template build. A bug in either is a cross-tenant issue that no other layer catches.
- **The hook reaches only as far as the kernel.** A userspace generator seeded before the capture
  is bit-identical in every clone, and nothing this platform does corrects it — a limit of the
  mechanism rather than of our use of it (Brooker et al., §2 and §3.7). For a shared public
  template that state is shared across organisations. Build-time hygiene narrows it by keeping
  such generators out of pre-capture code, and narrowing is all it does.
- **Guest memory at the moment of a pause is written to durable storage,** and a tenant has no
  way to mark anything as excluded from it. The suspend-time wipe that would give them one is
  described in clone hygiene above and is not implemented.
- **Denial of service by resource exhaustion** is bounded by cgroups, by quotas, and by the
  hypervisor's per-device block and network rate limiters, which are configured on every sandbox
  rather than left at their permissive defaults — see [vm-host](../components/vm-host.md). What
  those do not partition is what remains, and it has two named mechanisms rather than a category:
  the `kvm-pit` timer thread until an agent places it in the sandbox's cgroup, and the
  root-cgroup `io_uring` workers that are the reason the asynchronous block engine is not used at
  all. Memory bandwidth, shared caches, and the NVMe a concurrent snapshot is writing to are
  unpartitioned too. So a tenant can still degrade a node they share, but noisy-neighbour
  degradation is a bounded residue rather than an absence of controls. Placement spreads load; it
  does not eliminate this.
- **The Kubernetes claims rest on reasoning, not on anyone's operating experience.** No comparable
  system runs this shape, so the privileged-DaemonSet, mount-propagation, `hostPID`, and eviction
  behaviours are untested rather than known. See the privilege boundary above.
- **CNI interaction** is the least-tested surface and the most likely source of an
  isolation-relevant surprise. It must be validated per CNI, not assumed.
