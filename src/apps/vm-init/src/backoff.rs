//! Restart backoff for the supervised child.
//!
//! Rules (docs/components/vm-init.md): when the child exits, restart it
//! after a delay that grows exponentially to a cap, and reset to the
//! minimum once the child has stayed up for a stable interval. It never
//! stops trying — giving up would be a lifecycle decision, and lifecycle
//! belongs to the host.
//!
//! Everything here is measured on the monotonic clock (`Instant`),
//! deliberately: the monotonic clock does not advance while the VM is
//! paused, so a sandbox paused for a week during a crash loop resumes
//! with its backoff where it left off rather than concluding the child
//! has been stable for a week. It is also unaffected by the realtime
//! clock step vm-steward performs in the post-restore hook.

use std::time::{Duration, Instant};

/// Exponential backoff with a stability reset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    min: Duration,
    max: Duration,
    stable: Duration,
    delay: Duration,
    last_start: Option<Instant>,
}

impl Backoff {
    /// `min`: delay before the first restart. `max`: cap on growth.
    /// `stable`: uptime after which the delay resets to `min`.
    pub fn new(min: Duration, max: Duration, stable: Duration) -> Self {
        Self {
            min,
            max: max.max(min),
            stable,
            delay: min,
            last_start: None,
        }
    }

    /// Record a (re)start of the child at `now`.
    pub fn record_start(&mut self, now: Instant) {
        self.last_start = Some(now);
    }

    /// The child exited at `now`. Returns how long to wait before the
    /// next start. If the child stayed up for the stable interval, the
    /// delay first resets to the minimum; otherwise it doubles, capped.
    pub fn child_exited(&mut self, now: Instant) -> Duration {
        if let Some(started) = self.last_start
            && now.duration_since(started) >= self.stable
        {
            self.delay = self.min;
        }
        let wait = self.delay;
        self.delay = std::cmp::min(self.delay.saturating_mul(2), self.max);
        wait
    }

    /// The delay that would be applied to a failure right now, without
    /// changing state. For diagnostics only.
    pub fn current_delay(&self) -> Duration {
        self.delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_millis(100);
    const MAX: Duration = Duration::from_secs(5);
    const STABLE: Duration = Duration::from_secs(30);

    #[test]
    fn quick_failures_double_to_the_cap() {
        let t0 = Instant::now();
        let mut backoff = Backoff::new(MIN, MAX, STABLE);

        let mut waits = Vec::new();
        for _ in 0..10 {
            backoff.record_start(t0);
            waits.push(backoff.child_exited(t0 + Duration::from_millis(1)));
        }

        assert_eq!(waits[0], MIN);
        assert_eq!(waits[1], MIN * 2);
        assert_eq!(waits[2], MIN * 4);
        // Growth is capped, never unbounded.
        assert!(waits.iter().all(|w| *w <= MAX));
        assert_eq!(*waits.last().unwrap(), MAX);
    }

    #[test]
    fn a_stable_run_resets_to_the_minimum() {
        let t0 = Instant::now();
        let mut backoff = Backoff::new(MIN, MAX, STABLE);

        // Crash-loop until the delay has grown.
        backoff.record_start(t0);
        let _ = backoff.child_exited(t0 + Duration::from_millis(1));
        backoff.record_start(t0);
        let grown = backoff.child_exited(t0 + Duration::from_millis(1));
        assert!(grown >= MIN);

        // The child then survives past the stable interval.
        backoff.record_start(t0);
        let wait = backoff.child_exited(t0 + STABLE + Duration::from_millis(1));
        assert_eq!(wait, MIN);
    }

    #[test]
    fn paused_time_does_not_count_as_stable() {
        // A week passing on the wall clock is invisible here: the
        // monotonic clock does not advance across a pause, and this code
        // only ever reads `Instant`.
        let t0 = Instant::now();
        let mut backoff = Backoff::new(MIN, MAX, STABLE);

        backoff.record_start(t0);
        let _ = backoff.child_exited(t0 + Duration::from_millis(1));
        let grown = backoff.current_delay();
        assert!(grown > MIN);

        // Resume: still almost no monotonic time has passed, so the
        // grown delay is where the backoff left off.
        backoff.record_start(t0 + Duration::from_millis(2));
        let wait = backoff.child_exited(t0 + Duration::from_millis(3));
        assert_eq!(wait, grown);
    }
}
