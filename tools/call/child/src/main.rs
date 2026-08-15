use anyhow::{Context, Result};
use fig_call_child::audio::{Mouth, TapPipe};
use fig_call_child::barge::{cuts_fig_off, folds_into_turn};
use fig_call_child::bridge::BridgeClient;
use fig_call_child::clause::ClauseSplitter;
use fig_call_child::drain::{cap_hit_reason, wait_until_drained, DrainOutcome, DrainPolicy};
use fig_call_child::hold::HoldWatchdog;
use fig_call_child::interrupt::InterruptLatch;
use fig_call_child::pending::PendingSpeech;
use fig_call_child::transcript::{hear, tail_chars, Heard};
use fig_call_child::vad::{Utterance, VadConfig, VadEndpointer, VadEvent};
use fig_call_child::wav::{read_wav_24k_mono, write_wav_24k_mono};
use fig_call_child::worker::{transcribe_one_shot, LineWorker};
use fig_call_child::{epoch_ms, log, pcm_seconds, SAMPLE_RATE};
use serde_json::json;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Mutex, Notify};

const MAX_SESSION_MS: u64 = 60 * 60 * 1000;
const HOLD_EXPIRE_MS: u64 = 120_000;
const TAP_SILENCE_MS: u64 = 60_000;
const TRUNCATED_MARK: &str = "…[cut off — they talked over the rest]";
/// A producer that has gone quiet for this long is stalled, not mid-thought.
const IDLE_FLUSH_MS: u64 = 500;
/// …and only a buffer this long is worth speaking unfinished. Both are Hermes'
/// `queue_timeout` / `long_flush_len`: a model that stops mid-reply must not leave a
/// sentence sitting silent in the buffer with them waiting on it.
const IDLE_FLUSH_CHARS: usize = 100;

#[derive(Debug)]
struct Args {
    hold: bool,
    bench_in: Option<PathBuf>,
    bench_out: Option<PathBuf>,
    outbound_reason: Option<String>,
    bridge_socket: Option<PathBuf>,
    bridge_token: Option<String>,
    protocol_probe: bool,
}

impl Args {
    fn parse() -> Self {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let value = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|index| args.get(index + 1))
                .cloned()
        };
        Self {
            hold: args.iter().any(|arg| arg == "--hold"),
            bench_in: value("--bench").map(PathBuf::from),
            bench_out: value("--out").map(PathBuf::from),
            outbound_reason: value("--outbound-reason"),
            bridge_socket: value("--bridge-socket").map(PathBuf::from),
            bridge_token: value("--bridge-token"),
            protocol_probe: args.iter().any(|arg| arg == "--protocol-probe"),
        }
    }
}

#[derive(Clone)]
enum Output {
    Live(Mouth),
    Bench(Arc<StdMutex<Vec<u8>>>),
}

struct WhisperSlot {
    worker: Mutex<Option<LineWorker>>,
    notify: Notify,
    failed: AtomicBool,
    restart_used: AtomicBool,
}

impl WhisperSlot {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            worker: Mutex::new(None),
            notify: Notify::new(),
            failed: AtomicBool::new(false),
            restart_used: AtomicBool::new(false),
        })
    }

    fn start_background(self: &Arc<Self>, repo_root: PathBuf, tag: &'static str) {
        let slot = self.clone();
        tokio::spawn(async move {
            match LineWorker::start_whisper(&repo_root).await {
                Ok((worker, load_s)) => {
                    log(format!("whisper worker up in {load_s}s ({tag})"));
                    *slot.worker.lock().await = Some(worker);
                }
                Err(error) => {
                    log(format!(
                        "whisper worker failed to start ({error}) — one-shot CLI stt from here"
                    ));
                    slot.failed.store(true, Ordering::SeqCst);
                }
            }
            slot.notify.notify_waiters();
        });
    }

    async fn transcribe(&self, repo_root: &Path, wav: &Path) -> Result<(String, String)> {
        loop {
            {
                let mut guard = self.worker.lock().await;
                if let Some(worker) = guard.as_mut() {
                    let started = Instant::now();
                    match worker.transcribe(wav).await {
                        Ok(text) => {
                            return Ok((
                                text,
                                format!("worker ({}ms)", started.elapsed().as_millis()),
                            ))
                        }
                        Err(error) => {
                            log(format!("whisper worker transcribe failed ({error})"));
                            worker.stop().await;
                            *guard = None;
                            if !self.restart_used.swap(true, Ordering::SeqCst) {
                                drop(guard);
                                match LineWorker::start_whisper(repo_root).await {
                                    Ok((worker, load_s)) => {
                                        log(format!(
                                            "whisper worker up in {load_s}s (restart after death)"
                                        ));
                                        *self.worker.lock().await = Some(worker);
                                        continue;
                                    }
                                    Err(restart_error) => log(format!(
                                        "whisper worker restart failed ({restart_error}) — CLI stt from here"
                                    )),
                                }
                            }
                            self.failed.store(true, Ordering::SeqCst);
                        }
                    }
                }
            }
            if self.failed.load(Ordering::SeqCst) {
                let (text, ms) = transcribe_one_shot(wav).await?;
                return Ok((text, format!("cli one-shot ({ms}ms)")));
            }
            self.notify.notified().await;
        }
    }

    async fn stop(&self) {
        if let Some(worker) = self.worker.lock().await.as_mut() {
            worker.stop().await;
        }
    }
}

