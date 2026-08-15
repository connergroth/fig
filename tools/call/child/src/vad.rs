//! Endpointing, and the bar a frame has to clear to count as them talking.
//!
//! The bar is not ONE hand-tuned constant. A fixed number — 0.022 amplitude, say, picked
//! off one bad call — is wrong the moment the room changes: a party, a car and a quiet
//! apartment at 2am all need different numbers, and the only tuning loop a constant offers
//! is "someone has a bad call, guess a new one."
//!
//! So the bar is measured instead, the way Hermes' full-duplex listener measures it: sample
//! the QUIET room first, set the trigger at a multiple of that floor, keep the floor
//! drifting with the room but ONLY while nothing is playing, and clamp the trigger at both
//! ends so neither a dead mic nor a loud room can produce an absurd threshold. Hermes arms
//! a fresh listener per turn (theirs is per-turn by construction); this one lives for the
//! whole call, so the same guarantee comes from the freeze-during-playback rule rather than
//! from re-arming.
//!
//! Hermes tunes in raw int16 RMS (0-32767); everything here is normalized amplitude
//! (i16 / 32768), so every ported number carries its int16 original in the comment.

use std::collections::VecDeque;

/// How much quiet-phase history the floor is recomputed from. Long enough that the floor
/// tracks the room rather than the last breath, short enough to follow a real change.
const AMBIENT_WINDOW_MS: u32 = 3_000;

/// How many calibration windows a room gets to go quiet before its measurement is taken at
/// face value, ceiling and all.
///
/// A window is REJECTED rather than locked when the trigger it produces would land at the
/// ceiling, because that is a bar their voice cannot clear — the endpointer keeps listening
/// on the conservative default while it measures again. The failure it guards: the first 440ms
/// off the tap was the aggregate device coming up, it read 0.0943 (15x the true room), the
/// floor locked there and the trigger clamped to the 0.0600 ceiling. They talked into a
/// nearly deaf VAD for 25s, and the call was saved only because the idle drift happened to
/// walk the bar back down to 0.0183 before they spoke.
///
/// Four windows = 1.8s. The failure directions are not symmetric, which is what sets this:
/// a bar too LOW costs junk utterances that whisper then throws away, a bar too HIGH costs
/// the whole call. So it errs low and takes its time.
const MAX_CALIBRATION_ATTEMPTS: u32 = 4;

