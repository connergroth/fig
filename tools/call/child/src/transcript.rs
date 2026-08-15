//! What counts as something they actually SAID.
//!
//! Whisper transcribes whatever it is handed, and near-silence makes it invent. Three
//! failure modes, all of them live-observed:
//!
//!  - an utterance that comes back with no words in it. Barge-in fired on the VAD event
//!    alone lets a door, footsteps, or their own speaker bleeding back delete the reply
//!    they were waiting on. Nothing may cut fig off until this module says there were words.
//!  - a LOOP: whisper latches onto one short clause and repeats it until the decode budget
//!    runs out — "I'm sorry I got off the bus." ×14, "counterpart" ×50. That reached the
//!    brain verbatim, and it answered the noise.
//!  - a PHANTOM PHRASE: on silence whisper emits one of a small set of subtitle-credit
//!    strings it learned from its training data ("Thank you.", "Thanks for watching!",
//!    "Sous-titres réalisés par…"). A different failure from the loop — one copy, not
//!    fifty — and it needs its own blocklist, which is Hermes'.

use regex::Regex;
use std::sync::OnceLock;

/// Longest phrase treated as a loop unit. Whisper loops on a clause, not a paragraph.
const MAX_PERIOD_WORDS: usize = 12;
/// Three copies in a row is already not speech — nobody repeats a clause verbatim twice.
const MIN_REPEATS: usize = 3;
/// A loop that collapses to this little is noise, not a short answer — but only once it
/// ran away. A human says "no no no"; nobody says "counterpart" fifty times.
const NOISE_WORDS: usize = 2;
const RUNAWAY_REPEATS: usize = 6;

/// WHY something wasn't a turn. Carried rather than collapsed to one "no words" line
/// because the session log is the only instrument this lane has. One dead call was 48 seconds
/// of "they were never heard" that could equally have been "they were heard and whisper found
/// nothing," and the log could not tell those apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotSpeech {
    /// Whisper returned nothing, or nothing but punctuation.
    NoWords,
    /// One of the subtitle-credit strings whisper invents on silence.
    Phantom,
    /// A runaway loop with nothing else in it.
    Loop,
}

impl NotSpeech {
    pub fn as_log(self) -> &'static str {
        match self {
            Self::NoWords => "whisper found no words in that audio",
            Self::Phantom => "whisper invented one of its silence phrases",
            Self::Loop => "a runaway whisper loop with nothing else in it",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Heard {
    /// Not a turn. Drop it — no brain turn, no barge-in, no note in the transcript — but
    /// say which of the three it was.
    Nothing(NotSpeech),
    /// Real speech. `looped` counts the repeats collapsed out of it (0 = untouched).
    Speech { text: String, looped: usize },
}

/// Compared loosely on purpose: whisper's repeats differ in case and punctuation
/// ("greeting filler," vs "greeting, filler,"), and those are the same words.
fn normalize(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The phrases whisper invents on silence, straight from Hermes' `WHISPER_HALLUCINATIONS`.
/// Stored without trailing `.`/`!` because the match strips those; the non-English entries
/// are subtitle credits, which is where whisper learned them.
const WHISPER_PHANTOMS: &[&str] = &[
    "thank you",
    "thanks for watching",
    "subscribe to my channel",
    "like and subscribe",
    "please subscribe",
    "thank you for watching",
    "bye",
    "you",
    "the end",
    "продолжение следует",
    "продолжение следует...",
    "sous-titres",
    "sous-titres réalisés par la communauté d'amara.org",
    "sottotitoli creati dalla comunità amara.org",
    "untertitel von stephanie geiges",
    "amara.org",
    "www.mooji.org",
    "ご視聴ありがとうございました",
];

/// The repetitive variants ("Thank you. Thank you. you"), Hermes' `_HALLUCINATION_REPEAT_RE`.
fn phantom_repeat_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^(?:thank you|thanks|bye|you|ok|okay|the end|\.|\s|,|!)+$").unwrap()
    })
}

/// Did whisper invent this out of silence? Empty counts — there was nothing there.
pub fn is_hallucination(raw: &str) -> bool {
    let cleaned = raw.trim().to_lowercase();
    if cleaned.is_empty() {
        return true;
    }
    let stripped = cleaned.trim_end_matches(['.', '!']);
    WHISPER_PHANTOMS.contains(&cleaned.as_str())
        || WHISPER_PHANTOMS.contains(&stripped)
        || phantom_repeat_re().is_match(&cleaned)
}

pub fn hear(raw: &str) -> Heard {
    if raw.trim().is_empty() {
        return Heard::Nothing(NotSpeech::NoWords);
    }
    if is_hallucination(raw) {
        return Heard::Nothing(NotSpeech::Phantom);
    }
    let words: Vec<&str> = raw.split_whitespace().collect();
    let normalized: Vec<String> = words.iter().map(|word| normalize(word)).collect();
    if normalized.iter().all(String::is_empty) {
        return Heard::Nothing(NotSpeech::NoWords);
    }

    let mut kept: Vec<&str> = Vec::new();
    let mut looped = 0usize;
    let mut runaway = false;
    let mut index = 0usize;
    while index < words.len() {
        // Shortest period first: "counterpart counterpart …" is a one-word loop that a
        // longer window would only ever find in multiples of itself.
        let mut found = None;
        for period in 1..=MAX_PERIOD_WORDS.min(words.len() - index) {
            let mut repeats = 1usize;
            while index + (repeats + 1) * period <= words.len()
                && normalized[index..index + period]
                    == normalized[index + repeats * period..index + (repeats + 1) * period]
            {
                repeats += 1;
            }
            if repeats >= MIN_REPEATS {
                found = Some((period, repeats));
                break;
            }
        }
        match found {
            Some((period, repeats)) => {
                kept.extend_from_slice(&words[index..index + period]);
                looped += repeats - 1;
                runaway |= repeats >= RUNAWAY_REPEATS;
                index += repeats * period;
            }
            None => {
                kept.push(words[index]);
                index += 1;
            }
        }
    }

    if runaway && kept.len() <= NOISE_WORDS {
        return Heard::Nothing(NotSpeech::Loop);
    }
    Heard::Speech {
        text: kept.join(" "),
        looped,
    }
}