struct Runtime {
    repo_root: PathBuf,
    bridge: Option<BridgeClient>,
    kokoro: Mutex<LineWorker>,
    whisper: Arc<WhisperSlot>,
    output: StdMutex<Option<Output>>,
    generation: AtomicU64,
    /// Bumped every time the mouth is emptied. A paced write checks this as well as its
    /// generation, so a flush or a teardown stops a clause mid-hand-over instead of
    /// dribbling the rest of it into a queue nobody is listening to any more.
    flush_epoch: AtomicU64,
    turn_in_flight: AtomicBool,
    speaking_until: AtomicU64,
    spoken: StdMutex<Vec<String>>,
    /// They talked over the last reply — carried to the NEXT turn's prompt and nowhere else
    /// (interrupt.rs).
    interrupted: InterruptLatch,
    /// What they said into the current turn's thinking silence — answered as soon as that
    /// turn lands, instead of replacing it (see barge.rs). The ONLY carrier for those
    /// words until a turn asks them, and it hands each utterance out exactly once
    /// (pending.rs).
    follow_ups: PendingSpeech,
    /// The in-flight brain request, so superseding a turn can actually CANCEL it.
    ask_handle: StdMutex<Option<tokio::task::AbortHandle>>,
    bench_done: mpsc::UnboundedSender<()>,
}

impl Runtime {
    fn set_output(&self, output: Output) {
        *self.output.lock().expect("output") = Some(output);
    }

    /// Speak one rendered clause, PACED: the device's own clock decides how fast this
    /// returns, so the mouth never holds more than `PLAYBACK_LEAD_MS` of unplayed audio
    /// beyond the clause going in (audio.rs). It therefore blocks for roughly the length
    /// of the clause — which is the point, it's what stops kokoro rendering the whole
    /// reply ahead of the ear.
    ///
    /// `alive` is the caller's claim on the mouth: a turn passes its generation, the
    /// outbound opener passes none (nothing owns it but a flush).
    async fn speak(&self, pcm: Vec<u8>, alive: Option<u64>) -> bool {
        let mouth = match self.output.lock().expect("output").as_ref() {
            Some(Output::Live(mouth)) => mouth.clone(),
            Some(Output::Bench(buffer)) => {
                buffer.lock().expect("bench output").extend(&pcm);
                self.bump_speaking_clock(&pcm);
                return true;
            }
            None => return false,
        };
        self.bump_speaking_clock(&pcm);
        let epoch = self.flush_epoch.load(Ordering::SeqCst);
        mouth
            .play_paced(&pcm, || {
                self.flush_epoch.load(Ordering::SeqCst) == epoch
                    && alive.is_none_or(|generation| {
                        self.generation.load(Ordering::SeqCst) == generation
                    })
            })
            .await
    }

    fn flush_playback(&self) {
        self.flush_epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(Output::Live(mouth)) = self.output.lock().expect("output").as_ref() {
            mouth.flush();
        }
    }

    fn stop_output(&self) {
        self.flush_epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(Output::Live(mouth)) = self.output.lock().expect("output").as_ref() {
            mouth.stop();
        }
    }

    fn bump_speaking_clock(&self, pcm: &[u8]) {
        let duration_ms = (pcm_seconds(pcm) * 1000.0) as u64;
        let now = epoch_ms() as u64;
        let mut old = self.speaking_until.load(Ordering::Relaxed);
        loop {
            let new = old.max(now).saturating_add(duration_ms);
            match self.speaking_until.compare_exchange_weak(
                old,
                new,
                Ordering::SeqCst,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(current) => old = current,
            }
        }
    }

    fn is_busy(&self) -> bool {
        self.turn_in_flight.load(Ordering::SeqCst)
            || (epoch_ms() as u64) < self.speaking_until.load(Ordering::SeqCst)
    }

    /// Real samples still sitting in the cpal queue, or the enqueued-duration clock still
    /// running. In-process cpal owns the deque, so "empty" here is the device's own
    /// truth, not a duration estimate.
    fn audio_pending(&self) -> bool {
        if (epoch_ms() as u64) < self.speaking_until.load(Ordering::SeqCst) {
            return true;
        }
        matches!(
            self.output.lock().expect("output").as_ref(),
            Some(Output::Live(mouth)) if mouth.queued_samples() > 0
        )
    }

    /// Everything they haven't heard yet, INCLUDING a turn still being thought/rendered.
    /// That's the hangup case: `hang_up` fires when the text is done, long before the
    /// goodbye's last clause has been rendered, let alone played.
    fn playback_pending(&self) -> bool {
        self.turn_in_flight.load(Ordering::SeqCst) || self.audio_pending()
    }

