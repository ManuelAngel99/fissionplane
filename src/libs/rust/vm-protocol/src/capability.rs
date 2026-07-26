//! The agent capability bitset, exchanged in `HelloAck`.
//!
//! Capability negotiation replaces version comparison because a sealed
//! agent means the host must speak to agents older than itself
//! indefinitely, and capability is not totally ordered. Bits are
//! permanent: a retired feature retires its bit forever, and a number is
//! never reused — reusing one would make an old agent's honest
//! advertisement into a lie.
//!
//! Presence is strictly bit-driven. The host may *subtract* bits an agent
//! advertises (the quarantine list, keyed by build id); it may never
//! *add* a bit the agent did not claim.

/// The bitset. `Default` is the empty set.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Capabilities(u64);

impl Capabilities {
    /// Spawn, attach, stdin, signals, PTY resize, wait, process list.
    pub const PROCESSES: u64 = 1 << 0;
    /// Stat, list, mkdir, move, remove, chunked read and write.
    pub const FILESYSTEM: u64 = 1 << 1;
    /// Recursive inotify subtree watches with overflow reporting.
    pub const WATCH: u64 = 1 << 2;
    /// Loopback port relay and listening-socket enumeration.
    pub const RELAY: u64 = 1 << 3;
    /// Guest statfs and the used-versus-page-cache memory split: the two
    /// figures a host cannot obtain from outside the guest.
    pub const STATS: u64 = 1 << 4;
    /// FreezeFilesystem / ThawFilesystem. Never used around a memory
    /// capture.
    pub const FS_FREEZE: u64 = 1 << 5;

    /// The empty set.
    pub const fn empty() -> Self {
        Self(0)
    }

    /// Wrap a raw bitset, e.g. one decoded from the wire.
    pub const fn from_bits(bits: u64) -> Self {
        Self(bits)
    }

    /// The raw bitset.
    pub const fn bits(self) -> u64 {
        self.0
    }

    /// Whether `bit` is set.
    pub const fn contains(self, bit: u64) -> bool {
        self.0 & bit != 0
    }

    /// Union with a bit.
    pub const fn with(self, bit: u64) -> Self {
        Self(self.0 | bit)
    }

    /// Subtract bits. The only sanctioned behavioural use of the build
    /// identifier: the host-side quarantine list subtracts bits a build
    /// advertises. Subtracting is always safe; adding never is.
    pub const fn without(self, bits: u64) -> Self {
        Self(self.0 & !bits)
    }
}

impl std::fmt::Debug for Capabilities {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        const NAMES: [(u64, &str); 6] = [
            (Capabilities::PROCESSES, "PROCESSES"),
            (Capabilities::FILESYSTEM, "FILESYSTEM"),
            (Capabilities::WATCH, "WATCH"),
            (Capabilities::RELAY, "RELAY"),
            (Capabilities::STATS, "STATS"),
            (Capabilities::FS_FREEZE, "FS_FREEZE"),
        ];
        let mut list = f.debug_set();
        for (bit, name) in NAMES {
            if self.contains(bit) {
                list.entry(&name);
            }
        }
        let unknown = self.0 & !NAMES.iter().fold(0u64, |acc, (bit, _)| acc | bit);
        if unknown != 0 {
            list.entry(&format_args!("UNKNOWN({unknown:#x})"));
        }
        list.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_round_trip() {
        let caps = Capabilities::empty()
            .with(Capabilities::PROCESSES)
            .with(Capabilities::RELAY);
        assert!(caps.contains(Capabilities::PROCESSES));
        assert!(caps.contains(Capabilities::RELAY));
        assert!(!caps.contains(Capabilities::WATCH));
        assert_eq!(Capabilities::from_bits(caps.bits()), caps);
    }

    #[test]
    fn quarantine_only_subtracts() {
        let caps = Capabilities::empty()
            .with(Capabilities::PROCESSES)
            .with(Capabilities::FS_FREEZE);
        let quarantined = caps.without(Capabilities::FS_FREEZE);
        assert!(quarantined.contains(Capabilities::PROCESSES));
        assert!(!quarantined.contains(Capabilities::FS_FREEZE));
    }

    #[test]
    fn debug_names_known_bits() {
        let caps = Capabilities::empty().with(Capabilities::STATS);
        let text = format!("{caps:?}");
        assert!(text.contains("STATS"), "unexpected debug output: {text}");
    }
}
