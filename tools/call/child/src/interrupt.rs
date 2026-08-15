//! "They talked over you" — the one thing the brain was never told.
//!
//! When they cut fig off, the unplayed audio is flushed and the reply is thrown away, and
//! until now that was the end of it: the next turn's prompt looked exactly like a normal
//! turn, so fig had no idea it had been interrupted OR how much of the reply had actually
//! reached them. Hermes carries a latch for precisely this, set when the barge happens and
//! popped by the next turn's prompt build.
//!
//! Two rules, both of them theirs:
//!  - the annotation rides the MODEL INPUT only. It is not a transcript line, it does not
//!    reach the day file, and it never renders as something fig said.
//!  - it expires. A barge nobody followed up on must not annotate an unrelated turn two
//!    minutes later, so the latch is popped-or-dropped, never left lying around.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Hermes' `_INTERRUPT_TTL_S`. Long enough that the turn the barge caused always gets it
/// (that turn starts milliseconds later), short enough that nothing else ever does.
pub const INTERRUPT_TTL: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct InterruptLatch {
    /// When they cut in, and what they had heard fig say by then.
    state: Mutex<Option<(Instant, String)>>,
}

impl InterruptLatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// They cut fig off. `heard` is what had actually been played into their ear — empty when
    /// the flush landed before any clause did.
    pub fn mark_at(&self, now: Instant, heard: String) {
        *self.state.lock().expect("interrupt latch") = Some((now, heard));
    }

    pub fn mark(&self, heard: String) {
        self.mark_at(Instant::now(), heard);
    }

    /// Pop it. `None` when nothing barged, or when the barge is older than the TTL.
    pub fn take_at(&self, now: Instant) -> Option<String> {
        let taken = self.state.lock().expect("interrupt latch").take();
        taken.and_then(|(at, heard)| (now.duration_since(at) < INTERRUPT_TTL).then_some(heard))
    }

    pub fn take(&self) -> Option<String> {
        self.take_at(Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_turn_the_barge_caused_learns_what_he_heard() {
        let latch = InterruptLatch::new();
        assert_eq!(latch.take(), None, "nothing barged, nothing to say");
        latch.mark("and yeah, hermes is a good idea.".to_owned());
        assert_eq!(
            latch.take().as_deref(),
            Some("and yeah, hermes is a good idea.")
        );
        assert_eq!(latch.take(), None, "one turn is told, not every turn after it");
    }

    #[test]
    fn a_barge_before_any_clause_played_still_latches() {
        // They cut in over an outbound opener: they heard fig's voice, just none of the reply.
        let latch = InterruptLatch::new();
        latch.mark(String::new());
        assert_eq!(latch.take().as_deref(), Some(""));
    }

    #[test]
    fn a_stale_barge_never_annotates_an_unrelated_turn() {
        let latch = InterruptLatch::new();
        let now = Instant::now();
        latch.mark_at(now, "they heard this".to_owned());
        assert_eq!(latch.take_at(now + INTERRUPT_TTL), None);
        assert_eq!(latch.take_at(now), None, "and it is gone either way");
    }
}