    /// Wait for the mouth to finish, plus the device tail pad. Everything that ends a
    /// call goes through here — a fixed timer truncates goodbyes still playing.
    ///
    /// `wait_for_turn = false` is the teardown case: the call is already gone, so don't
    /// hold the child open for a turn nobody will hear — but don't cut the clause that's
    /// playing right now either.
    async fn drain_playback(
        self: &Arc<Self>,
        policy: DrainPolicy,
        wait_for_turn: bool,
    ) -> (DrainOutcome, Duration) {
        let runtime = self.clone();
        wait_until_drained(
            move || {
                if wait_for_turn {
                    runtime.playback_pending()
                } else {
                    runtime.audio_pending()
                }
            },
            policy,
        )
        .await
    }

    /// The drain outcome, saying what was ACTUALLY still outstanding — the hangup drain
    /// waits on the turn as well as the mouth (drain.rs).
    fn drain_log(&self, outcome: DrainOutcome) -> &'static str {
        match outcome {
            DrainOutcome::Drained => outcome.as_log(),
            DrainOutcome::TimedOut => cap_hit_reason(
                self.turn_in_flight.load(Ordering::SeqCst),
                self.audio_pending(),
            ),
        }
    }

    fn clauses_played(&self) -> usize {
        self.spoken.lock().expect("spoken").len()
    }

    /// Retire the current turn: nothing it produces from here counts.
    ///
    /// Cancelling the brain request is the load-bearing half. The turn runs IN THE BOT,
    /// so a child that merely ignores the reply leaves the turn alive there — and its
    /// TOOL CALLS still execute. That's how a discarded turn pressed End and hung up on
    /// them mid-sentence on a live call. Dropping the bridge socket is what stops it.
    ///
    /// Deliberately leaves `follow_ups` alone: those are words HE said and nobody has
    /// answered, so retiring a turn must not delete them. The utterance that supersedes
    /// this turn picks them up and asks them together (`PendingSpeech::take_with`).
    fn supersede(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(handle) = self.ask_handle.lock().expect("ask handle").take() {
            handle.abort();
        }
        generation
    }

    /// Cut fig off: they spoke real words over audio they could actually hear. Called only
    /// once whisper has confirmed there were words — see `on_utterance`.
    fn barge_in(self: &Arc<Self>) {
        if !self.is_busy() {
            return;
        }
        if !cuts_fig_off(
            self.clauses_played(),
            self.turn_in_flight.load(Ordering::SeqCst),
            self.audio_pending(),
        ) {
            // They talked into the thinking silence. The reply they're waiting on hasn't
            // reached their ears yet, so cutting it only restarts a cold clock — the
            // utterance folds into this same turn instead (see barge.rs).
            log("speech during thinking silence — keeping the in-flight turn (nothing played yet)");
            return;
        }
        self.supersede();
        self.flush_playback();
        self.speaking_until.store(0, Ordering::SeqCst);
        self.turn_in_flight.store(false, Ordering::SeqCst);
        let heard = {
            let mut spoken = self.spoken.lock().expect("spoken");
            let heard = spoken.join(" ").trim().to_owned();
            spoken.clear();
            heard
        };
        if heard.is_empty() {
            log("barge-in: flushed before any clause played (reply discarded unspoken)");
        } else {
            log(format!(
                "barge-in: flushed playback; they heard up to: {:?}",
                tail_chars(&heard, 80)
            ));
            self.notify_note("fig", format!("{heard} {TRUNCATED_MARK}"));
        }
        // And TELL the brain, which until now was the one party that didn't know it had
        // been cut off. Prompt-only, popped by the turn this barge is about to start.
        self.interrupted.mark(heard);
    }

    fn notify_note(&self, speaker: &'static str, text: String) {
        if let Some(bridge) = self.bridge.clone() {
            tokio::spawn(async move {
                let _ = bridge
                    .notify("note", json!({ "speaker": speaker, "text": text }))
                    .await;
            });
        }
    }

    async fn render_clause(
        &self,
        generation: u64,
        clause: &str,
        first_audio: &AtomicBool,
        started: Instant,
    ) -> bool {
        let rendered = self.kokoro.lock().await.render(clause).await;
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        match rendered {
            Ok(pcm) => {
                // Counted as heard the moment playback STARTS, not when it ends: this is
                // both what "they heard up to" reports and what tells barge.rs a clause has
                // reached their ears, and the paced write below runs for the whole clause.
                self.spoken.lock().expect("spoken").push(clause.to_owned());
                if !first_audio.swap(true, Ordering::SeqCst) {
                    log(format!(
                        "first clause audio at +{}ms: {:?}",
                        started.elapsed().as_millis(),
                        clause.chars().take(60).collect::<String>()
                    ));
                }
                self.speak(pcm, Some(generation)).await;
                true
            }
            Err(error) => {
                log(format!("clause render failed (skipping it): {error}"));
                false
            }
        }
    }

    /// Ears half of a turn: transcribe what they said, then decide whether it REPLACES the
    /// turn in flight or joins it. Deliberately does not touch `generation` — an utterance
    /// that folds must leave the running turn completely alone.
    ///
    /// This is also where barge-in is decided, because it is the first moment anything
    /// knows whether there were WORDS in that audio. Energy alone was cutting fig off on
    /// doors, footsteps and their own speaker bleeding back.
    async fn on_utterance(self: Arc<Self>, utterance: Utterance) {
        let started = Instant::now();
        let wav = std::env::temp_dir().join(format!(
            "fig-call-utt-{}-{}.wav",
            std::process::id(),
            epoch_ms()
        ));
        let transcript = async {
            write_wav_24k_mono(&wav, &utterance.pcm)?;
            let result = self.whisper.transcribe(&self.repo_root, &wav).await;
            let _ = std::fs::remove_file(&wav);
            result
        }
        .await;
        let stt_ms = started.elapsed().as_millis();
        let (text, stt_path) = match transcript {
            Ok(result) => result,
            Err(error) => {
                log(format!("stt failed: {error}"));
                (String::new(), "failed".to_owned())
            }
        };
        log(format!("stt path: {stt_path}"));
        let question = match hear(&text) {
            // This is the ONLY gate doing this job — the VAD's duration bar deliberately
            // doesn't duplicate it: every endpoint reaches here, and nothing past it is energy
            // alone. It names which rejection it was so a session log can tell "they were
            // never heard" from "they were heard and there were no words in it".
            Heard::Nothing(why) => {
                log(format!(
                    "turn skipped: {} (stt {stt_ms}ms, heard {:?}) — reply left alone",
                    why.as_log(),
                    text.trim().chars().take(60).collect::<String>()
                ));
                return;
            }
            Heard::Speech { text, looped } => {
                if looped > 0 {
                    log(format!(
                        "collapsed a whisper loop: dropped {looped} repeat(s) of the same clause"
                    ));
                }
                text
            }
        };
        log(format!("[owner] {question} (stt {stt_ms}ms)"));
        self.barge_in();

        if folds_into_turn(
            self.clauses_played(),
            self.turn_in_flight.load(Ordering::SeqCst),
            self.audio_pending(),
        ) {
            self.follow_ups.fold(question);
            log("folded into the in-flight turn — they haven't heard anything yet, so it isn't restarted");
            // That turn can land between the check and the fold, which would strand this
            // in the queue until some later turn ends. Take it back if that happened —
            // the take shares the lock the turn drains with, so it can't be answered twice.
            if self.turn_in_flight.load(Ordering::SeqCst) {
                return;
            }
            let Some(stranded) = self.follow_ups.take() else {
                return;
            };
            self.on_question(stranded, started, stt_ms).await;
            return;
        }
        // Not folding: they're cutting fig off, or the line was idle. Either way this is the
        // turn that answers, so anything an earlier fold left queued rides along with it
        // rather than being dropped by the supersede or replayed as a second reply.
        let question = self.follow_ups.take_with(question);
        self.on_question(question, started, stt_ms).await;
    }

    /// Brain half of a turn: one question in, clauses out. Supersedes whatever was in
    /// flight, and is also how a folded follow-up gets answered once the turn it landed
    /// in is done.
    async fn on_question(self: Arc<Self>, question: String, started: Instant, stt_ms: u128) {
        let generation = self.supersede();
        self.turn_in_flight.store(true, Ordering::SeqCst);
        self.spoken.lock().expect("spoken").clear();
        let first_audio = Arc::new(AtomicBool::new(false));

        let (delta_tx, mut delta_rx) = mpsc::unbounded_channel();
        let bridge = self.bridge.clone();
        let asked = question.clone();
        // If they cut the last reply off, THIS is the turn that gets told about it.
        let interrupted = self.interrupted.take();
        if let Some(heard) = interrupted.as_deref() {
            log(format!(
                "telling the brain it was interrupted (they heard {} chars of the last reply)",
                heard.chars().count()
            ));
        }
        let ask = tokio::spawn(async move {
            if let Some(bridge) = bridge {
                bridge.ask_stream(asked, delta_tx, interrupted).await
            } else {
                Ok("my brain bridge is down — text me instead.".to_owned())
            }
        });
        *self.ask_handle.lock().expect("ask handle") = Some(ask.abort_handle());
        let mut splitter = ClauseSplitter::new();
        let mut first_delta_ms: i128 = -1;
        let mut first_audio_ms: i128 = -1;
        let mut clauses = 0u32;

        loop {
            let next =
                tokio::time::timeout(Duration::from_millis(IDLE_FLUSH_MS), delta_rx.recv()).await;
            if self.generation.load(Ordering::SeqCst) != generation {
                log("turn superseded mid-brain — discarding its reply");
                return;
            }
            let ready = match next {
                Ok(Some(delta)) => {
                    if first_delta_ms < 0 {
                        first_delta_ms = started.elapsed().as_millis() as i128;
                        log(format!("first brain delta at +{first_delta_ms}ms"));
                    }
                    splitter.push(&delta)
                }
                Ok(None) => break,
                // The producer went quiet mid-reply. A buffer this long is a thought they are
                // waiting on, so speak it rather than sitting on it (Hermes' long_flush).
                Err(_) => {
                    if splitter.buffered_chars() <= IDLE_FLUSH_CHARS {
                        continue;
                    }
                    log(format!(
                        "brain went quiet for {IDLE_FLUSH_MS}ms with {} chars buffered — speaking them",
                        splitter.buffered_chars()
                    ));
                    splitter.flush()
                }
            };
            for clause in ready {
                if self
                    .render_clause(generation, &clause, &first_audio, started)
                    .await
                {
                    clauses += 1;
                    if first_audio_ms < 0 {
                        first_audio_ms = started.elapsed().as_millis() as i128;
                    }
                }
            }
        }
        // Checked BEFORE the join: a superseded turn's request is cancelled, so awaiting it
        // here would only report its own cancellation as a brain failure.
        if self.generation.load(Ordering::SeqCst) != generation {
            log("turn superseded mid-brain — discarding its reply");
            return;
        }
        let final_text = match ask.await {
            Ok(Ok(text)) => text,
            Ok(Err(error)) => {
                log(format!("ask_stream failed: {error}"));
                "that lookup died on my end — text me and i'll pick it up there.".to_owned()
            }
            Err(error) => {
                log(format!("brain turn failed: {error}"));
                String::new()
            }
        };
        if self.generation.load(Ordering::SeqCst) != generation {
            log("turn superseded mid-brain — discarding its reply");
            return;
        }
        let tail = if first_delta_ms < 0 && !final_text.trim().is_empty() {
            let mut whole = ClauseSplitter::new();
            let mut clauses = whole.push(&final_text);
            clauses.extend(whole.flush());
            clauses
        } else {
            splitter.flush()
        };
        for clause in tail {
            if self
                .render_clause(generation, &clause, &first_audio, started)
                .await
            {
                clauses += 1;
                if first_audio_ms < 0 {
                    first_audio_ms = started.elapsed().as_millis() as i128;
                }
            }
        }
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        self.turn_in_flight.store(false, Ordering::SeqCst);
        *self.ask_handle.lock().expect("ask handle") = None;
        let spoken = {
            let mut spoken = self.spoken.lock().expect("spoken");
            let text = spoken.join(" ").trim().to_owned();
            spoken.clear();
            text
        };
        if spoken.is_empty() {
            log("turn produced no speakable audio");
        } else {
            log(format!("[fig] {spoken}"));
            self.notify_note("fig", spoken.clone());
        }
        if !splitter.dropped_urls.is_empty() {
            self.notify_note(
                "fig",
                format!(
                    "(links from that reply, not spoken: {})",
                    splitter.dropped_urls.join(" ")
                ),
            );
        }
        let total_ms = started.elapsed().as_millis();
        log(format!(
            "TURN TIMINGS: stt={stt_ms}ms first_delta={first_delta_ms}ms first_audio={first_audio_ms}ms total={total_ms}ms clauses={clauses}"
        ));
        let _ = self.bench_done.send(());

        // Anything they said into this turn's silence was kept, not answered — answer it now.
        if let Some(question) = self.follow_ups.take() {
            log(format!("picking up what they said while I was thinking: {question:?}"));
            self.clone().spawn_question(question);
        }
    }

    /// A turn answering a folded follow-up runs on its own task. Boxed on purpose: this is
    /// on_question spawning on_question, and an un-erased future type can't be recursive.
    fn spawn_question(self: Arc<Self>, question: String) {
        tokio::spawn(async move {
            let turn: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
                Box::pin(self.on_question(question, Instant::now(), 0));
            turn.await;
        });
    }

    async fn stop_workers(&self) {
        self.whisper.stop().await;
        self.kokoro.lock().await.stop().await;
    }
}

