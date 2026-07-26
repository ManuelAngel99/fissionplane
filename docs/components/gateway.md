---
type: Component
title: gateway
description: The stateless edge proxy that terminates wildcard TLS, parses the sandbox subdomain, checks explicit public exposure or private credentials, and forwards traffic to the owning node.
tags: [component, gateway, edge, tls, routing]
timestamp: 2026-07-27T07:33:00Z
---

# gateway

`gateway` turns a public hostname into a connection to the right node. It is a Deployment on
ordinary nodes behind a `Service` of type LoadBalancer, fronted by an HPA, terminating wildcard
TLS for the sandbox domain. Replicas share no state with each other and hold nothing that
matters if they die.

## Purpose

Every request to `https://<port>-<sandbox-id>.<domain>` arrives here. The component's entire
job is to answer three questions and then get out of the way: which sandbox is this for, is the
caller allowed, and which node holds it.

It is deliberately the least interesting component in the system, and that is a design goal
rather than an admission. It sits in front of everything: every published port, every terminal
session, every file stream, every browser preview. Whatever is in this component is in the
blast radius of all tenant traffic simultaneously. So the correct amount of logic here is the
minimum that makes routing work, and every proposal to add a feature is weighed against the
fact that a bug in it takes down the data path for the whole installation, not one tenant.

The corollary is that it must be boring in the operational sense too: no state to migrate, no
warm-up, no leader, no ordering constraints on deploys. A replica can be created or destroyed
at any moment and the only consequence is that in-flight connections on that replica end and
clients reconnect.

## Responsibilities

| Responsibility | What it means concretely |
|---|---|
| TLS termination | Serve the wildcard certificate for the sandbox domain; negotiate ALPN. |
| Host parsing | Extract the port and sandbox ID from a single DNS label. |
| Authorization | Check explicit public exposure or verify a capability token/scoped cookie; reject a cookie-authenticated request whose origin is not its own target. |
| Cookie exchange | Validate a one-time link, set a host-scoped cookie, redirect to the clean URL. |
| Credential forwarding | Carry a private request's verified token or cookie to the owning node over a mutually authenticated hop, so the node can perform the check that decides. |
| Routing and exposure | Resolve the sandbox's node and active public ports per request, from a cache backed by durable records. |
| Proxying | Terminate HTTP/2 at the edge and forward HTTP/1.1 upstream, carrying WebSocket upgrades and long-lived byte streams without interference. |
| Client attribution | Set the forwarded-client-address and forwarded-host headers, replacing whatever the caller sent. |
| Rate limiting | Bound authenticated traffic per token and anonymous traffic per public port/source, plus per-sandbox limits. |
| Request identity | Generate or accept a request identifier and propagate it to the node. |
| Error surfacing | Return an accurate, non-leaking status for each failure class. |

## Explicit non-responsibilities

| Not responsible for | Owner |
|---|---|
| Business logic of any kind | [control-plane](control-plane.md) |
| Quota decisions and metering | [control-plane](control-plane.md) |
| Any knowledge of templates, artifacts, or organisations | [control-plane](control-plane.md) |
| Minting or widening credentials | [control-plane](control-plane.md) |
| The authoritative authorization check | [vm-host](vm-host.md) |
| Removing the credential before the guest sees it | [vm-host](vm-host.md) |
| Bounding concurrent connections per sandbox | [vm-host](vm-host.md) |
| Keeping a sandbox alive while a connection is open | [vm-host](vm-host.md) |
| Knowing whether a sandbox is really on a node | [vm-host](vm-host.md) |
| Creating any Kubernetes object | Nobody; see below |

`gateway` **creates no per-sandbox Kubernetes objects** — no Ingress, no HTTPRoute, no Service.
The reasoning is in [networking](../architecture/networking.md): at sandbox churn rates those
objects would keep the cluster's shared ingress in a permanent reload loop, and each one is an
etcd write and a watch event delivered to every controller replica in the cluster, costs borne
by workloads with no relationship to us. Host parsing against our own routing state avoids all
of it, and is also simply faster than waiting for a controller to converge before a new sandbox
is reachable.