#[derive(Clone, Debug)]
pub struct VadConfig {
    pub sample_rate: u32,
    pub frame_ms: u32,
    /// How much quiet room to sample before the floor is trusted.
    pub calibration_ms: u32,
    /// trigger = quiet_floor × this.
    pub trigger_multiplier: f32,
    /// The floor never reads below this, so a dead mic can't make silence "speech".
    pub silence_floor: f32,
    /// While fig's audio is flowing the trigger is clamped UP to here: speaker bleed
    /// through air is a few hundred RMS, direct speech is 3000-8000.
    pub playback_min_trigger: f32,
    /// …and always clamped DOWN to here, so a loud room can never push the bar above
    /// what real speech reaches.
    pub trigger_ceiling: f32,
    /// Window the start-of-speech majority is measured over.
    pub sustained_ms: u32,
    /// Fraction of that window that must be over the trigger to start an utterance.
    pub trip_ratio: f32,
    /// Dead time after playback starts — the onset transient and bleed are worst there.
    pub grace_ms: u32,
    /// Grace only re-arms when playback starts after a gap this long, so clause-to-clause
    /// flapping of the playing flag can't chain grace windows and swallow a real interruption.
    pub grace_rearm_gap_ms: u32,
    pub min_speech_ms: u32,
    pub trailing_silence_ms: u32,
    pub max_utterance_ms: u32,
    pub pre_roll_ms: u32,
    pub keep_tail_ms: u32,
    /// Per-frame floor/rms/trigger/window diagnostics. Without it, tuning is hours of guessing
    /// constants off after-the-fact transcripts; with it, one call is enough.
    pub debug: bool,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sample_rate: 24_000,
            frame_ms: 20,
            calibration_ms: 450,
            trigger_multiplier: 3.0,
            // 200 int16 RMS.
            silence_floor: 0.0061,
            // NOT Hermes' number, and this is the one place the port is deliberately not
            // literal. Theirs is 1500 int16 RMS (0.0458), sized against an open mic where
            // direct speech measures 3000-8000. fig doesn't hear a mic — it hears a
            // CoreAudio tap of FaceTime's decoded stream, where their voice peaks at
            // 0.25-0.45 (tapout's own window log) and so runs 0.03-0.09 RMS. 0.0458 sits
            // inside that band and could have made barge-in simply stop working during
            // playback, which is unfindable except on a live call. 0.022 is the only bar
            // measured to detect their speech on THIS path, and the things
            // that stop bleed from tripping it are elsewhere: the
            // grace window, the windowed start, and whisper having to find words. Raise it
            // with CALL_VAD_PLAYBACK_MIN_TRIGGER if bleed ever does barge in.
            playback_min_trigger: 0.022,
            // Hermes caps at 4000 int16 RMS — the bottom of the band real speech reaches
            // on their mic, so a loud room can never push the bar out of reach. 0.06 is
            // that same relationship on this path, against their measured 0.03-0.09.
            trigger_ceiling: 0.06,
            sustained_ms: 300,
            trip_ratio: 0.8,
            grace_ms: 500,
            grace_rearm_gap_ms: 1_000,
            // Noise is rejected by CONTENT, not by duration. A 450ms bar looks right on a
            // call where junk totals 340-480ms voiced and every real utterance is
            // 640ms or more — but such a call never sampled a short GREETING, and a short
            // greeting is how a call starts. The bill for that bar: 48 seconds, zero turns,
            // the only two things the VAD ever saw were their 300ms and 280ms "hello?" and
            // both were dropped here without ever reaching whisper.
            //
            // 200ms is deliberately BELOW the 240ms the start test already implies (a
            // 300ms window at 80% = 12 voiced frames), so this is not the filter —
            // it is one frame past the trip, and everything that starts an utterance gets
            // handed to whisper. What actually rejects junk is downstream of here:
            // whisper has to come back with words, and the phantom blocklist throws out
            // what it invents on silence (transcript.rs, on the same path — main.rs
            // `on_utterance` gates EVERY endpoint through `hear`). The cost of a false
            // positive is one wasted decode; the cost of a false negative is the call.
            min_speech_ms: 200,
            trailing_silence_ms: 1_800,
            // 30s chopped a caller mid-sentence twice on one call, splitting one
            // thought into two utterances both times. Hermes' equivalent cap is 120s.
            max_utterance_ms: 120_000,
            // Has to cover the whole trip window plus real lead-in: an utterance now starts
            // ~300ms after they do (that's the majority window), so 600ms of pre-roll leaves
            // ~300ms of audio in front of their first syllable.
            // That margin is what makes a 280ms utterance safe to send: the pre-roll holds
            // the entire word plus lead-in, so whisper gets the greeting, not its tail.
            pre_roll_ms: 600,
            keep_tail_ms: 300,
            debug: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndpointReason {
    Silence,
    MaxUtterance,
    Flush,
}

impl EndpointReason {
    pub fn as_log(self) -> &'static str {
        match self {
            Self::Silence => "silence",
            Self::MaxUtterance => "max-utterance",
            Self::Flush => "flush",
        }
    }
}

#[derive(Debug)]
pub struct Utterance {
    pub pcm: Vec<u8>,
    pub start_ms: u32,
    pub end_ms: u32,
    pub speech_ms: u32,
    pub silence_ms: u32,
    pub reason: EndpointReason,
}

/// No "speech started" event on purpose: nothing may act on energy alone. What the VAD
/// hears is only a candidate until whisper says there were words in it (see transcript.rs).
#[derive(Debug)]
pub enum VadEvent {
    Log(String),
    Endpoint(Utterance),
}

/// 90th percentile, linearly interpolated — the same statistic Hermes calibrates against,
/// and the reason it's a percentile rather than a mean is that one cough must not be able
/// to move the floor.
fn percentile_90(values: &VecDeque<f32>) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f32> = values.iter().copied().collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = 0.9 * (sorted.len() - 1) as f32;
    let low = rank.floor() as usize;
    let high = rank.ceil() as usize;
    sorted[low] + (sorted[high] - sorted[low]) * (rank - low as f32)
}

pub struct VadEndpointer {
    cfg: VadConfig,
    frame_bytes: usize,
    residue: Vec<u8>,
    sample_pos: u64,
    frame_index: u64,
    pre_roll: VecDeque<Vec<u8>>,
    pre_roll_frames: usize,

    /// Quiet-phase RMS history the floor is recomputed from (~3s worth).
    ambient: VecDeque<f32>,
    ambient_cap: usize,
    quiet_floor: f32,
    floor_locked: bool,
    calibration_frames: usize,
    calibration_attempts: u32,

    /// The last `sustained_ms` of over/under-trigger decisions.
    recent_above: VecDeque<bool>,
    trip_window: usize,
    trip_needed: usize,

    playing_prev: bool,
    playback_seen: bool,
    grace_remaining: u32,
    grace_frames: u32,
    frames_since_playback: u32,
    rearm_gap_frames: u32,

    in_utterance: bool,
    confirmed: bool,
    frames: Vec<Vec<u8>>,
    utter_start_ms: u32,
    last_voiced_ms: u32,
    voiced_ms: u32,
    silence_run_ms: u32,
}