fn env_num(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(default)
}

/// Env overrides on top of the tuned defaults — the numbers themselves live in one place
/// (VadConfig::default), so a knob turned there can't drift from what the child runs.
/// They exist so a bad call can be re-run against a different bar without a rebuild;
/// `CALL_VAD_DEBUG=1` is the other half of that (it prints the decision per frame).
fn vad_config() -> VadConfig {
    let tuned = VadConfig::default();
    VadConfig {
        trigger_multiplier: env_num("CALL_VAD_MULTIPLIER", tuned.trigger_multiplier as f64) as f32,
        silence_floor: env_num("CALL_VAD_SILENCE_FLOOR", tuned.silence_floor as f64) as f32,
        playback_min_trigger: env_num(
            "CALL_VAD_PLAYBACK_MIN_TRIGGER",
            tuned.playback_min_trigger as f64,
        ) as f32,
        trigger_ceiling: env_num("CALL_VAD_TRIGGER_CEILING", tuned.trigger_ceiling as f64) as f32,
        calibration_ms: env_num("CALL_VAD_CALIBRATION_MS", tuned.calibration_ms as f64) as u32,
        sustained_ms: env_num("CALL_VAD_SUSTAINED_MS", tuned.sustained_ms as f64) as u32,
        grace_ms: env_num("CALL_VAD_GRACE_MS", tuned.grace_ms as f64) as u32,
        min_speech_ms: env_num("CALL_VAD_MIN_SPEECH_MS", tuned.min_speech_ms as f64) as u32,
        trailing_silence_ms: env_num("CALL_VAD_SILENCE_MS", tuned.trailing_silence_ms as f64) as u32,
        max_utterance_ms: env_num("CALL_VAD_MAX_UTTER_MS", tuned.max_utterance_ms as f64) as u32,
        debug: std::env::var("CALL_VAD_DEBUG").as_deref() == Ok("1"),
        ..tuned
    }
}

