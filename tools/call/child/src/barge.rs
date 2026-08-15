//! Who wins when the owner speaks while a turn is in flight.
//!
//! Barge-in on ANY speech is wrong: talking into fig's THINKING silence then kills the
//! reply they were waiting for and restarts the clock from cold — and thinking
//! silence is exactly when they're most likely to speak, because it sounds like a dropped
//! call ("barge-in: flushed before any clause played" — 10s of work thrown away by a
//! "hello?"). Cutting fig off is only the right answer once they have actually HEARD
//! something; before that the utterance belongs to the turn already running.
//!
//! These answer WHICH turn the speech belongs to, never WHETHER there was speech: the
//! call site only reaches them once whisper has come back with real words (transcript.rs).
//! Energy alone is the other half of the problem — a door or their own speaker
//! bleeding back cuts fig off mid-sentence.

/// Has anything fig said reached their ears yet? Either a clause of the CURRENT turn has
/// played, or audio is still in the mouth with no turn thinking behind it (an outbound
/// opener, or the tail of a finished reply).
pub fn heard_fig(clauses_played: usize, turn_in_flight: bool, audio_pending: bool) -> bool {
    clauses_played > 0 || (!turn_in_flight && audio_pending)
}

/// Speech over audio they can hear = cut fig off, flush the mouth, retire the turn.
pub fn cuts_fig_off(clauses_played: usize, turn_in_flight: bool, audio_pending: bool) -> bool {
    heard_fig(clauses_played, turn_in_flight, audio_pending)
}

/// Speech into a turn's thinking silence: the new utterance FOLDS into that turn (it's
/// picked up when the turn lands) instead of replacing it with a cold restart.
pub fn folds_into_turn(clauses_played: usize, turn_in_flight: bool, audio_pending: bool) -> bool {
    turn_in_flight && !heard_fig(clauses_played, turn_in_flight, audio_pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_into_thinking_silence_keeps_the_turn() {
        // The thinking-silence case: brain still cooking, zero clauses rendered, mouth empty.
        assert!(!cuts_fig_off(0, true, false));
        assert!(folds_into_turn(0, true, false));
    }

    #[test]
    fn audio_from_before_the_turn_is_not_this_turn_landing() {
        // Outbound opener still in the mouth while the first turn thinks: they haven't heard
        // an ANSWER yet, so their words join that turn instead of deleting it.
        assert!(!cuts_fig_off(0, true, true));
        assert!(folds_into_turn(0, true, true));
    }

    #[test]
    fn speech_over_a_played_clause_still_cuts() {
        assert!(cuts_fig_off(1, true, true));
        assert!(!folds_into_turn(1, true, true));
        // …and after the turn text is done but the mouth is still playing it.
        assert!(cuts_fig_off(2, false, true));
    }

    #[test]
    fn speech_over_an_outbound_opener_still_cuts() {
        // No turn in flight, audio in the mouth = the opener (never pushed to `spoken`).
        assert!(cuts_fig_off(0, false, true));
        assert!(!folds_into_turn(0, false, true));
    }

    #[test]
    fn idle_speech_is_neither() {
        assert!(!cuts_fig_off(0, false, false));
        assert!(!folds_into_turn(0, false, false));
    }
}