impl VadEndpointer {
    pub fn new(cfg: VadConfig) -> Self {
        let frame_bytes = ((cfg.sample_rate * cfg.frame_ms / 1000) * 2) as usize;
        let pre_roll_frames = (cfg.pre_roll_ms / cfg.frame_ms).max(1) as usize;
        let trip_window = (cfg.sustained_ms / cfg.frame_ms).max(1) as usize;
        let trip_needed = ((trip_window as f32 * cfg.trip_ratio).round() as usize).clamp(1, trip_window);
        let calibration_frames = (cfg.calibration_ms / cfg.frame_ms).max(1) as usize;
        let grace_frames = cfg.grace_ms / cfg.frame_ms;
        let rearm_gap_frames = cfg.grace_rearm_gap_ms / cfg.frame_ms;
        let ambient_cap = (AMBIENT_WINDOW_MS / cfg.frame_ms).max(1) as usize;
        let quiet_floor = cfg.silence_floor;
        Self {
            cfg,
            frame_bytes,
            residue: Vec::new(),
            sample_pos: 0,
            frame_index: 0,
            pre_roll: VecDeque::new(),
            pre_roll_frames,
            ambient: VecDeque::new(),
            ambient_cap,
            quiet_floor,
            floor_locked: false,
            calibration_frames,
            calibration_attempts: 0,
            recent_above: VecDeque::new(),
            trip_window,
            trip_needed,
            playing_prev: false,
            playback_seen: false,
            grace_remaining: 0,
            grace_frames,
            frames_since_playback: u32::MAX,
            rearm_gap_frames,
            in_utterance: false,
            confirmed: false,
            frames: Vec::new(),
            utter_start_ms: 0,
            last_voiced_ms: 0,
            voiced_ms: 0,
            silence_run_ms: 0,
        }
    }

    /// The calibrated quiet-room floor, for tests and the debug log.
    pub fn quiet_floor(&self) -> f32 {
        self.quiet_floor
    }

    /// The bar a frame has to clear right now. `playing` is whether fig's audio is
    /// flowing — the trigger is clamped up while it is, so bleed alone can't trip it.
    pub fn trigger(&self, playing: bool) -> f32 {
        let mut trigger = self.quiet_floor * self.cfg.trigger_multiplier;
        if playing {
            trigger = trigger.max(self.cfg.playback_min_trigger);
        } else {
            trigger = trigger.max(self.cfg.silence_floor * 2.0);
        }
        trigger.min(self.cfg.trigger_ceiling)
    }

    pub fn push(&mut self, chunk: &[u8], playing: bool) -> Vec<VadEvent> {
        self.residue.extend_from_slice(chunk);
        let mut events = Vec::new();
        while self.residue.len() >= self.frame_bytes {
            let tail = self.residue.split_off(self.frame_bytes);
            let frame = std::mem::replace(&mut self.residue, tail);
            self.on_frame(frame, playing, &mut events);
        }
        events
    }

    pub fn flush(&mut self) -> Vec<VadEvent> {
        let mut events = Vec::new();
        if self.in_utterance && self.confirmed {
            events.push(VadEvent::Endpoint(self.emit(EndpointReason::Flush)));
        }
        self.reset();
        events
    }

    fn pos_ms(&self) -> u32 {
        (self.sample_pos * 1000 / self.cfg.sample_rate as u64) as u32
    }

    fn rms(frame: &[u8]) -> f32 {
        let mut sum = 0.0f64;
        let mut count = 0usize;
        for pair in frame.chunks_exact(2) {
            let sample = i16::from_le_bytes([pair[0], pair[1]]) as f64 / 32768.0;
            sum += sample * sample;
            count += 1;
        }
        (sum / count.max(1) as f64).sqrt() as f32
    }