fn spawn_stdin() -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = tx.send(line.trim().to_owned());
        }
    });
    rx
}

async fn protocol_probe(args: &Args, mut commands: mpsc::UnboundedReceiver<String>) -> Result<()> {
    let mut released = !args.hold;
    let mut watchdog = args.hold.then(|| {
        let mut watchdog = HoldWatchdog::new(Duration::from_millis(HOLD_EXPIRE_MS));
        watchdog.arm_at(Instant::now());
        watchdog
    });
    println!("READY");
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { return Ok(()); };
                if command == "go" {
                    log("lane says go");
                    released = true;
                    if let Some(watchdog) = watchdog.as_mut() { watchdog.disarm(); }
                } else if command == "hold" {
                    if let Some(watchdog) = watchdog.as_mut() { watchdog.renew_at(Instant::now()); }
                    log("lane heartbeat — hold renewed");
                } else if command == "drain" {
                    // No mouth in the probe, so the queue is trivially empty — this
                    // exercises the WIRE half of the contract (the lane's End press
                    // blocks on this exact marker). The waiting half is drain.rs.
                    let (outcome, waited) = wait_until_drained(|| false, DrainPolicy::hangup()).await;
                    log(format!("lane asked to drain: {} after {}ms", outcome.as_log(), waited.as_millis()));
                    println!("DRAINED"); // the lane's press marker — parsed, don't reword
                    let _ = io::stdout().flush();
                } else if command == "abort" || command.starts_with("abort ") {
                    log(format!("shutdown: aborted by lane ({})", command.strip_prefix("abort").unwrap_or("").trim()));
                    return Ok(());
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if !released && watchdog.as_ref().is_some_and(|w| w.expired_at(Instant::now())) {
                    log("shutdown: hold expired with no go/abort/heartbeat (lane gone)");
                    return Ok(());
                }
            }
        }
    }
}

