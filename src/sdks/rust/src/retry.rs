//! Bounded exponential backoff with full jitter.
//!
//! Deliberately dependency-free: the jitter comes from a xorshift
//! sequence seeded from the clock rather than from a random-number crate
//! an SDK would otherwise not need. Backoff spacing is a scheduling
//! decision, not a cryptographic one, so a non-cryptographic generator
//! is the right tool.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Ceiling on the wait before the first retry.
const BASE: Duration = Duration::from_millis(250);

/// Multiplier applied once per attempt already made.
const FACTOR: u32 = 2;

/// Cap on the exponent, so a caller configuring a large retry budget
/// cannot grow the ceiling without bound.
const MAX_EXPONENT: u32 = 8;

/// How long to wait after `attempt` (zero-based) has failed.
///
/// Full jitter: uniform over `[0, BASE * FACTOR^attempt]`. Sleeping a
/// fixed backoff would realign every client that failed together into a
/// second thundering herd; spreading the wait is the point.
pub(crate) fn backoff(attempt: u32) -> Duration {
    let ceiling = BASE.saturating_mul(FACTOR.saturating_pow(attempt.min(MAX_EXPONENT)));
    let span = u64::try_from(ceiling.as_millis())
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    Duration::from_millis(next_random() % span)
}

/// The next value of a process-wide xorshift64 sequence.
fn next_random() -> u64 {
    static STATE: AtomicU64 = AtomicU64::new(0);

    let mut state = STATE.load(Ordering::Relaxed);
    if state == 0 {
        state = seed();
    }
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    STATE.store(state, Ordering::Relaxed);
    state
}

/// A non-zero seed derived from the wall clock. Zero would trap
/// xorshift at zero forever, so the low bit is forced.
fn seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    let mixed = u64::try_from(nanos % u128::from(u64::MAX)).unwrap_or_default();
    (mixed ^ 0x9e37_79b9_7f4a_7c15) | 1
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn backoff_stays_within_the_exponential_ceiling() {
        assert!(backoff(0) <= Duration::from_millis(250));
        assert!(backoff(1) <= Duration::from_millis(500));
        assert!(backoff(2) <= Duration::from_millis(1_000));
        // The exponent cap keeps a large retry budget bounded.
        assert!(backoff(u32::MAX) <= BASE.saturating_mul(FACTOR.pow(MAX_EXPONENT)));
    }

    #[test]
    fn backoff_is_jittered_rather_than_fixed() {
        let draws: BTreeSet<Duration> = (0..32).map(|_| backoff(3)).collect();
        assert!(
            draws.len() > 1,
            "expected jittered waits, got the constant {draws:?}"
        );
    }
}