    fn on_frame(&mut self, frame: Vec<u8>, playing: bool, events: &mut Vec<VadEvent>) {
        self.sample_pos += (frame.len() / 2) as u64;
        self.frame_index += 1;
        let rms = Self::rms(&frame);
        let now_ms = self.pos_ms();

        // Calibration runs BEFORE anything else can look at this frame: until the floor is
        // locked there is no trigger, so there is nothing to compare against.
        if !self.floor_locked {
            if self.frame_index == 1 {
                // Announced off the first frame the SOURCE actually delivered, and nowhere
                // else. Logging it when the reader task is spawned puts "calibrating the
                // room" in the log 126ms before tapout exists and 69ms before it is even
                // spawned, which reads as the VAD measuring a source that isn't there.
                // Nothing can be measured until a frame arrives, so the line belongs to
                // the first frame.
                events.push(VadEvent::Log(format!(
                    "vad: calibrating the room for {}ms (trigger = floor x{:.1}, clamped {:.4}-{:.4}){}",
                    self.cfg.calibration_ms,
                    self.cfg.trigger_multiplier,
                    self.cfg.silence_floor * 2.0,
                    self.cfg.trigger_ceiling,
                    if self.cfg.debug { ", DEBUG" } else { "" },
                )));
            }
            if !playing {
                self.push_ambient(rms);
            }
            // `playing` closes the window early: audio started before the room was sampled,
            // and calibrating from here on would bake speaker bleed into the floor forever.
            if self.ambient.len() >= self.calibration_frames || playing {
                self.close_calibration_window(playing, events);
            }
            if !self.floor_locked {
                self.remember_pre_roll(frame);
                return;
            }
        }

        self.track_playback_phase(playing, events);

        let trigger = self.trigger(playing);
        // The floor keeps up with the room, but only while nothing is playing (it may never
        // absorb its own speaker bleed) and only on frames that aren't speech.
        if !playing && rms < trigger {
            self.push_ambient(rms);
            self.quiet_floor = percentile_90(&self.ambient).max(self.cfg.silence_floor);
        }

        let mut above = rms >= trigger;
        if above && self.grace_remaining > 0 && self.cfg.debug {
            events.push(VadEvent::Log(format!(
                "vad: grace suppression frame={} rms={rms:.4} trigger={trigger:.4} ({} frames left)",
                self.frame_index, self.grace_remaining
            )));
        }
        if self.grace_remaining > 0 {
            above = false;
            self.grace_remaining -= 1;
        }
        self.recent_above.push_back(above);
        while self.recent_above.len() > self.trip_window {
            self.recent_above.pop_front();
        }
        let window_above = self.recent_above.iter().filter(|hit| **hit).count();

        if self.cfg.debug && rms >= trigger * 0.5 {
            events.push(VadEvent::Log(format!(
                "vad: frame={} rms={rms:.4} floor={:.4} trigger={trigger:.4} above={above} window={window_above}/{} phase={} state={}",
                self.frame_index,
                self.quiet_floor,
                self.trip_needed,
                if playing { "playback" } else { "idle" },
                if self.in_utterance { "in-utterance" } else { "listening" },
            )));
        }

        if !self.in_utterance {
            self.remember_pre_roll(frame);
            // A windowed MAJORITY starts the utterance, not one loud frame and not a
            // strictly-consecutive run: a run resets on any intra-word energy dip, so real
            // speech that dips between syllables never confirms while steady noise does.
            if !(above && window_above >= self.trip_needed) {
                return;
            }
            self.in_utterance = true;
            self.confirmed = false;
            self.frames = self.pre_roll.drain(..).collect();
            self.utter_start_ms =
                now_ms.saturating_sub(self.frames.len() as u32 * self.cfg.frame_ms);
            // The frames that tripped the window were speech; count them as such rather
            // than restarting the confirmation clock from this one frame.
            self.voiced_ms = window_above as u32 * self.cfg.frame_ms;
            self.silence_run_ms = 0;
            self.last_voiced_ms = now_ms;
            self.recent_above.clear();
            if self.cfg.debug {
                events.push(VadEvent::Log(format!(
                    "vad: TRIPPED ({}) frame={} rms={rms:.4} floor={:.4} trigger={trigger:.4} window={window_above}/{}",
                    if playing { "playback" } else { "idle" },
                    self.frame_index,
                    self.quiet_floor,
                    self.trip_needed,
                )));
            }
            return;
        }

        self.frames.push(frame);
        if above {
            self.voiced_ms += self.cfg.frame_ms;
            self.silence_run_ms = 0;
            self.last_voiced_ms = now_ms;
            if !self.confirmed && self.voiced_ms >= self.cfg.min_speech_ms {
                self.confirmed = true;
                events.push(VadEvent::Log(format!(
                    "vad: speech confirmed at {}ms (voiced={}ms, trigger={trigger:.4})",
                    self.utter_start_ms, self.voiced_ms
                )));
            }
        } else {
            self.silence_run_ms += self.cfg.frame_ms;
        }

        let utter_ms = now_ms.saturating_sub(self.utter_start_ms);
        if self.silence_run_ms >= self.cfg.trailing_silence_ms {
            if self.confirmed {
                events.push(VadEvent::Endpoint(self.emit(EndpointReason::Silence)));
            } else {
                // Names itself as the DURATION rejection, and says the audio never left
                // this module — the other two rejections (no words, blocklisted phrase)
                // are logged by the turn, after whisper. A dead call cannot be read off
                // its log if "dropped a blip" covers all three of those at once.
                events.push(VadEvent::Log(format!(
                    "vad: dropped a blip — too short to be a turn (voiced={}ms < min {}ms, at {}ms); never reached whisper",
                    self.voiced_ms, self.cfg.min_speech_ms, now_ms
                )));
            }
            self.reset();
        } else if self.confirmed && utter_ms >= self.cfg.max_utterance_ms {
            events.push(VadEvent::Endpoint(self.emit(EndpointReason::MaxUtterance)));
            self.reset();
        }
    }

