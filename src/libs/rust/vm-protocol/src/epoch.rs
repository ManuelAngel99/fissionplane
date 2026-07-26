//! Epoch semantics.
//!
//! Every sandbox instance carries an epoch, assigned by the host at the
//! handshake. It advances whenever a new sandbox instance is created — a
//! resume is one, and so is a checkpoint — and it deliberately does not
//! advance when vm-host merely restarts and adopts a running sandbox.
//! Operations tagged with a stale epoch fail closed, without any
//! revocation list, because an operation issued before a pause must never
//! apply to a sandbox generation that no longer expects it.

/// The outcome of comparing a presented epoch against the current one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochVerdict {
    /// Equal to the current epoch: joins the session.
    Join,
    /// Greater than the current epoch: supersedes it and becomes current.
    /// Frames still arriving under the previous epoch are rejected from
    /// this moment.
    Supersede,
    /// Lower than the current epoch: rejected with STALE_EPOCH and the
    /// connection is closed. A lower epoch can only be a stale host or a
    /// forged frame, and admitting it would let an operation from a
    /// previous generation execute against the current one.
    RejectStale,
}

/// Epochs are monotonic. The asymmetry is the safe direction: a lower
/// epoch can only be stale, and a higher one can only come from a host
/// that has moved the sandbox forward, which the agent is in no position
/// to argue with.
pub fn evaluate(current: u64, presented: u64) -> EpochVerdict {
    if presented < current {
        EpochVerdict::RejectStale
    } else if presented > current {
        EpochVerdict::Supersede
    } else {
        EpochVerdict::Join
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotonic_rules() {
        assert_eq!(evaluate(10, 10), EpochVerdict::Join);
        assert_eq!(evaluate(10, 11), EpochVerdict::Supersede);
        assert_eq!(evaluate(10, 9), EpochVerdict::RejectStale);
    }
}
