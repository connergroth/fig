use std::time::{Duration, Instant};

/// "Is the mouth actually finished?" — the Rust half of src/call/audio/drain.ts. Keep the
/// two in step; the lane speaks the same `drain` → `DRAINED` protocol to every child.
///
/// Text-done is not audio-done: `hang_up` fires when the goodbye's TEXT is complete,
/// while the audio is still being rendered clause-by-clause and then still has to PLAY.
/// So: wait on the real queue, pad for the device buffer CoreAudio still holds after our
/// own queue reads empty, and cap the whole thing — a truncated goodbye is bad, a call
/// that never hangs up is worse.

/// Device ring + FaceTime encoder lag after OUR queue reads empty.
pub const DRAIN_TAIL_MS: u64 = 300;
/// Hang-up cap: the goodbye still has to be thought, rendered AND played.
pub const DRAIN_TIMEOUT_MS: u64 = 20_000;
/// Teardown cap: the call is already ending, so bound it much tighter.
pub const TEARDOWN_DRAIN_TIMEOUT_MS: u64 = 8_000;
/// Re-ask cadence. Cheap — a queue-length read, not a syscall.
pub const DRAIN_POLL_MS: u64 = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainOutcome {
    /// The queue genuinely went empty (and the tail pad has been served).
    Drained,
    /// The cap fired with audio still queued — tear down anyway.
    TimedOut,
}

impl DrainOutcome {
    pub fn as_log(self) -> &'static str {
        match self {
            Self::Drained => "mouth empty",
            Self::TimedOut => "CAP HIT",
        }
    }
}

/// What was actually still outstanding when the cap fired.
///
/// The hangup drain waits on the TURN as well as the mouth, and calling both of those
/// "audio still queued" is how a drain log claims twenty seconds of backlog while
/// the mouth was empty and a folded follow-up was still being thought about. A drain log
/// that names the wrong thing sends the next debugging session at the wrong subsystem.
pub fn cap_hit_reason(turn_in_flight: bool, audio_pending: bool) -> &'static str {
    match (turn_in_flight, audio_pending) {
        (true, true) => "CAP HIT, a turn is still speaking",
        (true, false) => "CAP HIT, a turn is still being thought (mouth empty)",
        (false, true) => "CAP HIT, audio still queued",
        (false, false) => "CAP HIT, but nothing is pending any more",
    }
}

#[derive(Debug, Clone, Copy)]
pub struct DrainPolicy {
    pub poll: Duration,
    pub tail: Duration,
    pub timeout: Duration,
}

impl DrainPolicy {
    /// The lane is holding an End press on this — wait as long as a real goodbye takes.
    pub fn hangup() -> Self {
        Self {
            poll: Duration::from_millis(DRAIN_POLL_MS),
            tail: Duration::from_millis(DRAIN_TAIL_MS),
            timeout: Duration::from_millis(DRAIN_TIMEOUT_MS),
        }
    }

    /// The session is going down regardless; just don't cut the clause already playing.
    pub fn teardown() -> Self {
        Self {
            timeout: Duration::from_millis(TEARDOWN_DRAIN_TIMEOUT_MS),
            ..Self::hangup()
        }
    }
}

/// Block until `pending()` reads false, then pad, then return `(outcome, time spent
/// waiting for the queue)` — the tail pad is excluded from the reported wait.
///
/// The pad is served ONLY on the drained path: if the cap fired, audio is still queued
/// and padding would just delay a teardown we already decided on.
pub async fn wait_until_drained<F>(pending: F, policy: DrainPolicy) -> (DrainOutcome, Duration)
where
    F: Fn() -> bool,
{
    let started = Instant::now();
    while pending() {
        if started.elapsed() >= policy.timeout {
            return (DrainOutcome::TimedOut, started.elapsed());
        }
        tokio::time::sleep(policy.poll).await;
    }
    let waited = started.elapsed();
    if !policy.tail.is_zero() {
        tokio::time::sleep(policy.tail).await;
    }
    (DrainOutcome::Drained, waited)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn fast(timeout_ms: u64) -> DrainPolicy {
        DrainPolicy {
            poll: Duration::from_millis(5),
            tail: Duration::from_millis(40),
            timeout: Duration::from_millis(timeout_ms),
        }
    }

    /// The regression guard: the wait may not return while audio is still queued, and the
    /// tail pad lands AFTER the queue empties (not instead of waiting for it).
    #[tokio::test]
    async fn waits_for_the_queue_then_pads() {
        let busy = Arc::new(AtomicBool::new(true));
        let flip = busy.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            flip.store(false, Ordering::SeqCst);
        });

        let started = Instant::now();
        let (outcome, waited) = wait_until_drained(move || busy.load(Ordering::SeqCst), fast(5_000)).await;

        assert_eq!(outcome, DrainOutcome::Drained);
        assert!(
            waited >= Duration::from_millis(110),
            "returned before the mouth emptied: {waited:?}"
        );
        assert!(
            started.elapsed() >= waited + Duration::from_millis(35),
            "tail pad was not served after the queue emptied"
        );
    }

    #[tokio::test]
    async fn an_idle_mouth_only_pays_the_tail() {
        let started = Instant::now();
        let (outcome, waited) = wait_until_drained(|| false, fast(5_000)).await;
        assert_eq!(outcome, DrainOutcome::Drained);
        assert!(waited < Duration::from_millis(20), "should not have waited: {waited:?}");
        assert!(started.elapsed() >= Duration::from_millis(35), "tail pad still applies");
    }

    /// A wedged mouth must not strand the call: cap, report the truth, let the caller
    /// tear down anyway.
    #[tokio::test]
    async fn a_wedged_mouth_hits_the_cap_and_skips_the_pad() {
        let started = Instant::now();
        let (outcome, waited) = wait_until_drained(|| true, fast(60)).await;
        assert_eq!(outcome, DrainOutcome::TimedOut);
        assert!(waited >= Duration::from_millis(60), "capped early: {waited:?}");
        assert!(
            started.elapsed() < Duration::from_millis(95),
            "no tail pad on the timeout path: {:?}",
            started.elapsed()
        );
    }

    /// The log line this exists to stop: "lane asked to drain: CAP HIT, audio still queued
    /// after 20000ms" — with an empty mouth. It was a folded follow-up still thinking.
    #[test]
    fn the_cap_hit_log_names_what_was_actually_pending() {
        assert!(cap_hit_reason(true, false).contains("thought"));
        assert!(!cap_hit_reason(true, false).contains("audio still queued"));
        assert_eq!(cap_hit_reason(false, true), "CAP HIT, audio still queued");
        assert!(cap_hit_reason(true, true).contains("speaking"));
        assert!(cap_hit_reason(false, false).contains("nothing is pending"));
    }

    #[test]
    fn the_tail_sits_in_the_window_the_device_buffer_needs() {
        assert!((250..=400).contains(&DRAIN_TAIL_MS));
        assert_eq!(DrainPolicy::hangup().tail, DrainPolicy::teardown().tail);
        assert!(DrainPolicy::teardown().timeout < DrainPolicy::hangup().timeout);
    }
}