    /// Decide what a finished calibration window was worth. Locking is NOT automatic — the
    /// endpointer would rather stay on the conservative default bar and measure again than
    /// lock one it can prove is wrong.
    fn close_calibration_window(&mut self, cut_short: bool, events: &mut Vec<VadEvent>) {
        let frames = self.ambient.len();
        if cut_short && frames < self.calibration_frames {
            // fig started talking before the room was ever sampled. What's in the window is
            // a fragment and everything after it is their own audio bleeding back, so there
            // is nothing here worth measuring — take the default bar, which is the
            // sensitive one, over a floor built from a handful of frames.
            self.quiet_floor = self.cfg.silence_floor;
            self.floor_locked = true;
            events.push(VadEvent::Log(format!(
                "vad: calibration cut short by playback after {frames}/{} frames — holding the default floor {:.4} (trigger {:.4} idle / {:.4} playing)",
                self.calibration_frames,
                self.quiet_floor,
                self.trigger(false),
                self.trigger(true),
            )));
            return;
        }

        let measured = percentile_90(&self.ambient).max(self.cfg.silence_floor);
        self.calibration_attempts += 1;
        let last_chance = self.calibration_attempts >= MAX_CALIBRATION_ATTEMPTS;
        if measured * self.cfg.trigger_multiplier >= self.cfg.trigger_ceiling && !last_chance {
            events.push(VadEvent::Log(format!(
                "vad: rejected a calibration window (floor={measured:.4} → a trigger at the {:.4} ceiling, which their voice can't clear) — remeasuring, attempt {} of {MAX_CALIBRATION_ATTEMPTS}",
                self.cfg.trigger_ceiling,
                self.calibration_attempts + 1,
            )));
            self.ambient.clear();
            return;
        }

        self.quiet_floor = measured;
        self.floor_locked = true;
        events.push(VadEvent::Log(format!(
            "vad: calibrated quiet floor={:.4} ({frames} frames, x{:.1} → trigger {:.4} idle / {:.4} playing){}",
            self.quiet_floor,
            self.cfg.trigger_multiplier,
            self.trigger(false),
            self.trigger(true),
            if last_chance && self.calibration_attempts > 1 {
                " — the room never went quiet, so this is the ceiling"
            } else {
                ""
            },
        )));
    }

    fn push_ambient(&mut self, rms: f32) {
        self.ambient.push_back(rms);
        while self.ambient.len() > self.ambient_cap {
            self.ambient.pop_front();
        }
    }

    fn remember_pre_roll(&mut self, frame: Vec<u8>) {
        self.pre_roll.push_back(frame);
        while self.pre_roll.len() > self.pre_roll_frames {
            self.pre_roll.pop_front();
        }
    }

    fn track_playback_phase(&mut self, playing: bool, events: &mut Vec<VadEvent>) {
        if playing && !self.playing_prev && (!self.playback_seen || self.frames_since_playback > self.rearm_gap_frames) {
            self.grace_remaining = self.grace_frames;
            if self.cfg.debug {
                events.push(VadEvent::Log(format!(
                    "vad: playback started (frame={}) — grace {}ms",
                    self.frame_index, self.cfg.grace_ms
                )));
            }
        }
        if playing {
            self.playback_seen = true;
        }
        self.playing_prev = playing;
        self.frames_since_playback = if playing {
            0
        } else {
            self.frames_since_playback.saturating_add(1)
        };
    }

    fn emit(&self, reason: EndpointReason) -> Utterance {
        let drop_frames =
            self.silence_run_ms.saturating_sub(self.cfg.keep_tail_ms) / self.cfg.frame_ms;
        let keep = self.frames.len().saturating_sub(drop_frames as usize);
        let pcm = self.frames[..keep].concat();
        Utterance {
            pcm,
            start_ms: self.utter_start_ms,
            end_ms: self.last_voiced_ms,
            speech_ms: self.voiced_ms,
            silence_ms: self.silence_run_ms,
            reason,
        }
    }

