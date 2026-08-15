//! What they said into a turn's thinking silence, waiting for something to answer it.
//!
//! One rule, and it's why this is a type instead of a `Vec` behind a lock: an utterance
//! leaves this queue EXACTLY ONCE. Every consumer drains the WHOLE queue in a single
//! locked step, so two racing consumers can never both walk off with the same words —
//! and whoever drains it owns asking it.
//!
//! The other half of exactly-once is that nothing else carries those words to the brain.
//! A folded utterance ("I just got back.") that is ALSO written straight into the
//! conversation transcript on the way in — and the transcript is what seeds the next
//! turn's prompt. So the brain read it as history and then again as the question, and
//! fig said the duplicate out loud: "you said that — or did that come through twice?"
//! Their line is now recorded by the turn that ASKS it (bridge `ask_stream { spoken }`),
//! which means this queue is the only thing holding it until then.

use std::sync::Mutex;

#[derive(Default)]
pub struct PendingSpeech {
    queue: Mutex<Vec<String>>,
}

impl PendingSpeech {
    pub fn new() -> Self {
        Self::default()
    }

    /// Keep it: the turn in flight hasn't reached their ears yet, so these words join that
    /// turn's answer instead of restarting it from cold (see barge.rs).
    pub fn fold(&self, spoken: String) {
        self.queue.lock().expect("pending speech").push(spoken);
    }

    /// Drain everything as one question. `None` when there's nothing waiting.
    pub fn take(&self) -> Option<String> {
        let taken = std::mem::take(&mut *self.queue.lock().expect("pending speech"));
        (!taken.is_empty()).then(|| taken.join(" "))
    }

    /// Drain everything and put `spoken` on the end — the question a NON-folding
    /// utterance asks. Whatever is still queued was never answered (a barge-in retires
    /// the turn that would have picked it up), and they shouldn't have to say it twice, so
    /// it rides along with the words they just said instead of becoming a second reply.
    pub fn take_with(&self, spoken: String) -> String {
        let mut queue = self.queue.lock().expect("pending speech");
        let mut taken = std::mem::take(&mut *queue);
        taken.push(spoken);
        taken.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folded_utterance_is_answered_once_and_only_once() {
        // They spoke into the thinking silence, the turn landed, the pickup asked it.
        // Nothing may be left behind for a LATER turn to ask a second time.
        let pending = PendingSpeech::new();
        pending.fold("I just got back.".to_owned());
        assert_eq!(pending.take().as_deref(), Some("I just got back."));
        assert_eq!(pending.take(), None, "the pickup queue is empty afterwards");
        assert_eq!(pending.take_with("ok cool".to_owned()), "ok cool");
    }

    #[test]
    fn everything_folded_into_one_turn_is_asked_as_one_question() {
        let pending = PendingSpeech::new();
        pending.fold("Or, um...".to_owned());
        pending.fold("just look at Hermes Agent".to_owned());
        assert_eq!(
            pending.take().as_deref(),
            Some("Or, um... just look at Hermes Agent")
        );
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn a_barge_in_carries_the_unanswered_fold_along_instead_of_dropping_it() {
        // Folded, then five seconds later they cut fig off. The fold is retired unanswered
        // and would survive only by accident, on its transcript note leaking into the next
        // prompt. Now it's part of the question the barge-in asks.
        let pending = PendingSpeech::new();
        pending.fold("try to steal some of that for our own implementation".to_owned());
        assert_eq!(
            pending.take_with("that we can make as well. I think that's it.".to_owned()),
            "try to steal some of that for our own implementation that we can make as well. I think that's it."
        );
        assert_eq!(pending.take(), None, "nothing is left to ask twice");
    }

    #[test]
    fn an_idle_utterance_asks_only_itself() {
        let pending = PendingSpeech::new();
        assert_eq!(pending.take_with("Yo, it's good.".to_owned()), "Yo, it's good.");
        assert_eq!(pending.take(), None);
    }
}