The component also does not own the last word on authorization. Its check is a cheap filter;
`vm-host` independently verifies the credential or active public exposure because it is the
component that can actually reach the sandbox. A routing or policy-cache mistake here is therefore
a wrong answer, not an authorization bypass. See [security](../architecture/security.md) and
[below](#authorization-is-checked-twice-and-credentials-are-stripped-once).

`gateway` also does not keep a sandbox alive. Every sandbox holds a lease that `vm-host` enforces
from outside the guest, and a tenant who holds a PTY or a file watch open past that deadline must
not lose the sandbox mid-session — the browser form especially, since it has no refresh path and
no way to ask for an extension. So traffic has to extend the lease, and the signal has to come from
whoever can measure it exactly. That is the node: `vm-host` terminates every data-plane
connection, so it knows last-traffic time and open-stream count without inferring either, and it
already carries per-sandbox status upward on a link it holds anyway. Measuring it here would put a
control-plane call on the request path, which is the single dependency this component must not
acquire, and it would still be wrong on its own terms — a long-lived stream is one request, so a
per-request signal reports a two-hour terminal session as idle a minute in. The mechanism needs
both a per-request update and a timer running for the life of the connection, which is what a
reference implementation does in each of its two ingress paths independently. All of that belongs
where the connections are.

## Internal structure

A single Rust binary built as a stack of layers around a proxy core. The request path allocates
little, copies bodies rather than buffering them, and holds no lock that spans I/O.

```
   TLS acceptor            wildcard cert, ALPN (h2, http/1.1)
        │
   host parser             ":authority" → (u16, SandboxId), per request, never per connection
        │                  malformed → reject before any I/O
   rate limiter            local token bucket, backed by Redis counters
        │
   policy resolver         (sandbox, port) → private │ public
        │                  in-process LRU → Redis → durable exposure record
   authorizer              public: no client credential
        │                  private: verify header token │ scoped cookie
        │                  cookie form additionally: origin matches target
   route resolver          sandbox → node   (in-process LRU → Redis → durable record)
        │
   proxy                   HTTP/1.1 over mutual TLS, upgrades, bidirectional
        │                  private: credential travels with request
        │                  public: no client credential
        ▼
   vm-host on owning node  checks token or public exposure; strips credentials
```

Order is deliberate. Parsing precedes any network call, so a malformed or hostile hostname costs
nothing beyond a string scan. Rate limiting precedes verification, so signature checks cannot be
used as an amplification vector. The exposure lookup treats a missing record as private, then
**authorization precedes route resolution**. An unauthenticated request to a private or unknown
sandbox receives the same answer; a public sandbox port is intentionally reachable and therefore
not a secret whose existence can be concealed.

## Interfaces

| Direction | Peer | Transport | Purpose |
|---|---|---|---|
| Inbound | Internet, via a cloud load balancer | HTTPS on the wildcard sandbox domain | All sandbox data-plane traffic |
| Inbound | Cluster | HTTP | Health, readiness, metrics |
| Outbound | `vm-host` on the owning node | HTTP/1.1 with mutual TLS and workload identity, to the node's host address | Proxied requests, upgrades, and streams. Private requests carry the caller's credential; public requests carry no client credential. HTTP/2 terminates here and does not continue upstream. |
| Outbound | Redis | Pooled | Routing and public-exposure cache reads, rate limit counters |
| Outbound | PostgreSQL | Pooled, read-only credentials | Routing and exposure lookups when caches miss |
| Outbound | `control-plane` | HTTP, cached | Token verification key set, keyed by key ID |

The PostgreSQL connection is the only place `gateway` touches durable state, it is read-only,
and the query is an indexed lookup of the sandbox route plus active exposure records. It exists
because Redis is a cache and losing it must degrade latency rather than correctness. The
verification key set is public
material: `gateway` can check a signature and cannot produce one, so compromising a replica does
not yield the ability to issue credentials.

The upstream hop is mutually authenticated on the same terms as the node's control listener.
Private traffic carries a live bearer credential, public traffic reaches the same privileged
listener without one, and network policy does not apply to a host-networked listener. The client
identity a replica presents is not a signing key and confers nothing beyond reachability;
`vm-host` still authorizes every request from its own token or exposure state.

## State owned

None that is durable, and none that is shared. Everything held in a replica is a cache or a
connection:

| Held | Lifetime | Consequence of losing it |
|---|---|---|
| Resolution cache (sandbox → node, public ports) | Short TTL, in process | A cache miss and one lookup. |
| Verification key set | Cached with a bounded lifetime | Refetch; stale keys keep verifying meanwhile, which is why token verification survives a `control-plane` outage. |
| Local rate-limit buckets | Seconds | Limits briefly loosen for that replica. |
| Upstream connection pools | Process lifetime | Reconnect. |
| TLS session state | Per connection | Full handshake instead of resumption. |

This is what "stateless" means operationally: a replica that starts cold is fully useful
immediately, and no replica knows anything another replica needs.

## Host parsing

```
https://<port>-<sandbox-id>.<sandbox-domain>
```

The port and the sandbox identifier occupy **a single DNS label**, joined by a hyphen, rather
than being separate labels. This is forced by how wildcards match: a wildcard certificate and a
wildcard host rule each match exactly one label, so `*.sandboxes.example.com` covers
`3000-abc123.sandboxes.example.com` and does not cover `3000.abc123.sandboxes.example.com`.
Using a deeper subdomain would require either a certificate per sandbox or a multi-level
wildcard, and the first does not scale to sandbox churn while the second is not something the
certificate ecosystem grants.

Parsing is strict and total:

1. Lowercase the `Host` (or `:authority`) value and strip any port suffix.
2. Require the configured domain suffix exactly; anything else is refused without a lookup.
3. Split the remaining label at the **first** hyphen.
4. The left side must parse as an integer in the valid port range, with no leading zeros and no
   sign.
5. The right side must match `^[a-z0-9]{24}$`: the platform's
   24-character lowercase-alphanumeric NanoID. The alphabet **excludes the
   hyphen**, so a second hyphen anywhere in the label is a rejection.

That last clause is a decision about the format's future rather than a validation detail, and it
is made here rather than left implicit. Splitting at the first hyphen and accepting whatever
follows would work whether or not identifiers contain hyphens, but it spends the rest of the label
permanently: every hostname the platform has ever issued would have to be reinterpreted to add a
**third field**. A reference implementation's hostnames carry three, so the need is not
hypothetical — a region, a shard, or a routing hint is the ordinary reason. Excluding the hyphen
from the identifier alphabet costs nothing at mint time, makes today's parse unambiguous, and
makes a third field a compatible extension later, because labels carrying a second hyphen are
rejected now instead of meaning something. The exclusion has to hold where identifiers are minted
as well as here, or the parser rejects hostnames the platform itself issued.

The strict port parse means there is exactly one hostname per sandbox port rather than a family of
equivalent ones. Anything that fails these checks is rejected immediately, before any cache,
database, or node is touched, because the public wildcard domain receives a steady background of
scanning traffic and none of it should reach the datastore.

### The label is a fixed budget

Packing the port and the identifier into one label means the scheme is bounded by what a single
DNS label permits: **63 octets**, and only characters valid in a host label. Five for the port, a
hyphen, and the identifier must all fit, which caps the identifier length and rules out an
identifier alphabet containing anything a resolver or a certificate would reject. This is a
constraint on the identifier format itself rather than a validation detail, so it is asserted
where identifiers are minted as well as parsed here; discovering it later means changing the
public hostname of every sandbox.

### The wildcard certificate has an operational cost, and it is smaller than it first looks

A certificate covering `*.<domain>` cannot be issued by proving control of a single hostname over
HTTP, because there is no single hostname to prove. Wildcard issuance requires **DNS-based
validation**: a challenge record under the sandbox domain, at first issuance and at every renewal.

What it does not require is standing write access to the sandbox zone. The validation target is
**delegated once** — a single record published by hand at the sandbox domain, pointing at a zone
that exists only to answer challenges — and every renewal thereafter is validated in the delegated
zone without the sandbox domain being touched again. This is the ordinary way wildcard issuance is
automated rather than a refinement contingent on the provider, and it is how an installation is
expected to be set up. What the issuance process then holds is a credential for a zone containing
nothing but challenge records, rather than one that can redirect the sandbox domain wherever it
likes.

The resulting key is held by the issuance process and by no more of the system than needs it: a
`gateway` replica receives the certificate and key and nothing that could produce another, which
is consistent with this component holding no material beyond what the request in front of it
requires. A certificate per sandbox is not an alternative at sandbox churn rates.

The real alternative is to terminate TLS at the cloud load balancer, and a reference
implementation does exactly that — its proxy holds no key at all, and the wildcard certificate is
a property of the provider's configuration rather than of the deployment. On the security trade
alone that is the better answer; what decides against it here is the installation target. This
system installs into an existing Kubernetes cluster with one Helm chart and no cluster-wide
changes, on whatever the operator already runs; making TLS termination a managed load balancer's
feature makes the edge work on the providers that offer it in the shape we need and nowhere else,
including on-premises. Holding the certificate here keeps the component identical across
installations. An operator whose provider terminates TLS acceptably can still put it in front:
everything below the TLS acceptor behaves the same behind an already-terminated connection, since
routing reads the authority and never the TLS server name.

## Authorization

Every tenant application port is private by default. The owner may create a durable `public`
exposure record for one exact `(sandbox, port)`, which admits anonymous traffic to that port and
nothing else. The configured agent port is reserved and the control plane rejects exposure
records for it.

| Caller | Credential |
|---|---|
| Private port, SDK or programmatic client | Capability token in a request header |
| Private port, browser | Attenuated capability token in a cookie scoped to the sandbox's hostname |
| Public tenant application port | None |

For private traffic, verification checks the key ID against the cached key set, the signature,
expiry, sandbox, epoch, and port scope. Attenuated tokens can only narrow, so a cookie derived
from a full-access token cannot be replayed as one. For anonymous traffic, authorization checks
the active public-exposure record instead.

**No port is implicitly exempt.** Public access is a positive policy record created through the
control-plane API, defaulting off and written to audit. A management, agent, health, or debugging
port cannot acquire such a record.

This design is deliberate: exposure is per-port and default-private rather than a sandbox-wide
switch that defaults public. The node-side proxy stays authoritative, the management port
authenticates separately, and the decision is scoped to one tenant port at a time.

### Authorization is checked twice and credentials are stripped once

Authorization here is a filter, not the final decision. For private requests, `gateway` verifies
and **forwards the credential to the owning node**, which verifies it again and strips it before
anything reaches the guest. Public requests require no credential: `gateway` checks cached
exposure state and removes any platform token or cookie the caller happened to supply, while
`vm-host` independently checks its versioned state before opening the relay.

The collapse to avoid is making the edge authoritative. It neither strips private credentials nor
asserts that anonymous access passed. The node checks the original token or the exposure state
it received from the control plane. The hop is mutually authenticated in both cases: private
traffic carries a bearer credential, and public traffic still crosses a privileged internal
listener that must accept requests only from the gateway workload identity.

What must not happen is the credential travelling further than the node, and that is a threat-model
requirement rather than tidiness. The occupant of a sandbox is hostile and is root inside it, so
anything the request carries is readable by the tenant workload — and a capability token or session
cookie is not just readable but **replayable**: it is a bearer credential for that sandbox, valid
until its expiry, usable from anywhere. The browser case is worse than the SDK case, because a
browser attaches the cookie automatically to every subresource a sandbox page loads, so a hostile
page harvests a working credential without doing anything that looks like an attack. The
credential's purpose is discharged the moment the hop that can act on it has verified it; carrying
it past that hop buys nothing, because the guest performs no authorization and would not know what
to do with it.

### Why browsers need a different form at all

A browser cannot set headers on a WebSocket handshake, cannot set them on an image or stylesheet
fetched by a page loaded from the sandbox, and cannot set them on a navigation. Anything a
person opens in a browser therefore has to authenticate with something the browser attaches on
its own, which in practice means a cookie.

The exchange works like this:

1. A one-time link is issued carrying an attenuated token as a query parameter.
2. `gateway` validates it exactly as it validates any token.
3. On success it sets a cookie carrying that attenuated token, scoped to that sandbox's
   hostname — `Secure`, `HttpOnly`, and with no `Domain` attribute, so it is host-only.
4. It responds with a redirect to the same URL minus the credential.

Each step has a reason. The redirect exists so the credential does not persist in the address
bar, where it is copied into support tickets and shared in screenshots, and does not persist in
browser history, and is not sent onward in referrer headers to whatever the sandbox links to.
Access logs, at the load balancer and at every hop, record URLs, so a credential in a query
string is a credential written to durable logs by parties who did not intend to store secrets;
the redirect bounds that exposure to a single request with a single-use token.

The host-only scope is the part most easily got wrong. A cookie set for the parent domain would
be attached to requests for **every** sandbox on the domain, which hands each sandbox the
credentials of every other one the user has open — the occupant of a sandbox is hostile and can
read whatever the browser sends it. Omitting `Domain` confines the cookie to
`<port>-<sandbox-id>.<domain>`, so it is only ever sent to the sandbox it authorises. This is
also the reason the port shares a label with the identifier rather than being a path prefix:
cookie scoping is per host, not per path, so a path-based scheme could not isolate sandboxes
this way.

Once the cookie is set, **streaming upgrades inherit it automatically**, because a WebSocket
handshake is an ordinary HTTP request as far as cookie attachment is concerned. That is
precisely what makes browser-based live-reload work: a development server inside the sandbox
opens a WebSocket back to its own origin from a page the user is viewing, and the connection
authenticates without the page knowing anything about tokens.

### Host-only scoping stops reading, not sending

Host-only scoping solves exactly one problem: a page in one sandbox cannot obtain another
sandbox's cookie, because the browser will not send it there. It does **not** stop a page in one
sandbox from *causing* an authenticated request to another, and the gap is easy to miss because
the usual defence appears to be in place.

Every sandbox hostname is a subdomain of one registrable domain. Browsers group cookies by site,
which is the registrable domain, not by origin — so `3000-aaa.sandboxes.example.com` and
`8080-bbb.sandboxes.example.com` are **same-site** to a browser however unrelated they are to us.
The `SameSite` attribute keys on exactly that grouping, so it does not fire between two
sandboxes: a hostile page served by one sandbox can issue a request to another sandbox's hostname
and the browser will attach that sandbox's session cookie, because as far as it is concerned the
request never left the site.

Cross-origin resource sharing does not close this either, and assuming it does is the second half
of the mistake. **It governs whether the initiating page may read the response, not whether the
request is performed.** A request that writes a file, kills a process, or starts one has already
had its effect by the time the response is discarded.

Two mitigations, and both are needed because they fail differently.

- **Register the sandbox domain in the public suffix list.** Doing so makes each sandbox hostname
  its own site rather than a subdomain of a shared one, which makes `SameSite` behave the way it
  is usually assumed to and additionally prevents any cookie from being set at the parent domain
  at all. It is the structural fix. It is also slow: inclusion is a manual submission to a list
  maintained outside our control, propagates on browser release cycles, and cannot be relied on
  for an installation using its own domain.
- **Require the request's own origin to match its target for any cookie-authenticated request.**
  The `Origin` header, or the fetch-metadata headers where the browser sends them, state what
  initiated the request; a cookie-authenticated request whose initiator is not the target host
  itself is rejected before it is proxied. This is the control that actually ships, because it
  works on the first request, on every installation, and without depending on anyone else's
  release schedule. It applies only to the cookie form — token-bearing requests are unaffected,
  because a token is not attached automatically by a browser and forgery of it is not the threat.

### Browser sessions end when their credential does

A browser holds a short-lived attenuated token in a cookie and nothing else. It has no refresh
flow, no way to re-derive a credential, and no SDK to do it on its behalf — so **when the cookie
expires, or when the sandbox's epoch changes because it was paused, resumed, or checkpointed, the
browser session is over.** The next request gets a 401 and the person sees an error page rather
than a reconnect.

This is stated plainly rather than described as recoverable, because the refresh flow that
recovers the equivalent situation for SDK clients does not exist here. Recovery requires a new
one-time link from whatever issued the first one, which is a dashboard or an SDK call, not
anything this component can do: `gateway` never mints and never widens a credential, so it has no
way to produce a fresh token from an expired one. What it does do is return a distinguishable
status for the expired-session case, so an embedding dashboard can notice and issue a new link
automatically.

A re-exchange redirect — bouncing the browser to an endpoint that re-issues the cookie — is the
obvious alternative and is deliberately not built here. It would require this component either to
hold minting capability or to proxy a minting path, and the value of holding no signing key is
that a compromised edge replica cannot issue credentials. That property is worth more than
seamless browser sessions, so the limitation is accepted and documented instead of engineered
around at this hop.

### A shared host, if one is ever added, is token-only

Everything above rests on each sandbox having its own hostname. The session cookie is host-only,
which is precisely what confines it to one sandbox, and the origin check works because a
sandbox's own origin and its target are the same name.

There is a known alternative shape, and it exists for a real reason rather than as a shortcut: a
single shared hostname, with the target sandbox named in a request header instead of in the DNS
label, for clients that cannot arrange per-sandbox DNS or that sit behind something which will not
accept a wildcard certificate. A reference implementation offers both forms side by side. If this
one is ever added here, **the cookie form does not exist on it.** A cookie set on a shared host is
attached to every request that host receives, which is every sandbox behind it — the cross-sandbox
credential leak that host-only scoping exists to prevent, reintroduced wholesale. The origin check
cannot repair it either, because on a shared host every sandbox's origin *is* the target. A shared
host is therefore a token-only surface: header credential, no cookie, no one-time link exchange,
no browser navigation. That is written down now because the two mechanisms look compatible right
up to the moment someone combines them.

## Routing

### Routing is per request, never per connection

One certificate covers every sandbox hostname, and every one of those hostnames resolves to the
same load balancer address. Those two facts together mean browsers will **coalesce** requests for
different sandboxes onto a single connection: a client that has an open HTTP/2 connection to one
sandbox, and finds that a second sandbox's hostname is covered by the same certificate and
resolves to the same address, is entitled to reuse that connection rather than opening another.
It is a deliberate optimisation in the protocol, it is not a bug in the browser, and there is no
configuration on our side that prevents it.

The consequence is a rule about where routing information may come from. **The routing decision
is made per request, from the `Host` or `:authority` value, and never per connection from the TLS
server name.** A connection's server name records which sandbox the *first* request on it was for,
and after coalescing that tells us nothing about the rest. A proxy that routed on it would deliver
one sandbox's traffic to another sandbox's node, which is a cross-tenant data leak arrived at by
way of a performance feature.

The same reasoning extends to state, and this is the part that is easy to get wrong while getting
the routing right: **no per-connection routing or authorization state may be cached.** Not the
resolved node, not the verified token, not the sandbox identity, not a "this connection is
authorised" flag. Every request on a connection is parsed, authorised, and resolved on its own
terms, because the previous request on that connection may have been for an entirely different
sandbox and a different caller's credential. Caching by sandbox identifier is fine and is what
the resolution cache does; caching by connection is prohibited.

This is also why the layer order puts parsing first and holds no state between requests. The cost
is one string scan and one cache lookup per request, which is small, and it is what makes the
component's correctness independent of how a client chooses to multiplex.

`gateway` resolves the sandbox to its node from a cache, in three tiers: a short-TTL in-process
map, then Redis, then the durable record. The durable record is the truth; the other two exist
because a per-request round trip to PostgreSQL at data-plane rates is a poor use of the
database, and because losing Redis must cost latency rather than availability.

The same cache value carries the active set of public tenant ports and its policy revision.
Absence means private. `PUT` and `DELETE` exposure operations invalidate this value, and the
reconciler repairs it from PostgreSQL exactly as it repairs routes. This copy lets the edge reject
unauthorized private traffic cheaply; it is not an assertion the node trusts.

**The owning node is the final authority.** A cached route is a hint, and it can be wrong: a
sandbox can be paused, resumed onto another node, or destroyed between the moment an entry is
written and the moment it is read. So when the node reports that it does not hold the sandbox,
`gateway` invalidates its cached entry, re-reads the durable record, and retries — once, against
whatever the fresh answer says — rather than failing the request.

This is the correct division because the node cannot be wrong about the question in the way the
cache can. The cache says where the sandbox was; the node says whether it is there now. Trusting
the cache over the node would turn every resume onto a different node into a stream of errors
for the duration of a TTL, and shortening the TTL to compensate would put the load back on the
database. One retry against fresh state costs a round trip in a rare case and removes the whole
class of failure.

Retries are bounded to one and are not applied to requests that have already had bytes
forwarded, since a request that is partway through a stream cannot be replayed.

## Proxying

Interactive terminals, file watches, and live-reload connections are the product, not an
edge case, so the proxy is judged on what it does to long-lived and bidirectional traffic rather
than on request throughput.

| Requirement | Why it is non-negotiable |
|---|---|
| WebSocket upgrades pass through cleanly | PTY sessions and browser live-reload are WebSockets. |
| HTTP/2 is supported **at the edge** | Multiplexed streams and connection-level flow control are used by SDK clients on the hop they control. |
| Long-lived byte streams are never buffered | A terminal that appears only after the response completes is a broken terminal. |
| Half-close semantics are preserved | Sending EOF on stdin while continuing to read stdout is normal usage. |
| Backpressure propagates in both directions | Otherwise a slow reader is absorbed into gateway memory until the replica dies. |
| Idle timeouts are separate from total-duration timeouts | A stream can legitimately be open for hours while idle for seconds. |

Two of those pull against each other, and the resolution has to be deliberate. Preserving
half-close means an end-of-file from the client is a legitimate message — stdin is finished,
stdout continues — so it cannot double as the signal to tear the upstream leg down. A client that
was killed therefore looks exactly like one that finished sending, and left at that, its upstream
connection and the guest process behind it survive indefinitely, occupying a slot in the
per-sandbox cap the node maintains and consuming a descriptor at both ends. Detection comes from
the keepalives instead: a peer that stops answering pings is gone whatever its read side did, and
both legs are then closed. Read-EOF is a protocol event; only the keepalive is evidence about the
peer.

### HTTP/2 stops here

The protocol is **not** end to end, and treating it as though it were leads to promises the
system cannot keep. HTTP/2 is negotiated by ALPN on the client's TLS connection and terminates at
this component; the upstream hop to the owning node is **HTTP/1.1**, as [vm-host](vm-host.md)
states from its own side. Every request crossing that hop is an ordinary HTTP/1.1 request on its
own upstream connection.

The consequences are worth naming rather than leaving to be discovered:

- **Multiplexing is an edge-only property.** Ten concurrent SDK streams share one connection from
  the client to here, and become ten separate upstream connections from here to the node. The
  saving is real — it is on the leg with the round-trip times and the connection setup costs —
  but it is not a reduction in load on the node, and per-sandbox connection accounting has to be
  done against the upstream side, where the connections actually are — which is why the cap is
  the node's and not ours.
- **Flow control does not span the path.** HTTP/2 window updates govern the client hop only.
  End-to-end backpressure comes from the proxy propagating it between the two hops, which is why
  that is a separate non-negotiable requirement above rather than something the protocol
  provides.
- **WebSocket traffic is HTTP/1.1, plainly.** Carrying WebSockets over HTTP/2 requires extended
  connect support negotiated on *both* hops, and the upstream hop does not offer it. A browser
  or SDK may perform its WebSocket handshake over HTTP/2 to this component; what leaves for the
  node is an HTTP/1.1 upgrade. Anything reasoning about PTY sessions, live-reload connections, or
  file watches should reason about HTTP/1.1 upgrades, because that is what they are for all but
  the first hop.

### Idle timeouts increase along the path

Every hop has a server-side idle timeout: the cloud load balancer, this component, and the node.
**Each hop's timeout must exceed the one in front of it** — the gateway's exceeds the load
balancer's, and the node's exceeds the gateway's.

The ordering is not arbitrary, and getting it backwards produces an error that looks like a bug
somewhere else. Consider a gateway timeout shorter than the load balancer's. Both are counting
idle time on the same pooled connection and will reach their limits at nearly the same moment,
but the gateway reaches its limit first and begins closing. The load balancer, which has not yet
timed the connection out, dispatches a newly arrived request onto it. That request lands on a
connection in the middle of being closed, the load balancer observes the failure, and the client
receives a bad gateway for a request that nothing was actually wrong with. The failure is
intermittent, is proportional to traffic, and appears in the logs of a component that did nothing
incorrect. The same reasoning applies one hop further in, between this component's upstream pool
and the node's server.

Making the downstream side always the more patient party removes the race: whoever is in front
closes first, and the party behind never hands work to a connection that is going away. The
values are configured rather than derived, because the load balancer's timeout belongs to
whoever runs the installation, so the check that our timeouts exceed it is a startup validation
against configuration rather than something we can discover.

The ladder has four rungs and not three, because **there are two idle timeouts inside this
process** and they are offset from each other on purpose: the downstream one on the client
connection, which must exceed the load balancer's, and the upstream one on the connection to the
node, which must exceed the downstream one and stay below the node's. Configuring a single value
for both leaves the inner boundary uncovered and reproduces the same intermittent bad gateway one
hop further in. Two reference implementations arrive at this arrangement independently, which is
about as much validation as a convention of this kind is ever going to get.

The **total-duration** bound is deliberately not ours. A maximum connection lifetime, as distinct
from an idle timeout, is set on the load balancer, so a stream that stays busy indefinitely is
ended by the hop in front of us rather than by anything here. That is the right owner — it is a
property of the installation's ingress rather than of the proxy — and it is one more reason the
reconnect path has to work rather than being a recovery mechanism.

**Application-level keepalives are mandatory**, and this is a requirement on the product rather
than a tuning suggestion. Cloud load balancers enforce their own idle timeouts, configured by
whoever runs the installation and not necessarily by us, and a connection that carries no bytes
for long enough is cut without notice to either end. A periodic ping at the application layer
keeps the connection observably alive and, just as importantly, lets both ends detect a
half-dead path rather than waiting on TCP timeouts. `gateway` keeps its own keepalives on both
sides and does not suppress those flowing through it.

## Rate limiting

Authenticated requests are limited per token, sandbox, and source address. Anonymous public
requests have no token key and are limited per sandbox, public port, and source address. Local
token buckets perform the check; Redis makes the limits approximately global across replicas.

When Redis is unavailable, rate limiting **degrades to local buckets and keeps serving**. The
alternative — failing requests because the counter store is down — would put a cache in the
availability path of the data plane, which is the one thing this component must not do. The
consequence is that a limit can be exceeded by roughly the replica count during a Redis outage,
which is an acceptable overshoot for a mechanism whose purpose is to bound abuse rather than to
meter billing. Metering is not done here at all.

### A request-rate limit does not bound this workload, and the bound is not here

Rate limits bound how often a request may *start*. They say nothing about how many requests are
concurrently open, and the traffic this component exists to carry is long-lived streams: PTY
sessions, file watches, live-reload sockets, published-port connections. A caller can sit far
inside every configured rate while holding thousands of open streams, because it opened them
slowly. The resource being consumed — upstream connections, buffers, file descriptors on this
replica and on the node — is proportional to concurrency, and nothing above measures it.

The bound that does measure it is a **per-sandbox cap on concurrent connections, enforced on the
node**. `vm-host` terminates every one of those connections, so the count is a number one process
holds exactly; the cap is keyed by **sandbox identifier and epoch**, and it is released when the
sandbox's network slot is released. Epoch keying matters because a resumed sandbox is a new
instance whose predecessor's connections are already severed: an entry inherited from the previous
instance would charge the new one for streams that no longer exist, in the worst case leaving a
freshly resumed sandbox unable to accept a connection at all. Reaching the cap returns a 429 for
new connections while established ones continue, because shedding an in-progress terminal session
to admit a new one is the wrong trade. This component surfaces that answer; it does not compute
it.

Why it is not computed here is worth recording, because the edge is the reflexive place to put a
connection cap. Each replica sees only its own share, so an edge cap is a distributed counter —
summed through Redis — standing in for a quantity a single process already knows. It would put
Redis in the path of a decision this document insists must never depend on a cache, and it would
be wrong in the expensive direction: until Redis expires a dead replica's share, a sandbox is
charged for connections that no longer exist, which lands hardest on a sandbox that has just been
resumed. Rates stay here, where approximate is the correct answer and a Redis outage loosens a
bound instead of failing a request. Counting stays where the connections are.

## Error surfaces

The status codes are part of the contract, because SDK retry behaviour is written against them.

| Condition | Status | Retryable | Notes |
|---|---|---|---|
| Malformed or unknown hostname | 404 | No | Rejected before any lookup. |
| Anonymous request to an active public tenant port | Forwarded | — | No client credential is required; `vm-host` rechecks the exposure. |
| Missing token and no active public exposure | 401 | No, until re-authenticated or exposed | Returned identically whether the private sandbox exists or not. |
| Malformed or expired token | 401 | No, until re-authenticated | |
| Valid token, insufficient scope for this port | 403 | No | Distinguished from 401 so clients can tell "log in again" from "not permitted". |
| Epoch mismatch, token form (token predates a pause, resume, or checkpoint) | 401 | After refresh | The SDK refresh flow handles this transparently. |
| Epoch mismatch or expiry, cookie form | 401, with a distinguishing code | Not by the browser | A browser has no refresh path. The session is over; recovery is a new one-time link issued by whoever issued the first. The distinguishing code exists so an embedding dashboard can do that without a person retrying. |
| Unknown sandbox, for an authenticated caller | 404 | No | Only reachable once authorization has succeeded. |
| Sandbox is paused | 409 | After a resume | Signals a state that the caller can act on, not a transient fault. |
| Per-sandbox concurrent-connection cap reached | 429 | Yes, after a stream closes | Decided by the node, which owns the cap, and passed through unchanged. Established streams are unaffected; only new connections are refused. |
| Node unreachable or connection refused | 502 | Yes, with backoff | The node exists but did not answer. |
| Node reports it no longer holds the sandbox | Internal | — | Not surfaced: triggers a refresh and one retry. |
| No capacity or shedding | 503 | Yes, with backoff and `Retry-After` | |
| Guest port not listening | 502, with a distinguishing code | Yes | Retried at the node first; see below. Only surfaced once the node has given up. |

The identical response for an unauthenticated caller regardless of whether the sandbox exists is
the mechanism that satisfies the non-enumeration property in
[security](../architecture/security.md). It is easy to lose by adding a well-meaning "no such
sandbox" message, so the ordering of checks in the layer stack enforces it structurally rather
than relying on each handler to remember.

### A guest port that is still binding is retried at the node, not here

The most common transient error in normal use is a request arriving at a published port a moment
before the tenant's development server has finished binding to it. Retrying that here is possible
and is the wrong place: a retry from this component means the client waits for another full edge
round trip, or — if the error is surfaced instead — sees a bad gateway for a sandbox that is
working correctly and was simply one moment from being ready.

**The retry belongs at the node**, where the same attempt is a single local dial into the guest.
[vm-host](vm-host.md) performs a short, bounded retry on connection-refused before answering, so
the common case is absorbed at a cost measured in milliseconds and never reaches the client.
`gateway` surfaces the distinguishing 502 only when the node has exhausted that budget, at which
point the port genuinely is not listening and a retry from the client is the appropriate next
step. Placing a retry at both hops would multiply the two budgets together, so this hop does not
retry the case at all.

## Client attribution

The relay inside the guest dials the tenant's server over loopback, so everything the tenant's
application can observe about its peer says `127.0.0.1`. The headers this component sets are
therefore the only record of the real client that exists anywhere inside the sandbox, which makes
naming them part of the contract rather than leaving them to a proxy library's defaults.

`gateway` sets the **forwarded-client-address** header, carrying the address the connection
arrived from, and the **forwarded-host** header, carrying the hostname the client asked for. An
inbound copy of either is **replaced, not appended**. The convention elsewhere is to append and
build a chain, and it is wrong here: the caller is untrusted, the tenant is told the header is
trustworthy — which is only true because no other path into the guest exists — and a chain a
caller can prepend to is a forgeable client address delivered to the tenant's access log,
geolocation, and rate limiter.

The rest of that header family is deliberately not set, and the framework helper that emits the
whole family in one call is deliberately not used. The forwarded-protocol member in particular
makes several common application frameworks rewrite the `Location` header of their own redirects,
so a tenant's server begins emitting URLs it never constructed in response to a header it did not
ask for. A reference implementation avoids the same helper for the same reason. Two headers the
tenant may read are a smaller contract than a family that silently changes their application's
behaviour.

## Request identity

Every request carries an identifier: accepted from the client if supplied and well-formed,
generated otherwise. It is propagated as a header to the node, which includes it in its own logs
and in the sandbox operations it performs, and it is carried in trace context alongside it. It
is also returned to the client.

The result is that one identifier links the edge access log, the gateway trace span, the node's
log line, and the sandbox operation that ran — so a tenant reporting "this request hung at
14:03" can be answered by looking up one value rather than by correlating timestamps across
three components. Returning it to the client is what makes that possible without asking the
tenant to reproduce the problem.

## Concurrency and failure model

Each replica is an independent async server; there is no coordination between replicas and no
affinity requirement from the load balancer. Concurrency is bounded by connection limits and by
per-connection stream limits rather than by a global semaphore, and memory is bounded by the
absence of body buffering.

| Failure | Effect |
|---|---|
| A replica dies | The load balancer routes elsewhere. Connections on that replica drop; clients reconnect. |
| `control-plane` is entirely down | Traffic is unaffected. Tokens verify against the cached key set; routes resolve from cache and the durable record. |
| Redis is lost | Resolution falls through to the durable record; rate limits go local and loosen by roughly the replica count. Latency rises. The per-sandbox connection cap is unaffected, because it is the node's and never consulted a cache. |
| PostgreSQL is lost | Cached routes keep working; misses fail with 503. Existing streams are unaffected. |
| The key set cannot be refreshed | Verification continues against the cached set until its lifetime expires. |
| A node is unreachable | 502 for that sandbox only. Other sandboxes are unaffected. |
| A sandbox moved nodes | One refresh and one retry, transparently. |

Shutdown deserves one note. A replica receiving SIGTERM stops accepting new connections, but
long-lived streams cannot simply be held open indefinitely or a deploy never completes. They are
drained for a bounded period and then closed, which clients handle by reconnecting — the same
path they already take when a replica crashes or a load balancer recycles a connection. Because
the reconnect path must work anyway, it is exercised on every deploy rather than only during
incidents.

## Configuration

| Setting | Purpose |
|---|---|
| Sandbox domain | The wildcard suffix that hostnames must match. |
| TLS certificate source and reload policy | Wildcard certificate and key, reloaded without restart. |
| Upstream client identity | The workload identity and trust roots for the mutually authenticated hop to the node. Not a signing key. |
| Verification key set endpoint and cache lifetime | Where public keys come from and how long they remain usable. |
| Resolution cache TTL | Trade-off between staleness and lookup load. |
| Cookie attributes | Lifetime, and the `Secure`, `HttpOnly`, and no-`Domain` attributes for the browser session cookie. `SameSite` is set but is **not** the cross-sandbox control: every sandbox is same-site with every other until the domain is a public suffix. The control is the origin and fetch-metadata check below. |
| Cross-site request policy | Whether a cookie-authenticated request whose `Origin` or fetch-metadata headers do not match the target host is rejected. Rejection is the default and turning it off re-opens cross-sandbox request forgery. |
| One-time link acceptance window | How long an exchange link remains valid. |
| Upstream connect and header timeouts | Bound the time to first byte, separately from stream duration. |
| Load balancer idle timeout | The value configured on the load balancer in front of us. Recorded here so startup can validate the ladder. |
| Downstream idle timeout | On the client connection. Must exceed the load balancer's. Validated at startup against the recorded value. |
| Upstream idle timeout | On the connection to the node. Must exceed the downstream timeout and stay below the node's. |
| Keepalive interval | Application-level ping period on both sides, and the only evidence a peer is still there. |
| Rate limits | Per token, per sandbox, and per source address. The concurrent-connection cap is the node's. |
| Maximum header size and connection limits | Bound resource use from hostile callers. |
| HPA targets | Scale on connection count and CPU rather than request rate, given long-lived streams. |

## Observability

| Signal | Why it is exported |
|---|---|
| Request rate, error rate, and latency by outcome class | Baseline data-plane health. |
| Time to first byte, excluding stream duration | Stream lifetime would otherwise swamp any latency percentile. |
| Resolution cache hit ratio by tier | Detects a TTL that is too short or a cache that is not being populated. |
| Stale-route refresh-and-retry count | Small and steady is normal; a spike means routes are being invalidated en masse. |
| Authorization failures by reason | Separates expired tokens from scope violations from forged signatures. |
| Active upgraded connections and their age distribution | The population that a deploy will disturb. |
| Keepalive-detected disconnects | Reveals a load balancer idle timeout shorter than configured. |
| Bad-gateway responses correlated with connection age near an idle timeout | The signature of a timeout ordering inversion, which otherwise presents as an intermittent upstream fault with no cause. |
| Cross-site requests rejected, per target sandbox | Distinguishes a misconfigured tenant application from an actual cross-sandbox forgery attempt. Neither should be silent. |
| Cap rejections received from nodes, per sandbox | The limit that actually binds for streaming workloads. It is enforced on the node, and this is where its effect on clients is first visible. |
| Upstream errors by node | Isolates one sick node from a platform-wide fault. |
| Certificate expiry | A wildcard certificate expiring takes down the entire data plane. |

Tokens, cookie values, and one-time link parameters are redacted everywhere. Access logs record
the hostname and the sandbox ID but never the query string of an exchange request, which is the
specific case where a credential could otherwise be written to disk.

## Testing

The host parser is fuzzed and property-tested. It is the first thing every request touches and
it is exposed to the open internet, so the properties asserted are total ones: parsing never
panics, never allocates unboundedly, and accepts exactly the hostnames the scheme defines —
including the awkward cases of embedded hyphens, leading zeros in the port, uppercase input, and
a trailing dot.

Token verification is tested against a matrix of invalid credentials rather than only the happy
path: expired, wrong epoch, wrong sandbox, unknown key ID, valid signature over a widened scope,
a cookie replayed against a different sandbox's hostname, and a one-time link presented twice.
Exposure tests assert that absent records remain private, one public port does not expose another,
the reserved agent port is rejected, and switching a port back to private stops anonymous traffic.

Proxy conformance runs against a fake node that exercises the behaviours the table above calls
non-negotiable — upgrade handshakes, HTTP/2 multiplexing at the edge, half-close, slow readers to
confirm backpressure rather than buffering, and connections held open past the idle timeout to
confirm keepalives. One case is easy to omit because it looks like one already covered: a client
**killed** mid-stream, as distinct from one that half-closes, must have its upstream leg closed
off the back of a keepalive rather than being read as a half-close and held open forever. The
credential on a private request is asserted to reach the fake node intact, while a public request
arrives with no platform credential. A soak test runs streams for longer than any configured
timeout in the path.
Two properties are asserted that a single-request test cannot reach: a connection carrying
sequential requests for **different** sandboxes routes each one independently and re-authorises
each one, which is the coalescing case; and a configuration whose idle timeouts are ordered
incorrectly is rejected at startup rather than producing intermittent bad gateways under load.

The failure behaviours are injected rather than assumed: run with Redis absent, with PostgreSQL
absent, with `control-plane` absent, and with a node that accepts connections and then reports
that it does not hold the sandbox, asserting a refresh and exactly one retry.

## Rules that must not be violated

1. **No business logic.** No quota decisions, no metering, no template or artifact knowledge, no
   organisation model. If a change requires this component to understand the product, it belongs
   in [control-plane](control-plane.md).
2. **No port is implicitly exempt.** Anonymous access requires an active `public` exposure for
   that exact tenant port. Management, agent, health, and debugging ports are never eligible.
3. **`gateway` never mints or widens a credential.** It validates, and it copies an already-valid
   attenuated token into a host-scoped cookie. It holds no signing key.
4. **Session cookies are host-only.** No `Domain` attribute, ever. A cookie valid for more than
   one sandbox is a cross-sandbox credential leak — which is also why the cookie form exists only
   on a per-sandbox hostname, and why a shared host routing by header would be token-only.
5. **A cookie-authenticated request must originate from its own target host.** Same-site is not a
   boundary between sandboxes; the origin or fetch-metadata check is.
6. **The node independently authorizes every request.** Private requests carry the original
   credential for `vm-host` to verify and strip. Public requests require none; the edge removes
   any platform credential supplied accidentally and `vm-host` checks its own versioned exposure
   state. The edge never supplies an authorization assertion that the node trusts.
7. **Credentials never survive in a URL.** The one-time exchange always redirects to the clean
   URL, and exchange query strings are never logged.
8. **The client-attribution headers are set by us and never carried through.** An inbound
   forwarded-address value is replaced, because it is the guest's only source of client identity
   and an appended chain is a forgeable one.
9. **Routing is decided per request from the authority, never per connection from the TLS server
   name**, and no routing or authorization state is cached against a connection. Browsers coalesce
   different sandboxes onto one connection, and they are entitled to.
10. **The owning node is the final authority on residency.** A cache is refreshed and the request
    retried; the node's answer is never overridden.
11. **Each hop's idle timeout exceeds the timeout of the hop in front of it**, and the two
    timeouts inside this process count as two hops. Validated at startup, not left to convention.
12. **The component stays stateless.** Nothing may be introduced that one replica knows and
    another needs, and nothing that must survive a restart. A per-sandbox connection count is the
    example this rule exists to refuse; it belongs on the node.
13. **No Kubernetes object is created per sandbox**, for the reasons in
    [networking](../architecture/networking.md).
14. **Streams are never buffered end to end**, and backpressure is always propagated.
15. **Data-path availability never depends on a cache.** Losing Redis degrades latency and
    loosens rate limits; it does not fail requests.
16. **Responses never reveal the existence of a sandbox to an unauthorized caller.**
    Authorization is checked before resolution, structurally.