async fn consume_ears(
    runtime: Arc<Runtime>,
    mut ears: mpsc::UnboundedReceiver<Vec<u8>>,
    last_tap: Arc<AtomicU64>,
) {
    // No "calibrating the room" line here on purpose: this task is spawned before the tap
    // exists, so announcing from here dates calibration to the wrong moment (69ms before
    // tapout was even spawned). The endpointer logs it off its first real frame.
    let mut vad = VadEndpointer::new(vad_config());
    while let Some(chunk) = ears.recv().await {
        last_tap.store(epoch_ms() as u64, Ordering::SeqCst);
        // Is fig's audio flowing right now? The floor freezes while it is, so bleed can
        // never be calibrated in, and the trigger clamps up so bleed alone can't trip it.
        let playing = runtime.audio_pending();
        for event in vad.push(&chunk, playing) {
            match event {
                VadEvent::Log(message) => log(message),
                VadEvent::Endpoint(utterance) => {
                    log(format!(
                        "vad: ENDPOINT ({}) speech {}→{}ms voiced={}ms closedBy={}ms silence, {:.2}s kept",
                        utterance.reason.as_log(),
                        utterance.start_ms,
                        utterance.end_ms,
                        utterance.speech_ms,
                        utterance.silence_ms,
                        pcm_seconds(&utterance.pcm)
                    ));
                    tokio::spawn(runtime.clone().on_utterance(utterance));
                }
            }
        }
    }
    for event in vad.flush() {
        if let VadEvent::Endpoint(utterance) = event {
            tokio::spawn(runtime.clone().on_utterance(utterance));
        }
    }
}

fn main() -> Result<()> {
    // Not `#[tokio::main]`: the stdin-reader task lives on tokio's blocking
    // pool doing a blocking read() that only returns on EOF or more input.
    // Runtime::drop() waits for blocking-pool threads to finish, so once the
    // async body returns, a still-open stdin pipe would hang this process
    // forever instead of exiting. process::exit() sidesteps that wait
    // entirely — safe here since shutdown()/logging already ran and there's
    // nothing left that needs a graceful Drop.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build tokio runtime")?;
    let result = runtime.block_on(run());
    io::stdout().flush().ok();
    match &result {
        Ok(()) => process::exit(0),
        Err(err) => {
            eprintln!("{err:?}");
            process::exit(1);
        }
    }
}

