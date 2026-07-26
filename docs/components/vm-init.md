---
type: Component
title: vm-init
description: PID 1 inside every sandbox — mounts, hostname, zombie reaping, and supervision of vm-steward. Roughly 400 lines, and it must never exit.
tags: [component, guest, pid1, init, mounts, supervision]
timestamp: 2026-07-27T07:33:00Z
---

# vm-init

`vm-init` is the first process the guest kernel starts. It prepares the guest's filesystem and
cgroup hierarchy, starts [vm-steward](vm-steward.md), reaps whatever the kernel hands it, and
then does nothing else for the life of the sandbox.

It is roughly 400 lines, and the line count is a specification rather than an observation. This
component sits at a position where every bug is fatal: if PID 1 exits, the guest kernel panics,
and what happens next depends on a kernel command-line setting described in [what a kernel panic
actually does](#what-a-kernel-panic-actually-does) — either the sandbox is destroyed with every
tenant process inside it, or, worse, it hangs and leaks. The correct response to that risk is a
program small enough to be read end to end in one sitting.

## Purpose

Provide the minimum userspace environment that `vm-steward` and tenant processes need, and keep
`vm-steward` running.

### Why vm-steward is not PID 1

Merging the two would remove a process and a supervision loop, and it is the wrong trade.

`vm-steward` is a substantially larger program with an async runtime, a protocol decoder that
parses input from outside the guest, a PTY layer, and an inotify tree. Any of those can have a
bug. If the agent were PID 1, an agent panic would be a kernel panic, and a fault in the
component whose entire job is *observing and controlling* tenant processes would destroy the
tenant processes it was observing.

Keeping them separate converts that class of failure from fatal to degraded. The agent
crashes, `vm-init` restarts it, and the tenant's processes — which are in their own cgroup and
do not depend on the agent to keep running — carry on. The cost is one extra process and a
supervision loop that fits in a page of code.

The two obvious alternatives disagree with each other, and both disagreements point here.
Running a full service manager as PID 1 means spending the guest's life fighting one: units
masked purely to stop them slowing boot, watchdogs disabled because a pause makes a wall-clock
watchdog conclude that a healthy service hung, and the agent's own unit opting out of default
dependencies to hand-enumerate an ordering it never needed a graph for. Making the agent PID 1
instead buys a bespoke child-reaping problem, because the wildcard sweep and the targeted waits
then live in one process — exactly the race
[vm-steward](vm-steward.md#concurrency-and-failure-model) forbids, and one that is structurally
impossible here only because the wildcard reaper is this program and the targeted waits are in
another.

## Responsibilities

| Responsibility | Detail |
|---|---|
| Mounts | `/proc`, `/sys`, `/dev`, `/dev/pts`, `/dev/shm`, `/tmp`, `/run`, the cgroup2 hierarchy, and a bind mount over the kernel's boot identifier |
| cgroup2 preparation | Enable the controllers `vm-steward` needs in the root's `subtree_control` |
| Hostname | Set once at boot from the kernel command line. The per-instance name arrives later, in `vm-steward`'s post-restore payload, because PID 1 has no way to learn it |
| Reaping | Reap every orphaned child the kernel reparents to PID 1 |
| Supervision | Start `vm-steward`, restart it with backoff if it exits, with the backoff armed on a timer descriptor |
| Signals | Consume signals through a signalfd, forward termination signals to the child, and restore the mask and dispositions in the child before `exec` |
| Never exit | Under any circumstance |

### Mounts

| Path | Type | Why |
|---|---|---|
| `/proc` | procfs | Process enumeration, `/proc/self`, cgroup membership discovery |
| `/sys` | sysfs | Kernel and device attributes |
| `/dev` | devtmpfs | Device nodes without shipping a device manager |
| `/dev/pts` | devpts | PTY allocation for `vm-steward` |
| `/dev/shm` | tmpfs | POSIX shared memory, which several runtimes require to start at all |
| `/tmp` | tmpfs | Scratch space |
| `/run` | tmpfs | PID files, sockets, and lock files, which essentially every daemon in a modern base image expects to find writable |
| `/sys/fs/cgroup` | cgroup2 | The unified hierarchy the tenant cgroup is created under |
| `/proc/sys/kernel/random/boot_id` | bind | A writable file placed over a read-only one, so the boot identifier can be made per-sandbox after a restore |

`/tmp` as tmpfs is a deliberate trade with a visible cost. Writes to it never enter the disk
image, which keeps snapshot disks smaller and avoids charging a tenant's scratch files to a
durable artifact — but they do occupy guest RAM, and guest RAM is what a memory snapshot
captures. Large scratch files therefore move cost from the disk image to the memory image
rather than eliminating it. This is the right default because scratch data is usually small and
usually worthless, but it is not free.

`/run` is the dullest entry in that table and the easiest one to leave out. Without it, the PID
files, sockets, and lock files a base image's daemons expect either land on the root filesystem
or fail outright, one service at a time and with nothing that identifies the common cause — and
because a failed mount is logged and boot continues, which is the right behaviour for everything
else here, its absence presents as an image that half-works for reasons nobody inside the guest
can explain. It is a tmpfs on the same terms as `/tmp`, and for the same reason: this content
belongs in neither the disk image nor a durable artifact.

The cgroup2 hierarchy is mounted here, in PID 1, rather than by the agent, because the agent
may be restarted and must find the hierarchy already present and already configured. Enabling
controllers is a one-time act and belongs with the other one-time acts.

**The last row is not a mount the guest needs. It exists so that something else can be written
later.** The kernel initialises `/proc/sys/kernel/random/boot_id` with a random string at boot
and makes it read-only afterwards, so every sandbox restored from one template reads the same
boot identifier and no write anywhere can change that; the only thing that alters what a reader
sees is a bind mount of another file over it
(`references/firecracker-docs/snapshotting/random-for-clones.md:150-155`). `vm-init` performs
that mount at boot, and [vm-steward](vm-steward.md#post-restore-hook) writes a fresh value into
the file underneath it in the post-restore hook. The split follows from what each program can
do: mounting is a one-time act, which is this program's whole category of work, and at restore
PID 1 is asleep with no channel to the host, so it could not supply the second half even if it
were asked to. Its position in the list is not free either — the bind source is a file on `/run`
and the target is under `/proc`, so it can only be made once both of those exist, which is why
it is last.

Its failure is the one in this table that is not merely degrading. Every other mount going
missing produces a guest that half-works and says so; this one produces a guest that works
perfectly while every sandbox from the template shares a boot identifier and the hook's write
lands in a file nobody reads. It is therefore named separately in the startup report rather than
folded into a count of failed mounts, and the template build asserts the mount is present in the
published image — see
[template-builder](template-builder.md#identity-and-entropy-hygiene-before-anything-is-captured).

## Explicit non-responsibilities

| Not responsible for | Why |
|---|---|
| Being an init system | No units, no targets, no dependency graph, no socket activation, no service ordering language. There is exactly one service. |
| Configuration | No configuration file and no configuration format. Behaviour is fixed at build time; the hostname comes from the kernel command line. |
| Networking | Guest addressing is fixed and identical in every sandbox by design — see [networking](../architecture/networking.md) — so there is nothing to configure at boot. |
| Logging infrastructure | Plain lines to stderr, which the kernel console carries out to `vm-host`. No log levels to configure, no rotation, no sinks. |
| Lifecycle decisions | It never decides that a sandbox should stop. The host is authoritative. |
| Talking to the host | It has no vsock connection, no protocol implementation, and no awareness that a host exists. |
| Snapshot awareness | It has none, and needs none. The one mount it makes for the restore path's benefit is made unconditionally at boot and requires no knowledge of what it is for. See [across a snapshot](#across-a-snapshot). |

## Internal structure

Single-threaded and blocking. There is no async runtime, because a program with one child and
one event source does not need a scheduler.

```
main
 ├─ mount table          (fixed list, applied in order, failures logged not fatal)
 ├─ cgroup2 subtree_control
 ├─ sethostname          (from /proc/cmdline)
 ├─ block signals, open signalfd
 ├─ open timerfd         (armed only while a restart is pending)
 ├─ spawn vm-steward
 └─ loop forever
      └─ poll(signalfd, timerfd)
           ├─ signalfd readable
           │    ├─ SIGCHLD  → waitpid(-1, WNOHANG) until drained
           │    │              ├─ pid == child → arm the timerfd for the backoff interval
           │    │              └─ otherwise    → an orphan; discard the status
           │    └─ SIGTERM/SIGINT → forward to the child, keep looping
           └─ timerfd expired → spawn vm-steward, disarm
```

The loop has no exit condition. That is not an oversight to be tidied up later; it is the
component's central invariant.

**It polls two descriptors rather than reading one, and that is load-bearing rather than
stylistic.** A blocking read on a signalfd has no timeout. A restart scheduled for two seconds'
time would therefore not happen in two seconds; it would happen when the next signal arrives,
which in a quiet sandbox may be never — so the agent stays dead and the backoff is silently
unimplemented. The timer has to be an event in the same wait, which means a timer descriptor in
the poll set.

Sleeping for the backoff interval instead would be simpler and wrong for a different reason.
PID 1 asleep is PID 1 not reaping, so every orphan the guest produces during the sleep stays a
zombie holding a pid slot — and the backoff is longest exactly when the agent is crash-looping,
which is when nothing else in the guest is collecting anything.

## Interfaces

| Direction | Interface |
|---|---|
| In | Kernel command line (`/proc/cmdline`) for the hostname |
| In | Signals, consumed through a signalfd rather than handlers, so delivery is a readable event in the loop rather than an interruption of arbitrary code |
| In | A timer descriptor, so a scheduled restart is a readable event in the same wait |
| Out | `vm-steward` as a child process, with stderr inherited and the signal mask restored |
| Out | stderr to the guest console |

It exposes no API of any kind. Nothing connects to `vm-init`.

## State owned

| State | Notes |
|---|---|
| The supervised child's pid | The only pid it tracks; everything else is an orphan to be reaped and forgotten |
| Restart backoff interval and last-start instant | Measured on the monotonic clock; the interval is armed on a timer descriptor rather than held as a deadline to be checked |
| Whether mount setup succeeded | Reported once at startup for diagnosis |

That is the complete list. There is no state to persist, no state to recover, and no state that
outlives the process — because the process does not end.

## Key flows

### Boot

Mounts, controllers, hostname, signal setup, spawn, loop. Each mount failure is logged and the
sequence continues. Aborting on a failed mount would be the intuitive behaviour and it is
wrong: a guest missing `/dev/shm` is degraded and diagnosable, while a guest whose PID 1 exited
is a kernel panic — and therefore either a sandbox that vanished or one that hangs, depending on
a command-line setting it is too late to change. Degraded and loud beats dead and quiet, every
time.

### Spawning the agent

One detail of the spawn has caused more confusion than the rest of this program put together,
and it is invisible from anywhere near where it hurts.

`vm-init` blocks every signal it intends to consume through the signalfd, and **a blocked signal
mask survives `execve`**. Unless the mask is explicitly restored between the fork and the exec,
`vm-steward` starts with every signal blocked — and because the mask keeps surviving each
subsequent exec, so does every tenant process the agent goes on to spawn. What an operator
observes is a tenant shell that ignores interrupt and terminate, several layers away from the
program responsible, with nothing in that shell's own configuration to explain it.

The obligation belongs here because this is where the mask originates: **restore the signal mask
and reset dispositions to their defaults between fork and exec.** Dispositions need saying
separately, because `execve` resets installed handlers but leaves signals set to *ignore*
ignored, which makes an inherited ignore exactly as durable as an inherited block.
[vm-steward](vm-steward.md) repeats the reset in its own pre-exec hook, and that is a second
line of defence rather than the fix — an agent correcting PID 1's mask on every spawn is
carrying a bug whose source it cannot see.

### Supervision and restart backoff

When the child exits for any reason, `vm-init` restarts it after a delay that grows
exponentially to a cap, and resets to the minimum once the child has stayed up for a stable
interval. It never stops trying.

Giving up would be a lifecycle decision, and lifecycle decisions belong to the host. A sandbox
whose agent cannot start presents to `vm-host` as a sandbox that never answers the handshake,
and the host destroys it from outside after its own timeout. `vm-init` does not need to know
that, and encoding a "too many failures" policy here would put a second, uncoordinated opinion
about sandbox death inside the guest — the one place we are least able to change it, since this
binary is sealed into templates alongside the agent.

Backoff is measured on the **monotonic clock**, deliberately. The monotonic clock does not
advance while the VM is paused, so a sandbox paused for a week during a crash loop resumes with
its backoff where it left off rather than concluding that the child has been stable for a week.
It is also unaffected by the realtime clock step that `vm-steward` performs in its post-restore
hook, which would otherwise jerk a wall-clock-based timer by however long the pause lasted.

### Reaping

Every process in the guest whose parent dies is reparented to PID 1, and if PID 1 does not
reap it, it stays as a zombie holding a pid slot. `vm-steward` sets itself as a child subreaper
so most of a tenant's tree reparents to the agent instead, but the agent can crash, and when it
does its entire surviving descendant tree lands here.

So the `SIGCHLD` handling drains `waitpid` in a loop rather than reaping one child per signal.
Signals are not queued: several children exiting in quick succession can produce a single
`SIGCHLD`, and a loop that reaps once per signal leaks zombies under exactly the burst
conditions where a tenant is most likely to be spawning many short-lived processes.

### Signal forwarding

PID 1 is special-cased by the kernel, but the special case is narrower than the usual summary of
it, and the gap between the two is the reason for the no-panic rule.

What the kernel discards is **userspace-sent** signals whose disposition is the default action,
and only while PID 1 carries the flag that marks it unkillable. So an init that installs no
handling does silently ignore a `SIGTERM` sent with `kill`, which is a confusing thing to debug
from outside; `vm-init` installs explicit handling for the termination signals and forwards them
to the child so a graceful stop reaches the agent — and then keeps looping, because forwarding a
termination signal is not a reason to terminate.

**This is not immunity, and treating it as immunity is how the rule below gets rationalised
away.** The kernel clears the unkillable flag on the forced-signal path, which is the path it
uses for faults a process inflicts on itself. A segmentation fault, a bus error, an illegal
instruction, or a floating-point exception raised by the kernel against PID 1 kills PID 1. The
protection covers precisely the case that is not this program's risk — a stray `kill` from
somewhere in the guest — and precisely fails to cover the case that is: a fault produced by a
bug in these 400 lines. That is why the discipline in the failure model below is written as an
absolute rather than as a preference.

### Across a snapshot

`vm-init` does nothing across a pause and a restore, and knows nothing about either. It is a
sleeping process blocked in its poll, its memory is captured with everything else, and after the
restore it is a sleeping process blocked in the same poll. There is no hook, no notification,
and no reconnection.

This is the desirable outcome and it is worth naming, because "does nothing" is only correct if
nothing it holds is invalidated by the pause. Its state is a pid, an interval, a monotonic
timestamp, and a timer armed on the monotonic clock — none of which the pause touches. The timer
is the one worth checking rather than assuming: because it is armed on a clock that does not
advance while the VM is paused, a restart pending at pause time is still pending after the
restore with the same interval left to run, which is exactly the behaviour a crash-looping
sandbox should resume with. Had it held a connection, a file lease, or a
wall-clock deadline, it would have needed a restore hook, and the component whose defining
property is that it must never fail would have acquired a failure mode.

## Concurrency and failure model

There is no concurrency. One thread, one loop, one child.

| Failure | Behaviour |
|---|---|
| A mount fails | Logged; setup continues; the guest runs degraded |
| The boot-identifier bind mount fails | Handled the same way — logged, setup continues — but reported as its own condition, because what follows is a boot identifier shared across every clone rather than a guest that visibly half-works |
| `vm-steward` exits or crashes | Restarted with backoff, indefinitely |
| `vm-steward` cannot be spawned at all | Same path; the host eventually destroys the sandbox from outside |
| An orphan storm | Drained by the `waitpid` loop |
| An unexpected internal error | Logged; the loop continues |

The last row is enforced structurally. The loop body is written to avoid panicking constructs
entirely — no indexing, no unwrapping of runtime values, no arithmetic that can overflow into a
panic — and is additionally wrapped so that an unforeseen panic degrades into a logged error
and another iteration rather than into process exit. A Rust binary that aborts on panic would,
as PID 1, abort the entire sandbox; that outcome must not be reachable from any code path in
this file.

### What a kernel panic actually does

The rule "PID 1 must never exit" is usually justified with "otherwise the kernel panics and the
sandbox dies", and the second half of that is not automatically true.

A panicking kernel's default behaviour is to **stop**. It prints the panic and then spins
forever; nothing exits. From outside, the microVM is still there — the VMM process is running,
guest memory is still allocated and still charged to the node, and the sandbox holds its slot
indefinitely while doing nothing at all. That is not a dead sandbox, it is a leaked one, and it
is the worse of the two outcomes: a sandbox that dies is reported, while a sandbox that hangs
has to be noticed.

The fix is a **panic timeout on the guest kernel command line**, which makes the kernel reboot
after the delay rather than spin. The VMM does not implement guest reboot as a reboot: it treats
the guest reset as termination and exits. A guest kernel panic therefore becomes a VMM process
exit, which [vm-host](vm-host.md) already watches for and already knows how to clean up after,
and the panic text is on the console, which it already captures — so the sandbox goes away and
the reason for it outlives the sandbox.

The command line is part of the sealed template contract, so this is an assertion the template
build makes, alongside the guest kernel requirements listed in
[vm-protocol](vm-protocol.md#the-guest-kernel-is-part-of-the-sealed-contract). It cannot be
corrected on a running fleet, and the sandboxes that would demonstrate the omission are exactly
the ones nobody is looking at.

## Configuration

None.

| Input | Source |
|---|---|
| Hostname at boot | Kernel command line. Replaced per instance by [vm-steward](vm-steward.md) at restore |
| Everything else | Compile-time constants |

There is no configuration file, no environment-based tuning, and no runtime knobs. A
configuration surface here would be a surface sealed into every template, unchangeable after
the fact, and capable of producing a guest that fails to boot for a reason nobody can inspect.

## Observability

Plain text lines on stderr, inherited by `vm-steward` as well, carried out on the guest console
and captured by `vm-host`. Nothing else: no metrics, no health endpoint, no listening socket.

The console is a shared, low-bandwidth channel, so output is limited to events that matter:
the mount results at startup, every agent start and exit with its status, each backoff
interval, and any signal forwarded. In a healthy sandbox this produces a handful of lines at
boot and silence thereafter, which makes the presence of output at all a useful signal.

## Testing

| Layer | What it covers |
|---|---|
| Unit | Command-line parsing, backoff arithmetic including the stability reset and the cap |
| In-VM | Boots a real microVM in CI and asserts the mount set, the enabled cgroup controllers, and the hostname. The boot-identifier bind mount is asserted by writing the backing file and reading the change back through the procfs path, since the mount being present and the mount being effective are different facts |
| Supervision | Kills `vm-steward` repeatedly, including immediately after each restart, and asserts it always comes back *on schedule in an otherwise silent guest* — the case a signalfd-only loop fails, because nothing wakes it |
| Reaping | Spawns a tree of processes, kills the intermediate parents, and asserts no zombies remain, including while a restart backoff is pending |
| Signals | Asserts `SIGTERM` reaches the child, that PID 1 is still alive afterwards, and that the child starts with an empty signal mask and default dispositions |
| Panic | Boots an image whose PID 1 faults deliberately, and asserts the VMM process exits rather than the guest hanging with its memory still allocated. This is the assertion that the panic timeout is genuinely on the command line |
| Invariant | Every test asserts, as a postcondition, that PID 1 is still running |

The last row is the important one. It is cheap to assert everywhere, and it is the only
assertion whose failure means the sandbox no longer exists.

## Rules that must not be violated

1. **It must never exit.** If PID 1 exits the guest kernel panics, which destroys the sandbox
   when the panic timeout is set and hangs it when it is not. There is no error condition that
   justifies either outcome.
2. **It must never panic, and must never fault.** A `kill` from inside the guest cannot take
   PID 1 down; a segmentation fault, bus error, illegal instruction, or floating-point exception
   produced by its own bug can, because the kernel clears the unkillable flag to deliver one.
3. **It must never stop restarting `vm-steward`.** Giving up is a lifecycle decision, and
   lifecycle belongs to the host.
4. **It must never grow a configuration surface.** Configuration here is sealed into every
   template forever.
5. **It must never become an init system.** One service, one loop, no dependency graph.
6. **It must never talk to the host.** No protocol, no vsock, no awareness of anything outside
   the guest.
7. **It must always drain `waitpid`,** never reap one child per `SIGCHLD`.
8. **It must restore the signal mask and dispositions between fork and exec.** The mask it
   blocks for its own signalfd otherwise propagates to the agent and to every tenant process
   after it.
9. **It must never block waiting on one descriptor when a timer is pending.** A scheduled
   restart is an event in the poll set, never a sleep, because a sleeping PID 1 is a PID 1 that
   is not reaping.
10. **It must stay small enough to read in full.** A reviewer who cannot hold the whole program
    in their head cannot verify the rules above.