    fn reset(&mut self) {
        self.in_utterance = false;
        self.confirmed = false;
        self.frames.clear();
        self.voiced_ms = 0;
        self.silence_run_ms = 0;
        self.recent_above.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(ms: usize, amplitude: i16) -> Vec<u8> {
        let samples = 24_000 * ms / 1000;
        (0..samples).flat_map(|_| amplitude.to_le_bytes()).collect()
    }

    /// A calibrated VAD has to hear the room before it can hear them — every test that
    /// isn't ABOUT calibration opens with a quiet room, the same way a real call does.
    fn quiet_room(vad: &mut VadEndpointer) -> Vec<VadEvent> {
        vad.push(&pcm(1_000, 100), false)
    }

    fn logs(events: &[VadEvent]) -> Vec<&String> {
        events
            .iter()
            .filter_map(|event| match event {
                VadEvent::Log(line) => Some(line),
                _ => None,
            })
            .collect()
    }

    fn endpoints(events: &[VadEvent]) -> Vec<&Utterance> {
        events
            .iter()
            .filter_map(|event| match event {
                VadEvent::Endpoint(utterance) => Some(utterance),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn endpoints_after_configured_trailing_silence_with_same_numbers() {
        let mut vad = VadEndpointer::new(VadConfig {
            trailing_silence_ms: 1_800,
            ..VadConfig::default()
        });
        quiet_room(&mut vad);
        let mut events = vad.push(&pcm(500, 4000), false);
        events.extend(vad.push(&pcm(1_800, 0), false));
        let out = endpoints(&events);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reason, EndpointReason::Silence);
        assert_eq!(out[0].silence_ms, 1_800);
    }

    #[test]
    fn drops_a_blip_too_short_to_even_start_an_utterance() {
        let mut vad = VadEndpointer::new(VadConfig::default());
        quiet_room(&mut vad);
        // 200ms is under the 300ms start window, so this never becomes an utterance at all.
        let mut events = vad.push(&pcm(200, 4000), false);
        events.extend(vad.push(&pcm(1_800, 0), false));
        assert!(endpoints(&events).is_empty());
    }

    /// The dead call: 48 seconds, zero turns. The VAD saw exactly two things and dropped both —
    /// `voiced=300ms < min 450ms` and `voiced=280ms < min 450ms` — and the tapout window
    /// peaks over that stretch (0.4056, 0.2932) say those were their voice, not the room.
    /// A short greeting is how a call opens, so it has to survive to whisper.
    #[test]
    fn the_short_hello_that_was_never_heard_on_8_1_now_reaches_whisper() {
        for voiced_ms in [280usize, 300] {
            let mut vad = VadEndpointer::new(VadConfig::default());
            quiet_room(&mut vad);
            let mut events = vad.push(&pcm(voiced_ms, 4000), false);
            events.extend(vad.push(&pcm(1_800, 0), false));
            assert_eq!(
                endpoints(&events).len(),
                1,
                "{voiced_ms}ms of their voice was dropped again"
            );
        }

        // …and 640ms, the shortest real utterance measured on a live call, obviously still does.
        let mut vad = VadEndpointer::new(VadConfig::default());
        quiet_room(&mut vad);
        let mut events = vad.push(&pcm(640, 4000), false);
        events.extend(vad.push(&pcm(1_800, 0), false));
        assert_eq!(endpoints(&events).len(), 1);
    }

    /// What the duration bar does not decide, whisper does. The same 280ms utterance is
    /// only a turn if there are WORDS in it — an empty transcript or one of the phrases
    /// whisper invents on silence is rejected on the far side of the same path, which is
    /// what makes lowering the bar safe (main.rs `on_utterance` runs every endpoint
    /// through `hear` before anything else can act on it).
    #[test]
    fn a_short_utterance_still_has_to_survive_whisper() {
        use crate::transcript::{hear, Heard, NotSpeech};

        let mut vad = VadEndpointer::new(VadConfig::default());
        quiet_room(&mut vad);
        let mut events = vad.push(&pcm(280, 4000), false);
        events.extend(vad.push(&pcm(1_800, 0), false));
        let out = endpoints(&events);
        assert_eq!(out.len(), 1, "the 280ms utterance never got to whisper");
        // Enough audio arrived with it that whisper has their first syllable, not its tail:
        // 600ms of pre-roll in front of a 280ms word.
        assert!(
            crate::pcm_seconds(&out[0].pcm) > 0.6,
            "only {:.2}s of audio reached whisper",
            crate::pcm_seconds(&out[0].pcm)
        );

        // Whatever whisper makes of it decides, and it has to say which rejection it was.
        assert_eq!(hear(""), Heard::Nothing(NotSpeech::NoWords));
        assert_eq!(hear("Thank you."), Heard::Nothing(NotSpeech::Phantom));
        assert_eq!(
            hear("hello?"),
            Heard::Speech {
                text: "hello?".to_owned(),
                looped: 0
            }
        );
    }

    /// And when the duration bar does reject something, the log says so — a log line is
    /// unreadable if "dropped a blip" covers too short, no words and blocklisted all
    /// at once.
    #[test]
    fn the_duration_rejection_names_itself_in_the_log() {
        let mut vad = VadEndpointer::new(VadConfig {
            // Only reachable with a bar above the 240ms the start window already implies.
            min_speech_ms: 600,
            ..VadConfig::default()
        });
        quiet_room(&mut vad);
        let mut events = vad.push(&pcm(400, 4000), false);
        events.extend(vad.push(&pcm(1_800, 0), false));
        assert!(endpoints(&events).is_empty());
        assert!(
            logs(&events)
                .iter()
                .any(|line| line.contains("too short to be a turn")
                    && line.contains("never reached whisper")),
            "the drop didn't say why: {:?}",
            logs(&events)
        );
    }

    #[test]
    fn quiet_room_tone_never_confirms() {
        // Steady room tone, whatever its absolute level: the floor calibrates TO it, so it
        // can never clear its own trigger. This is the whole point of calibrating.
        for level in [200i16, 600, 1200] {
            let mut vad = VadEndpointer::new(VadConfig::default());
            let mut events = vad.push(&pcm(4_000, level), false);
            events.extend(vad.flush());
            assert!(
                endpoints(&events).is_empty(),
                "room tone at {level} confirmed as speech"
            );
        }
    }

    #[test]
    fn the_floor_is_measured_from_the_room_not_hardcoded() {
        let cfg = VadConfig::default();
        let mut quiet = VadEndpointer::new(cfg.clone());
        quiet.push(&pcm(1_000, 100), false);
        let mut busier = VadEndpointer::new(cfg.clone());
        busier.push(&pcm(1_000, 400), false);
        assert!(
            busier.quiet_floor() > quiet.quiet_floor()
                && busier.trigger(false) > quiet.trigger(false),
            "a busier room and a quiet one produced the same bar: {} vs {}",
            busier.trigger(false),
            quiet.trigger(false)
        );
        assert_eq!(busier.trigger(false), busier.quiet_floor() * cfg.trigger_multiplier);

        // …and neither end runs away. A dead mic can't drop the bar to zero:
        let mut dead = VadEndpointer::new(cfg.clone());
        dead.push(&pcm(1_000, 0), false);
        assert_eq!(dead.quiet_floor(), cfg.silence_floor);
        assert!(dead.trigger(false) >= cfg.silence_floor * 2.0);
        // …and a party can't push it past what their voice actually reaches. It takes the
        // full run of attempts to get there now — a room this loud is rejected as a
        // measurement first, and only accepted once it proves it is the actual room.
        let mut party = VadEndpointer::new(cfg.clone());
        party.push(&pcm(3_000, 8000), false);
        assert_eq!(party.trigger(false), cfg.trigger_ceiling);
    }

    /// The aggregate-device case: the first 440ms off the tap is the device coming up,
    /// not the room. It reads 0.0943 — 15x the true floor — and locking there
    /// and clamped the trigger to the 0.0600 ceiling, leaving fig nearly deaf. Only the
    /// idle drift walked the bar back down before they spoke 25s later.
    #[test]
    fn a_startup_burst_is_rejected_instead_of_locking_a_deaf_floor() {
        let cfg = VadConfig::default();
        let mut vad = VadEndpointer::new(cfg.clone());
        // A window of it at 3100/32768 = 0.0946, the level that call actually measured.
        let events = vad.push(&pcm(460, 3100), false);
        assert!(
            logs(&events).iter().any(|line| line.contains("rejected a calibration window")),
            "locked a floor off the device coming up: {:?}",
            logs(&events)
        );
        assert!(
            vad.trigger(false) < cfg.trigger_ceiling,
            "the bar clamped to the ceiling anyway: {}",
            vad.trigger(false)
        );

        // The room, once it's actually the room, calibrates normally.
        let events = vad.push(&pcm(500, 100), false);
        assert!(
            logs(&events).iter().any(|line| line.contains("calibrated quiet floor")),
            "never locked once the room was quiet: {:?}",
            logs(&events)
        );
        assert_eq!(vad.quiet_floor(), cfg.silence_floor);

        // And the thing that failure cost: they speak at the low end of their measured band
        // (1200/32768 = 0.0366, inside the 0.03-0.09 the tap reads them at) and are heard.
        // Against the clamped 0.0600 ceiling this never trips at all.
        let mut events = vad.push(&pcm(700, 1200), false);
        events.extend(vad.push(&pcm(1_800, 0), false));
        assert_eq!(
            endpoints(&events).len(),
            1,
            "their own voice couldn't clear the bar"
        );
    }

    /// The other way a window can be worthless: fig starts talking before the room was ever
    /// sampled, so the window is a fragment and everything after it is their own bleed.
    #[test]
    fn playback_before_the_room_is_sampled_holds_the_default_bar() {
        let cfg = VadConfig::default();
        let mut vad = VadEndpointer::new(cfg.clone());
        // 100ms of room — under a quarter of a window — and then fig's audio at a level
        // that would have locked a 0.0610 floor and a trigger at the ceiling.
        let mut events = vad.push(&pcm(100, 2000), false);
        events.extend(vad.push(&pcm(100, 2000), true));
        assert!(
            logs(&events).iter().any(|line| line.contains("cut short by playback")),
            "measured a floor off a fragment: {:?}",
            logs(&events)
        );
        assert_eq!(vad.quiet_floor(), cfg.silence_floor);
        assert!(vad.trigger(false) < cfg.trigger_ceiling);
    }

    /// Calibration is dated to the first frame the source delivered, because there is
    /// nothing to measure before one arrives.
    #[test]
    fn calibration_is_announced_by_the_first_frame_not_by_the_reader() {
        let mut vad = VadEndpointer::new(VadConfig::default());
        // Less than one frame: nothing has been measured, so nothing is claimed.
        let events = vad.push(&pcm(10, 100), false);
        assert!(events.is_empty(), "announced before a frame existed: {events:?}");

        let events = vad.push(&pcm(40, 100), false);
        assert!(
            logs(&events)
                .first()
                .is_some_and(|line| line.contains("calibrating the room")),
            "the first frame did not open calibration: {:?}",
            logs(&events)
        );
    }

    #[test]
    fn playback_freezes_the_floor_so_bleed_is_never_calibrated_in() {
        let cfg = VadConfig::default();
        let mut vad = VadEndpointer::new(cfg.clone());
        quiet_room(&mut vad);
        let calibrated = vad.quiet_floor();
        // A long stretch of fig's own audio bleeding back at a level that WOULD raise the
        // floor if it were sampled.
        vad.push(&pcm(3_000, 900), true);
        assert_eq!(
            vad.quiet_floor(),
            calibrated,
            "the floor drifted while fig was talking"
        );
        assert!(vad.trigger(true) >= cfg.playback_min_trigger);
    }

    #[test]
    fn an_intra_word_dip_does_not_reset_the_start_window() {
        // 300ms window, 80% of it needed: speech with one 20ms dip in the middle still
        // trips, where a strictly-consecutive run would start over.
        let mut vad = VadEndpointer::new(VadConfig::default());
        quiet_room(&mut vad);
        let mut events = vad.push(&pcm(200, 4000), false);
        events.extend(vad.push(&pcm(20, 0), false));
        events.extend(vad.push(&pcm(500, 4000), false));
        events.extend(vad.push(&pcm(1_800, 0), false));
        assert_eq!(endpoints(&events).len(), 1, "one dip lost the whole utterance");
    }

    #[test]
    fn the_grace_window_swallows_the_playback_onset() {
        let cfg = VadConfig::default();
        let mut vad = VadEndpointer::new(cfg.clone());
        quiet_room(&mut vad);
        // Playback starts and the onset transient is loud enough to clear even the
        // playback trigger — the first 500ms of it may not start an utterance.
        let events = vad.push(&pcm(cfg.grace_ms as usize, 8000), true);
        assert!(endpoints(&events).is_empty());
        // Past the grace window the same level does trip, so grace suppresses, not deafens.
        let mut events = vad.push(&pcm(2_000, 8000), true);
        events.extend(vad.push(&pcm(1_800, 0), false));
        assert_eq!(endpoints(&events).len(), 1);
    }

    #[test]
    fn flush_emits_confirmed_utterance() {
        let mut vad = VadEndpointer::new(VadConfig::default());
        quiet_room(&mut vad);
        let mut events = vad.push(&pcm(700, 4000), false);
        events.extend(vad.flush());
        let out = endpoints(&events);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reason, EndpointReason::Flush);
    }

    #[test]
    fn two_minutes_before_a_sentence_is_cut_in_half() {
        // Twice on one call, `ENDPOINT (max-utterance) … 30.00s kept` split one thought in
        // two mid-sentence. Nothing under two minutes may do that again.
        let cfg = VadConfig::default();
        assert_eq!(cfg.max_utterance_ms, 120_000);
        let mut vad = VadEndpointer::new(cfg);
        quiet_room(&mut vad);
        let events = vad.push(&pcm(45_000, 4000), false);
        assert!(
            endpoints(&events).is_empty(),
            "45s of talking was cut short again"
        );
    }

    #[test]
    fn debug_mode_reports_the_decision_and_silence_stays_quiet() {
        let mut vad = VadEndpointer::new(VadConfig {
            debug: true,
            ..VadConfig::default()
        });
        quiet_room(&mut vad);
        let events = vad.push(&pcm(400, 4000), false);
        let lines: Vec<&String> = events
            .iter()
            .filter_map(|event| match event {
                VadEvent::Log(line) => Some(line),
                _ => None,
            })
            .collect();
        assert!(
            lines.iter().any(|line| line.contains("TRIPPED")),
            "no trip line in debug mode: {lines:?}"
        );
        assert!(
            lines.iter().any(|line| line.contains("floor=") && line.contains("trigger=")),
            "debug mode printed no per-frame floor/trigger: {lines:?}"
        );

        // Below half the trigger it must not be a firehose — a silent call would otherwise
        // write 50 lines a second into the session log.
        let mut quiet = VadEndpointer::new(VadConfig {
            debug: true,
            ..VadConfig::default()
        });
        quiet_room(&mut quiet);
        let events = quiet.push(&pcm(1_000, 0), false);
        assert!(events.is_empty(), "silence logged in debug mode: {events:?}");
    }
}