async fn run() -> Result<()> {
    let args = Args::parse();
    let mut commands = spawn_stdin();
    if args.protocol_probe {
        return protocol_probe(&args, commands).await;
    }
    let started = Instant::now();
    let bench = args.bench_in.is_some();
    let bridged = args.bridge_socket.is_some() && args.bridge_token.is_some();
    log(format!(
        "LOCAL call session child start ({}{}{})",
        if bench { "BENCH" } else { "LIVE" },
        if args.hold { ", HOLD" } else { "" },
        if bridged { ", bridged" } else { ", NO BRIDGE" }
    ));
    log("front-end: local (whisper → streamed fig turn → kokoro)");
    let repo_root = std::env::current_dir().context("current repo directory")?;
    let bridge = match (args.bridge_socket.clone(), args.bridge_token.clone()) {
        (Some(socket), Some(token)) => match BridgeClient::connect(socket, token).await {
            Ok(bridge) => Some(bridge),
            Err(error) => {
                log(format!(
                    "bridge connect failed ({error}) — running without a brain"
                ));
                None
            }
        },
        _ => None,
    };

    let mut released = !args.hold;
    let mut watchdog = args.hold.then(|| {
        let mut watchdog = HoldWatchdog::new(Duration::from_millis(HOLD_EXPIRE_MS));
        watchdog.arm_at(Instant::now());
        watchdog
    });

    let prewarm = async {
        let (mut kokoro, load_s) = LineWorker::start_kokoro(&repo_root).await?;
        log(format!(
            "kokoro up in {load_s}s (model loaded while ringing)"
        ));
        // Only an OUTBOUND call opens with anything: fig dialed them, so fig says why.
        // An inbound call goes straight to listening — on a call nothing speaks but the
        // two of them, and a canned "hey, i'm here" is the system talking.
        let opener = match args.outbound_reason.as_deref() {
            Some(reason) => {
                let pcm = kokoro.render(reason).await?;
                log(format!("pre-rendered outbound opener ({:.2}s)", pcm_seconds(&pcm)));
                pcm
            }
            None => {
                log("inbound: no opener — the line is silent until they speak");
                Vec::new()
            }
        };
        Ok::<_, anyhow::Error>((kokoro, opener))
    };
    tokio::pin!(prewarm);
    let (kokoro, opener) = loop {
        tokio::select! {
            prepared = &mut prewarm => break prepared?,
            command = commands.recv() => {
                let Some(command) = command else { anyhow::bail!("lane stdin closed during prewarm"); };
                if command == "go" {
                    log("lane says go");
                    released = true;
                    if let Some(watchdog) = watchdog.as_mut() { watchdog.disarm(); }
                } else if command == "hold" {
                    if let Some(watchdog) = watchdog.as_mut() { watchdog.renew_at(Instant::now()); }
                    log("lane heartbeat — hold renewed");
                } else if command == "abort" || command.starts_with("abort ") {
                    log(format!("shutdown: aborted by lane ({})", command.strip_prefix("abort").unwrap_or("").trim()));
                    return Ok(());
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if !released && watchdog.as_ref().is_some_and(|w| w.expired_at(Instant::now())) {
                    log("shutdown: hold expired with no go/abort/heartbeat (lane gone)");
                    return Ok(());
                }
            }
        }
    };

    let whisper = WhisperSlot::new();
    whisper.start_background(repo_root.clone(), "pre-warm");
    let (bench_done_tx, mut bench_done_rx) = mpsc::unbounded_channel();
    let runtime = Arc::new(Runtime {
        repo_root: repo_root.clone(),
        bridge: bridge.clone(),
        kokoro: Mutex::new(kokoro),
        whisper,
        output: StdMutex::new(None),
        generation: AtomicU64::new(0),
        flush_epoch: AtomicU64::new(0),
        turn_in_flight: AtomicBool::new(false),
        speaking_until: AtomicU64::new(0),
        spoken: StdMutex::new(Vec::new()),
        interrupted: InterruptLatch::new(),
        follow_ups: PendingSpeech::new(),
        ask_handle: StdMutex::new(None),
        bench_done: bench_done_tx,
    });
    log(format!(
        "session ready at +{}ms",
        started.elapsed().as_millis()
    ));
    println!("READY");

    while !released {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break; };
                if command == "go" {
                    log("lane says go");
                    released = true;
                    if let Some(watchdog) = watchdog.as_mut() { watchdog.disarm(); }
                } else if command == "hold" {
                    if let Some(watchdog) = watchdog.as_mut() { watchdog.renew_at(Instant::now()); }
                    log("lane heartbeat — hold renewed");
                } else if command == "abort" || command.starts_with("abort ") {
                    let reason = format!("aborted by lane ({})", command.strip_prefix("abort").unwrap_or("").trim());
                    shutdown(&runtime, bridge.as_ref(), &reason).await;
                    return Ok(());
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if watchdog.as_ref().is_some_and(|w| w.expired_at(Instant::now())) {
                    shutdown(&runtime, bridge.as_ref(), "hold expired with no go/abort/heartbeat (lane gone)").await;
                    return Ok(());
                }
            }
        }
    }

    let (ear_tx, ear_rx) = mpsc::unbounded_channel();
    let (fatal_tx, mut fatal_rx) = mpsc::unbounded_channel();
    let last_tap = Arc::new(AtomicU64::new(0));
    tokio::spawn(consume_ears(runtime.clone(), ear_rx, last_tap.clone()));
    let mut tap_pipe = None;
    let bench_output = Arc::new(StdMutex::new(Vec::new()));
    if let Some(bench_in) = args.bench_in.as_ref() {
        runtime.set_output(Output::Bench(bench_output.clone()));
        let pcm = read_wav_24k_mono(bench_in)?;
        log(format!(
            "bench input: {} -> {:.2}s of speech",
            bench_in.display(),
            pcm_seconds(&pcm)
        ));
        for chunk in pcm.chunks(9_600) {
            let _ = ear_tx.send(chunk.to_vec());
        }
        let silence_bytes =
            ((vad_config().trailing_silence_ms + 600) as usize * SAMPLE_RATE as usize / 1000) * 2;
        let _ = ear_tx.send(vec![0; silence_bytes]);
    } else {
        let (mouth, mut mouth_fatal) = Mouth::start().await?;
        runtime.set_output(Output::Live(mouth));
        let fatal_forward = fatal_tx.clone();
        tokio::spawn(async move {
            while let Some(reason) = mouth_fatal.recv().await {
                let _ = fatal_forward.send(reason);
            }
        });
        tap_pipe = Some(TapPipe::start(&repo_root, ear_tx, fatal_tx.clone()).await?);
        if !opener.is_empty() {
            // Spawned: playback is paced by the device now, so awaiting it here would hold
            // this loop shut for the length of the opener. No generation claim — nothing
            // owns the opener except a flush (they talked over it).
            log(format!("outbound opener speaking ({:.2}s)", pcm_seconds(&opener)));
            let speaker = runtime.clone();
            tokio::spawn(async move { speaker.speak(opener, None).await });
        }
    }
    log(format!(
        "LIVE at +{}ms (ready+released)",
        started.elapsed().as_millis()
    ));

    let mut session_tick = tokio::time::interval(Duration::from_secs(5));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("install SIGTERM handler")?;
    let mut commands_open = true;
    // The pipe died (mouth gone / tap silent = call already over): there is nothing left
    // to drain INTO, so teardown skips the wait on that path only.
    let mut fatal_exit = false;
    let shutdown_reason = loop {
        tokio::select! {
            command = commands.recv(), if commands_open => {
                let Some(command) = command else {
                    commands_open = false;
                    continue;
                };
                if command == "abort" || command.starts_with("abort ") {
                    break format!("aborted by lane ({})", command.strip_prefix("abort").unwrap_or("").trim());
                } else if command == "drain" {
                    // The lane is holding its End press on this reply. Spawned, not
                    // awaited: this loop still has to service fatals and the tap
                    // watchdog while the goodbye finishes playing.
                    let runtime = runtime.clone();
                    tokio::spawn(async move {
                        let (outcome, waited) = runtime.drain_playback(DrainPolicy::hangup(), true).await;
                        log(format!(
                            "lane asked to drain: {} after {}ms",
                            runtime.drain_log(outcome),
                            waited.as_millis()
                        ));
                        println!("DRAINED"); // the lane's press marker — parsed, don't reword
                        let _ = io::stdout().flush();
                    });
                }
            }
            reason = fatal_rx.recv() => {
                fatal_exit = true;
                break reason.unwrap_or_else(|| "audio pipe fatal channel closed".to_owned());
            }
            _ = bench_done_rx.recv(), if bench => {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let output = bench_output.lock().expect("bench output").clone();
                if let Some(path) = args.bench_out.as_ref() {
                    write_wav_24k_mono(path, &output)?;
                    log(format!("bench: wrote {:.2}s of response audio -> {}", pcm_seconds(&output), path.display()));
                }
                break "bench complete".to_owned();
            }
            _ = session_tick.tick() => {
                let last = last_tap.load(Ordering::SeqCst);
                if !bench && last > 0 && epoch_ms() as u64 - last > TAP_SILENCE_MS {
                    break "no tap audio after having audio — call ended".to_owned();
                }
                if started.elapsed() >= Duration::from_millis(MAX_SESSION_MS) {
                    break "max session duration".to_owned();
                }
            }
            _ = tokio::signal::ctrl_c() => break "SIGINT".to_owned(),
            _ = terminate.recv() => break "SIGTERM".to_owned(),
        }
    };
    if let Some(tap) = tap_pipe.as_mut() {
        tap.stop().await;
    }
    shutdown_with(
        &runtime,
        bridge.as_ref(),
        &shutdown_reason,
        !bench && !fatal_exit,
    )
    .await;
    Ok(())
}

