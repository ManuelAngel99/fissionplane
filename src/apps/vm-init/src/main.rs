//! vm-init: PID 1 inside every sandbox.
//!
//! It prepares the guest's filesystem and cgroup hierarchy, starts
//! vm-steward, reaps whatever the kernel hands it, and then does nothing
//! else for the life of the sandbox. The central invariant: it never
//! exits, and it never panics — if PID 1 dies, the guest kernel panics
//! (docs/components/vm-init.md).
//!
//! The event loop is single-threaded and blocking: mount table, cgroup2
//! controllers, hostname, signalfd + timerfd in one poll set, spawn,
//! reap, supervise. It is Linux-only by construction (signalfd, timerfd,
//! mounts, cgroup2). The portable logic — restart backoff — lives in its
//! own module and is tested on any platform.

#![forbid(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

// `expect` rather than `allow`: when the supervision loop lands and
// starts constructing `Backoff`, this attribute itself becomes an error
// and gets removed with the change that fulfils it. Test builds are
// excluded because the module's own unit tests already use it there.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "used by the supervision loop, which lands with the Linux syscall layer"
    )
)]
mod backoff;

// `expect` rather than `allow`: when the mount setup lands and starts
// iterating `MOUNTS`, this attribute itself becomes an error and gets
// removed with the change that fulfils it.
#[cfg(target_os = "linux")]
#[expect(
    dead_code,
    reason = "consumed by the mount setup, which lands with the Linux syscall layer"
)]
mod mount_table {
    /// The fixed mount table, applied in order. The bind mount over the
    /// kernel's boot identifier is last because its source lives on `/run`
    /// and its target under `/proc`, so both must exist first; it exists so
    /// the post-restore hook can give every sandbox its own boot identifier
    /// by writing into the file underneath.
    const MOUNTS: &[Mount] = &[
        Mount::new("/proc", "procfs"),
        Mount::new("/sys", "sysfs"),
        Mount::new("/dev", "devtmpfs"),
        Mount::new("/dev/pts", "devpts"),
        Mount::new("/dev/shm", "tmpfs"),
        Mount::new("/tmp", "tmpfs"),
        Mount::new("/run", "tmpfs"),
        Mount::new("/sys/fs/cgroup", "cgroup2"),
        Mount::new("/proc/sys/kernel/random/boot_id", "bind"),
    ];

    /// One row of the boot-time mount table.
    #[derive(Clone, Copy, Debug)]
    struct Mount {
        path: &'static str,
        kind: &'static str,
    }

    impl Mount {
        const fn new(path: &'static str, kind: &'static str) -> Self {
            Self { path, kind }
        }
    }
}

#[cfg(target_os = "linux")]
fn main() {
    // The supervision loop (signalfd + timerfd in one poll set, spawn
    // with the signal mask restored, waitpid drained in a loop) lands
    // with the Linux syscall layer. It is deliberately not sketched in
    // another language's idiom first: the whole program is ~400 lines
    // and is written to be read end to end in one sitting.
    eprintln!("vm-init: linux entrypoint not yet implemented");
    // Sanctioned exit: this is a placeholder for code that has not
    // landed. The real event loop never reaches an exit path — if PID 1
    // dies, the guest kernel panics.
    #[allow(clippy::exit)]
    std::process::exit(1);
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("vm-init only runs as PID 1 on Linux");
    // Sanctioned exit: not-Linux means not-PID-1; there is no sandbox
    // whose lifecycle this could belong to.
    #[allow(clippy::exit)]
    std::process::exit(1);
}