/// The LAST `max` characters of a line, for a log that only wants the tail (what they had
/// actually heard when they cut fig off). Reversing to take the tail and forgetting to
/// reverse back prints the whole thing backwards: `".gub elohw eht s'taht"`.
pub fn tail_chars(text: &str, max: usize) -> String {
    let mut tail: Vec<char> = text.chars().rev().take(max).collect();
    tail.reverse();
    tail.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn speech(raw: &str) -> String {
        match hear(raw) {
            Heard::Speech { text, .. } => text,
            Heard::Nothing(why) => panic!("expected speech from {raw:?}, got {}", why.as_log()),
        }
    }

    #[test]
    fn silence_is_not_a_turn() {
        assert_eq!(hear(""), Heard::Nothing(NotSpeech::NoWords));
        assert_eq!(hear("   "), Heard::Nothing(NotSpeech::NoWords));
        assert_eq!(hear("... - ,"), Heard::Nothing(NotSpeech::NoWords));
    }

    /// The rejection has to be able to say WHICH rejection it was, or a session log can't
    /// tell "never heard them" from "heard them, whisper found nothing in it".
    #[test]
    fn every_rejection_says_which_one_it_was() {
        for (raw, why) in [
            ("", NotSpeech::NoWords),
            ("   ", NotSpeech::NoWords),
            ("Thank you.", NotSpeech::Phantom),
            ("Sous-titres réalisés par la communauté d'Amara.org", NotSpeech::Phantom),
            ("counterpart counterpart counterpart counterpart counterpart counterpart", NotSpeech::Loop),
        ] {
            assert_eq!(hear(raw), Heard::Nothing(why), "wrong reason for {raw:?}");
            assert!(!why.as_log().is_empty());
        }
    }

    #[test]
    fn collapses_the_real_loops_from_the_7_31_call() {
        // All three verbatim out of the session log.
        assert_eq!(
            hear(&"I'm going to go to the cold now. ".repeat(6)),
            Heard::Speech {
                text: "I'm going to go to the cold now.".to_owned(),
                looped: 5
            }
        );
        assert_eq!(
            hear(&"I'm sorry I got off the bus. ".repeat(14)),
            Heard::Speech {
                text: "I'm sorry I got off the bus.".to_owned(),
                looped: 13
            }
        );
        // One-word runaway with a real prefix in front of it: the prefix survives.
        assert_eq!(
            speech(&format!("This is a good {}", "counterpart ".repeat(50))),
            "This is a good counterpart"
        );
    }

    #[test]
    fn a_runaway_loop_with_nothing_else_in_it_is_noise() {
        assert_eq!(hear(&"counterpart ".repeat(50)), Heard::Nothing(NotSpeech::Loop));
        assert_eq!(hear(&"Thank you. ".repeat(8)), Heard::Nothing(NotSpeech::Phantom));
    }

    #[test]
    fn ordinary_speech_is_left_alone() {
        let line = "yeah, that's the right lever. raise the bar and it stops cutting me off.";
        assert_eq!(speech(line), line);
        // Emphasis is not a loop: it collapses, but it is still a turn.
        assert_eq!(speech("no no no dude"), "no dude");
        assert_eq!(speech("no no no"), "no");
        // Repeats that aren't back to back are just how people talk.
        let echo = "call me once and let me hang up, then call me once more.";
        assert_eq!(speech(echo), echo);
    }

    #[test]
    fn the_phrases_whisper_invents_on_silence_are_not_turns() {
        for phantom in [
            "Thank you.",
            "thanks for watching",
            "Thanks for watching!",
            "Subscribe to my channel.",
            "Bye.",
            "You",
            "Продолжение следует...",
            "Sous-titres réalisés par la communauté d'Amara.org",
            "ご視聴ありがとうございました",
            "Thank you. Thank you. you",
            "okay ok okay",
        ] {
            assert_eq!(
                hear(phantom),
                Heard::Nothing(NotSpeech::Phantom),
                "{phantom:?} reached the brain"
            );
        }
        // …and a real sentence that merely CONTAINS one of them still does.
        assert_eq!(
            speech("thank you for pulling the hermes docs"),
            "thank you for pulling the hermes docs"
        );
    }

    #[test]
    fn saying_hang_up_is_an_ordinary_turn() {
        // Nothing they say ends the call by itself — the model's `hang_up` is the only path,
        // so these reach the brain as words like any others.
        assert_eq!(speech("hang up"), "hang up");
        assert_eq!(speech("end the call"), "end the call");
    }

    #[test]
    fn the_heard_tail_reads_forwards() {
        // A played reply, in the order it actually reached their ear.
        let heard = "didn't work, so this time i read the log first. and yeah, that's the whole bug.";
        assert_eq!(tail_chars(heard, 500), heard, "a short line is not truncated");
        assert_eq!(tail_chars(heard, 21), "that's the whole bug.");
        assert_eq!(tail_chars("short", 80), "short");
        assert_eq!(tail_chars("", 80), "");
    }
}