async fn shutdown(runtime: &Arc<Runtime>, bridge: Option<&BridgeClient>, reason: &str) {
    shutdown_with(runtime, bridge, reason, false).await;
}

/// `drain = true` means: let whatever is queued finish playing (plus the device pad)
/// BEFORE the mouth is stopped. Teardown must never be the thing that truncates the
/// last clause.
async fn shutdown_with(
    runtime: &Arc<Runtime>,
    bridge: Option<&BridgeClient>,
    reason: &str,
    drain: bool,
) {
    log(format!("shutdown: {reason}"));
    if drain {
        let (outcome, waited) = runtime.drain_playback(DrainPolicy::teardown(), false).await;
        log(format!(
            "teardown drain: {} after {}ms",
            runtime.drain_log(outcome),
            waited.as_millis()
        ));
    }
    // They said this into a turn's silence and the call ended before anything asked it. Their
    // line is normally written by the turn that asks it, so without this the words would
    // exist nowhere: not answered, not remembered.
    if let Some(unanswered) = runtime.follow_ups.take() {
        log(format!(
            "call ended with speech nothing answered (kept in the transcript): {unanswered:?}"
        ));
        if let Some(bridge) = bridge {
            let _ = bridge
                .notify("note", json!({ "speaker": "owner", "text": unanswered }))
                .await;
        }
    }
    if let Some(bridge) = bridge {
        let _ = bridge.notify("ended", json!({ "reason": reason })).await;
    }
    runtime.stop_output();
    runtime.stop_workers().await;
}
