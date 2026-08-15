use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc as tokio_mpsc;

use crate::{log, SAMPLE_RATE};

/// Real audio the mouth is allowed to hold BEYOND what it is playing right now.
///
/// Hermes has no audio queue at all: one consumer cuts a sentence, synthesizes it, and
/// blocks on the PortAudio write before touching the next one, so the sound card is the
/// backpressure and at most one sentence is ever rendered-but-unplayed. This is that
/// property, kept with a lead instead of a hard block, because kokoro is the renderer
/// here and a strict block would expose its render time at every clause boundary — on the
/// a live call a clause takes 400-660ms to render. So the mouth runs exactly that far
/// ahead: enough for the NEXT clause to be ready when the current one ends, never more.
///
/// What this replaces: an unbounded 300s queue that kokoro (several times faster than
/// realtime) filled with the whole reply. One barge-in against that threw away 16.68s of
/// already-rendered audio; the same barge-in now costs at most this plus one chunk.
pub const PLAYBACK_LEAD_MS: u64 = 800;
/// Granularity of the paced write — and therefore how often a barge-in is noticed while a
/// clause is being handed over. Hermes checks their stop event between PCM chunks inside
/// the write loop for the same reason.
pub const MOUTH_CHUNK_MS: u64 = 40;
/// How often the pacer re-checks whether the device has drained enough for the next chunk.
const MOUTH_POLL_MS: u64 = 10;
/// Backstop inside the mouth thread. Unreachable while the pacer is doing its job — it
/// exists so a bug upstream can never queue a minute of audio again.
const MAX_QUEUED_SAMPLES: usize = SAMPLE_RATE as usize * 5;
/// A render callback that hasn't moved a frame in this long is stalled, not merely between
/// buffers.
///
/// WALL CLOCK, and that is the whole point. A count of turns of the mouth loop cannot do
/// this job: that loop turns once per COMMAND, not once per 500ms timeout. The pacer hands
/// a clause over as 40ms chunks, so ~20 Play commands land in a burst — twenty turns inside
/// one 512-frame CoreAudio period (10.7ms). On a live call four of those turns read
/// as "frozen for 2.0s" and killed the call 20ms into the first clause, while the counter
/// showed the device rendering at exactly realtime (1487872 frames over 31.006s = 47986/s).
const MOUTH_STALL_MS: u64 = 2_000;
/// How long a restarted stream gets to prove its render callback is actually running.
const RESTART_PROOF_MS: u64 = 300;
const RESTART_POLL_MS: u64 = 5;

/// Resamples the mouth's PCM16/mono/24k queue up to whatever rate CoreAudio pinned the
/// device at (48k on BlackHole), with LINEAR INTERPOLATION between the two bracketing
/// source samples.
///
/// Why interpolation and never sample-and-hold: holding each source sample across
/// output frames is a boxcar filter — it rolls the highs off and leaves imaging junk
/// up near nyquist, which reads on a call as a duller, "deeper" voice. (Injectin's
/// AVAudioEngine path gets a proper band-limited converter from Apple for free; here
/// we own the step ourselves.) Lerping keeps it cheap — no allocation, no filter
/// state beyond two samples — and the RATE is untouched (`step` source samples per
/// output frame, 0.5 at 24k→48k), so quality can never shift speed or pitch.
pub struct LinearResampler {
    /// Source samples consumed per output frame.
    step: f64,
    /// Position between `prev` and `next`, in [0, 1). Starts at 1.0 so the very first
    /// render primes both endpoints off the queue.
    phase: f64,
    prev: i16,
    next: i16,
}

impl LinearResampler {
    pub fn new(source_rate: u32, output_rate: u32) -> Self {
        Self {
            step: source_rate as f64 / output_rate.max(1) as f64,
            phase: 1.0,
            prev: 0,
            next: 0,
        }
    }

    /// One output frame. Pulls from `queue` only as the phase crosses into the next
    /// source sample. An empty queue reads as silence rather than a stall, so both
    /// startup (nothing rendered yet) and underrun (queue drained mid-clause) RAMP to
    /// zero across one source period instead of stepping there — no click either way.
    pub fn render(&mut self, queue: &mut VecDeque<i16>) -> i16 {
        while self.phase >= 1.0 {
            self.prev = self.next;
            self.next = queue.pop_front().unwrap_or(0);
            self.phase -= 1.0;
        }
        let value = self.prev as f64 + (self.next as f64 - self.prev as f64) * self.phase;
        self.phase += self.step;
        value.round() as i16
    }
}

enum MouthCommand {
    Play(Vec<u8>),
    Flush,
    Stop,
}

/// What the render-callback counter is saying about the mouth right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stall {
    /// It moved, or it hasn't been still long enough for that to mean anything.
    None,
    /// Still for this long — worth one stream restart.
    Restart(Duration),
    /// Still for this long even after a restart. Nothing left to try.
    Fatal(Duration),
}

/// Watches the render callback for a real freeze — one measured against the clock rather
/// than against how often the mouth thread happens to wake up (see `MOUTH_STALL_MS`).
struct StallWatch {
    last_rendered: u64,
    last_progress: Instant,
    restarted: bool,
}

impl StallWatch {
    fn new(rendered: u64, now: Instant) -> Self {
        Self {
            last_rendered: rendered,
            last_progress: now,
            restarted: false,
        }
    }

    fn observe(&mut self, rendered: u64, now: Instant) -> Stall {
        if rendered != self.last_rendered {
            self.last_rendered = rendered;
            self.last_progress = now;
            self.restarted = false;
            return Stall::None;
        }
        let frozen = now.saturating_duration_since(self.last_progress);
        if frozen < Duration::from_millis(MOUTH_STALL_MS) {
            return Stall::None;
        }
        if self.restarted {
            return Stall::Fatal(frozen);
        }
        // The restart gets its own fresh clock: it is allowed to be slow, it is not
        // allowed to leave the callback frozen for another full window.
        self.restarted = true;
        self.last_progress = now;
        Stall::Restart(frozen)
    }
}

/// A mouth whose thread and sound card the test plays itself.
#[cfg(test)]
struct DetachedMouth {
    mouth: Mouth,
    rx: mpsc::Receiver<MouthCommand>,
    queue: Arc<Mutex<VecDeque<i16>>>,
    in_flight: Arc<AtomicUsize>,
}

#[derive(Clone)]
pub struct Mouth {
    tx: mpsc::Sender<MouthCommand>,
    /// The SAME deque the render callback pops from — shared so teardown/hangup can ask
    /// "is there still audio to play?" instead of guessing at a duration. This is the
    /// queue whose emptiness the drain protocol reports as DRAINED.
    queue: Arc<Mutex<VecDeque<i16>>>,
    /// Samples sent to the mouth thread that haven't reached `queue` yet. The command
    /// channel is a second, unbounded buffer, and a pacer that only watched the deque
    /// would fill it blind — it can hand over a dozen chunks before the thread moves the
    /// first one across, which is the whole failure this pacing exists to prevent.
    in_flight: Arc<AtomicUsize>,
    /// Output frames the CoreAudio render callback has produced — the same counter the
    /// stall watch reads. Exposed so `mouth-bench` can ask the device directly whether it
    /// is still pulling, with no phone call in the loop.
    rendered: Arc<AtomicU64>,
    /// The rate CoreAudio pinned the device at, so the bench can say whether the frames it
    /// counted are realtime. 0 until the stream is built.
    output_rate: Arc<AtomicU64>,
}

impl Mouth {
    pub async fn start() -> Result<(Self, tokio_mpsc::UnboundedReceiver<String>)> {
        let device_name = std::env::var("CALL_INJECT_DEVICE_NAME")
            .unwrap_or_else(|_| "BlackHole Inject 2ch".to_owned());
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (fatal_tx, fatal_rx) = tokio_mpsc::unbounded_channel();
        let queue = Arc::new(Mutex::new(VecDeque::<i16>::new()));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let rendered = Arc::new(AtomicU64::new(0));
        let output_rate = Arc::new(AtomicU64::new(0));
        let thread_queue = queue.clone();
        let thread_in_flight = in_flight.clone();
        let thread_rendered = rendered.clone();
        let thread_rate = output_rate.clone();
        thread::Builder::new()
            .name("fig-call-mouth".to_owned())
            .spawn(move || {
                mouth_thread(
                    &device_name,
                    rx,
                    thread_queue,
                    thread_in_flight,
                    thread_rendered,
                    thread_rate,
                    ready_tx,
                    fatal_tx,
                )
            })
            .context("spawn cpal mouth thread")?;
        tokio::task::spawn_blocking(move || ready_rx.recv())
            .await
            .context("join cpal ready wait")?
            .context("cpal mouth thread ended before ready")??;
        Ok((
            Self {
                tx,
                queue,
                in_flight,
                rendered,
                output_rate,
            },
            fatal_rx,
        ))
    }

    /// Output frames the device's render callback has produced so far. The mouth is alive
    /// if and only if this keeps moving — it advances whether or not there is anything
    /// queued, because an empty queue renders silence rather than stopping.
    pub fn rendered_frames(&self) -> u64 {
        self.rendered.load(Ordering::Relaxed)
    }

    /// The rate CoreAudio pinned the output at, in Hz.
    pub fn output_rate(&self) -> u64 {
        self.output_rate.load(Ordering::Relaxed)
    }

    /// Samples still owed to the device: what's in the deque plus what's still crossing
    /// the command channel. 0 = nothing of ours is left (one device buffer may still be in
    /// flight downstream — that's what the tail pad covers).
    pub fn queued_samples(&self) -> usize {
        self.queue.lock().map(|q| q.len()).unwrap_or(0) + self.in_flight.load(Ordering::SeqCst)
    }

    /// Real audio still owed to the device, in ms.
    pub fn queued_ms(&self) -> u64 {
        self.queued_samples() as u64 * 1000 / SAMPLE_RATE as u64
    }

    pub fn play(&self, pcm: Vec<u8>) {
        self.in_flight.fetch_add(pcm.len() / 2, Ordering::SeqCst);
        let _ = self.tx.send(MouthCommand::Play(pcm));
    }

    /// Hand one clause to the device at the device's own pace: a chunk only goes in once
    /// the queue has drained back under `PLAYBACK_LEAD_MS`, so playback progress — not
    /// kokoro's render speed — decides how fast this returns.
    ///
    /// `keep_going` is checked between chunks. Returns false the moment it goes false,
    /// with the rest of the clause never handed over: that is the whole point, a barge-in
    /// discards a fraction of a clause instead of a reply's worth of rendered audio.
    pub async fn play_paced<F>(&self, pcm: &[u8], keep_going: F) -> bool
    where
        F: Fn() -> bool,
    {
        let chunk_bytes = ((SAMPLE_RATE as u64 * MOUTH_CHUNK_MS / 1000) as usize * 2).max(2);
        for chunk in pcm.chunks(chunk_bytes) {
            loop {
                if !keep_going() {
                    return false;
                }
                if self.queued_ms() <= PLAYBACK_LEAD_MS {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(MOUTH_POLL_MS)).await;
            }
            self.play(chunk.to_vec());
        }
        true
    }

    pub fn flush(&self) {
        let _ = self.tx.send(MouthCommand::Flush);
    }

    pub fn stop(&self) {
        let _ = self.tx.send(MouthCommand::Stop);
    }

    /// A mouth with no CoreAudio behind it, so the PACER can be tested without a device:
    /// the caller plays the mouth thread and the sound card. The pacer only ever asks the
    /// queue how full it is, which is exactly what the real one does.
    #[cfg(test)]
    fn detached() -> DetachedMouth {
        let (tx, rx) = mpsc::channel();
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        let in_flight = Arc::new(AtomicUsize::new(0));
        DetachedMouth {
            mouth: Self {
                tx,
                queue: queue.clone(),
                in_flight: in_flight.clone(),
                rendered: Arc::new(AtomicU64::new(0)),
                output_rate: Arc::new(AtomicU64::new(0)),
            },
            rx,
            queue,
            in_flight,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn mouth_thread(
    wanted_name: &str,
    rx: mpsc::Receiver<MouthCommand>,
    queue: Arc<Mutex<VecDeque<i16>>>,
    in_flight: Arc<AtomicUsize>,
    rendered: Arc<AtomicU64>,
    output_rate: Arc<AtomicU64>,
    ready: mpsc::SyncSender<Result<()>>,
    fatal: tokio_mpsc::UnboundedSender<String>,
) {
    let host = cpal::default_host();
    let devices = match host.output_devices() {
        Ok(devices) => devices.collect::<Vec<_>>(),
        Err(error) => {
            let _ = ready.send(Err(anyhow!("list CoreAudio output devices: {error}")));
            return;
        }
    };
    let mut names = Vec::new();
    let device = devices.into_iter().find(|device| {
        let name = device.name().unwrap_or_else(|_| "<unreadable>".to_owned());
        names.push(name.clone());
        name == wanted_name
            || name.eq_ignore_ascii_case(wanted_name)
            || name.to_lowercase().contains(&wanted_name.to_lowercase())
    });
    let Some(device) = device else {
        let _ = ready.send(Err(anyhow!(
            "CoreAudio output '{wanted_name}' not found (available: {})",
            names.join(", ")
        )));
        return;
    };
    let actual_name = device.name().unwrap_or_else(|_| wanted_name.to_owned());
    let supported = match device.default_output_config() {
        Ok(config) => config,
        Err(error) => {
            let _ = ready.send(Err(anyhow!(
                "default output config for {actual_name}: {error}"
            )));
            return;
        }
    };
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    output_rate.store(config.sample_rate.0 as u64, Ordering::Relaxed);
    let stream_error = Arc::new(AtomicBool::new(false));

    let mut stream = match build_stream(
        &device,
        &config,
        sample_format,
        queue.clone(),
        rendered.clone(),
        stream_error.clone(),
    ) {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if let Err(error) = stream.play() {
        let _ = ready.send(Err(anyhow!("start CoreAudio output: {error}")));
        return;
    }
    log(format!(
        "cpal mouth pinned name={actual_name:?} rate={}Hz channels={}; reading PCM16/mono/24k in-process",
        config.sample_rate.0, config.channels
    ));
    let _ = ready.send(Ok(()));

    let mut stall = StallWatch::new(rendered.load(Ordering::Relaxed), Instant::now());
    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(MouthCommand::Play(bytes)) => {
                in_flight.fetch_sub(bytes.len() / 2, Ordering::SeqCst);
                let mut q = queue.lock().expect("mouth queue");
                if q.len() > MAX_QUEUED_SAMPLES {
                    // Drop the ARRIVING audio, never the queue: what's already in there is
                    // mid-sentence and about to play. Reaching this at all means the pacer
                    // isn't pacing, so say so loudly.
                    log(format!(
                        "cpal mouth BACKSTOP: {} samples queued (>{MAX_QUEUED_SAMPLES}) — dropping {} arriving bytes; the pacer is not pacing",
                        q.len(),
                        bytes.len()
                    ));
                } else {
                    q.extend(
                        bytes
                            .chunks_exact(2)
                            .map(|pair| i16::from_le_bytes([pair[0], pair[1]])),
                    );
                }
            }
            Ok(MouthCommand::Flush) => {
                // Take the channel with it. A Play still crossing would otherwise land in
                // the queue right after the clear and speak a fragment of the very reply
                // they interrupted.
                let mut stop_after = false;
                let mut in_transit = 0usize;
                while let Ok(straggler) = rx.try_recv() {
                    match straggler {
                        MouthCommand::Play(bytes) => {
                            in_transit += bytes.len() / 2;
                            in_flight.fetch_sub(bytes.len() / 2, Ordering::SeqCst);
                        }
                        MouthCommand::Flush => {}
                        MouthCommand::Stop => {
                            stop_after = true;
                            break;
                        }
                    }
                }
                let dropped = {
                    let mut q = queue.lock().expect("mouth queue");
                    let dropped = q.len();
                    q.clear();
                    dropped
                };
                log(format!(
                    "cpal mouth FLUSH: dropped {dropped} queued + {in_transit} in-transit frames ({:.2}s)",
                    (dropped + in_transit) as f64 / SAMPLE_RATE as f64
                ));
                if stop_after {
                    break;
                }
            }
            Ok(MouthCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if stream_error.swap(false, Ordering::SeqCst) {
            log("cpal ENGINE-RESTART (CoreAudio stream error/configuration change)".to_owned());
            match restart_stream(
                &device,
                &config,
                sample_format,
                queue.clone(),
                rendered.clone(),
                stream_error.clone(),
            ) {
                Ok((new_stream, _)) => stream = new_stream,
                Err(error) => {
                    let _ = fatal.send(format!("cpal mouth restart failed: {error}"));
                    break;
                }
            }
        }

        let current = rendered.load(Ordering::Relaxed);
        match stall.observe(current, Instant::now()) {
            Stall::None => continue,
            Stall::Fatal(frozen) => {
                let _ = fatal.send(format!(
                    "cpal mouth restart did not unfreeze render callbacks — frozen at {current} for {:.1}s, failing loudly",
                    frozen.as_secs_f32()
                ));
                break;
            }
            Stall::Restart(frozen) => {
                log(format!(
                    "MOUTH-STALL: rendered frozen at {current} for {:.1}s (queued={}) — attempting stream restart",
                    frozen.as_secs_f32(),
                    queue.lock().expect("mouth queue").len()
                ));
                match restart_stream(
                    &device,
                    &config,
                    sample_format,
                    queue.clone(),
                    rendered.clone(),
                    stream_error.clone(),
                ) {
                    // A restart that could not prove itself is a dead mouth, and there is
                    // no second thing to try — say so now instead of spending another
                    // stall window rediscovering it.
                    Ok((_, false)) => {
                        let _ = fatal.send(format!(
                            "cpal mouth restart reported playing but rendered no frames past {current} in {RESTART_PROOF_MS}ms — failing loudly"
                        ));
                        break;
                    }
                    Ok((new_stream, true)) => stream = new_stream,
                    Err(error) => {
                        let _ = fatal.send(format!("cpal mouth stall restart failed: {error}"));
                        break;
                    }
                }
            }
        }
    }
    drop(stream);
}

/// Rebuild and start the output stream, and then WATCH IT before saying it worked.
///
/// `stream.play()` returning Ok only means CoreAudio accepted the start. On a live call this
/// logged "stream running again on pinned device" three times in 20ms off nothing but that
/// Ok — an assertion of success over a mouth the code believed was dead. The only evidence
/// that counts is the render callback producing a frame, so the bool is whether it did.
fn restart_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    format: SampleFormat,
    queue: Arc<Mutex<VecDeque<i16>>>,
    rendered: Arc<AtomicU64>,
    stream_error: Arc<AtomicBool>,
) -> Result<(Stream, bool)> {
    let before = rendered.load(Ordering::Relaxed);
    let stream = build_stream(device, config, format, queue, rendered.clone(), stream_error)?;
    stream.play().context("restart CoreAudio output")?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(RESTART_PROOF_MS) {
        let now = rendered.load(Ordering::Relaxed);
        if now != before {
            log(format!(
                "cpal ENGINE-RESTART: render callback running again on pinned device (+{} frames in {}ms)",
                now.wrapping_sub(before),
                started.elapsed().as_millis()
            ));
            return Ok((stream, true));
        }
        thread::sleep(Duration::from_millis(RESTART_POLL_MS));
    }
    log(format!(
        "cpal ENGINE-RESTART: stream reports playing but the render callback has not moved past {before} in {RESTART_PROOF_MS}ms — the mouth is still dead"
    ));
    Ok((stream, false))
}

fn build_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    format: SampleFormat,
    queue: Arc<Mutex<VecDeque<i16>>>,
    rendered: Arc<AtomicU64>,
    stream_error: Arc<AtomicBool>,
) -> Result<Stream> {
    let channels = config.channels as usize;
    let output_rate = config.sample_rate.0;
    let error_callback = move |error| {
        log(format!("cpal output stream error: {error}"));
        stream_error.store(true, Ordering::SeqCst);
    };
    macro_rules! stream {
        ($sample:ty, $convert:expr) => {{
            let mut resampler = LinearResampler::new(SAMPLE_RATE, output_rate);
            device.build_output_stream(
                config,
                move |data: &mut [$sample], _| {
                    let mut q = queue.lock().expect("mouth queue");
                    for frame in data.chunks_mut(channels) {
                        let value: $sample = ($convert)(resampler.render(&mut q));
                        for sample in frame {
                            *sample = value;
                        }
                    }
                    rendered.fetch_add((data.len() / channels) as u64, Ordering::Relaxed);
                },
                error_callback,
                None,
            )
        }};
    }
    let built = match format {
        SampleFormat::F32 => stream!(f32, |sample: i16| sample as f32 / 32768.0),
        SampleFormat::I16 => stream!(i16, |sample: i16| sample),
        SampleFormat::U16 => stream!(u16, |sample: i16| (sample as i32 + 32768) as u16),
        other => return Err(anyhow!("unsupported CoreAudio sample format {other:?}")),
    };
    built.context("build CoreAudio output stream")
}

pub struct TapPipe {
    child: Child,
}

impl TapPipe {
    pub async fn start(
        repo_root: &std::path::Path,
        ear_tx: tokio_mpsc::UnboundedSender<Vec<u8>>,
        fatal_tx: tokio_mpsc::UnboundedSender<String>,
    ) -> Result<Self> {
        let canonical = repo_root.join("tools/call/bin/tapout");
        let fallback = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default()
            .join("scratch/ftlane/g4/tapout");
        let binary = if canonical.exists() {
            canonical
        } else {
            fallback
        };
        let mut child = Command::new(&binary)
            .arg("sys")
            .arg(std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("spawn {}", binary.display()))?;
        let pid = child.id().unwrap_or(0);
        log(format!(
            "tapout spawned pid={pid} (sys tap excluding rust child pid={})",
            std::process::id()
        ));
        let mut stdout = child.stdout.take().context("tapout stdout")?;
        let stderr = child.stderr.take().context("tapout stderr")?;
        let fatal_for_stdout = fatal_tx.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 9_600];
            loop {
                match stdout.read(&mut buffer).await {
                    Ok(0) => {
                        let _ = fatal_for_stdout.send("tapout died (call likely ended)".to_owned());
                        break;
                    }
                    Ok(count) => {
                        let _ = ear_tx.send(buffer[..count].to_vec());
                    }
                    Err(error) => {
                        let _ = fatal_for_stdout.send(format!("tapout read failed: {error}"));
                        break;
                    }
                }
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log(format!("tapout: {line}"));
            }
        });
        Ok(Self { child })
    }

    pub async fn stop(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const OUTPUT_RATE: u32 = 48_000;

    fn silence(ms: usize) -> Vec<u8> {
        vec![0u8; SAMPLE_RATE as usize * ms / 1000 * 2]
    }

    fn queued_ms(queue: &Arc<Mutex<VecDeque<i16>>>) -> u64 {
        queue.lock().expect("queue").len() as u64 * 1000 / SAMPLE_RATE as u64
    }

    /// The unbounded-queue regression, in one assertion: kokoro renders several times faster than
    /// realtime, so an unbounded queue ends up holding the whole reply —
    /// 16.68s of it, measured, all of which one barge-in throws away. Playback progress
    /// has to be what decides when the next audio goes in.
    /// The real mouth thread, minus CoreAudio: it takes whatever the pacer hands over and
    /// puts it in the queue the device reads from. A thread, not a task, because that's
    /// what it is in the child — and because the pacer must never have to yield to it.
    fn fake_mouth_thread(
        rx: mpsc::Receiver<MouthCommand>,
        queue: Arc<Mutex<VecDeque<i16>>>,
        in_flight: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            while let Ok(command) = rx.recv() {
                if let MouthCommand::Play(bytes) = command {
                    // Deliberately unhurried — the real thread also does stall checks
                    // between commands, and the pacer may not depend on it keeping up.
                    thread::sleep(Duration::from_millis(1));
                    in_flight.fetch_sub(bytes.len() / 2, Ordering::SeqCst);
                    let mut q = queue.lock().expect("queue");
                    q.extend(bytes.chunks_exact(2).map(|p| i16::from_le_bytes([p[0], p[1]])));
                    peak.fetch_max(q.len(), Ordering::SeqCst);
                }
            }
        })
    }

    #[tokio::test]
    async fn the_mouth_only_ever_runs_one_clause_ahead_of_the_ear() {
        let DetachedMouth { mouth, rx, queue, in_flight } = Mouth::detached();
        let peak = Arc::new(AtomicUsize::new(0));
        let mouth_thread = fake_mouth_thread(rx, queue.clone(), in_flight, peak.clone());

        // …and the sound card. Deliberately faster than realtime so the test is quick: the
        // cap has to hold at ANY playback rate, not only the true one.
        let playing = Arc::new(AtomicBool::new(true));
        let device_queue = queue.clone();
        let device_flag = playing.clone();
        let device = thread::spawn(move || {
            while device_flag.load(Ordering::SeqCst) {
                {
                    let mut q = device_queue.lock().expect("queue");
                    for _ in 0..480 {
                        if q.pop_front().is_none() {
                            break;
                        }
                    }
                }
                thread::sleep(Duration::from_millis(5));
            }
        });

        assert!(mouth.play_paced(&silence(4_000), || true).await);
        drop(mouth);
        mouth_thread.join().expect("mouth thread");
        playing.store(false, Ordering::SeqCst);
        device.join().expect("device thread");

        let peak_ms = peak.load(Ordering::SeqCst) as u64 * 1000 / SAMPLE_RATE as u64;
        assert!(
            peak_ms <= PLAYBACK_LEAD_MS + MOUTH_CHUNK_MS * 2,
            "the mouth ran {peak_ms}ms ahead of the ear (cap is {PLAYBACK_LEAD_MS}ms)"
        );
        assert!(peak_ms >= MOUTH_CHUNK_MS, "nothing was ever handed over");
    }

    /// …and the other half: what a barge-in costs. The interrupt is checked BETWEEN
    /// chunks inside the write, so the rest of the clause is never handed over at all.
    #[tokio::test]
    async fn a_barge_in_costs_a_fraction_of_a_clause_not_a_reply() {
        let DetachedMouth { mouth, rx, queue, in_flight } = Mouth::detached();
        // No device at all: the pacer fills to the lead and then waits, which is exactly
        // the state a barge-in lands in.
        let mouth_thread =
            fake_mouth_thread(rx, queue.clone(), in_flight, Arc::new(AtomicUsize::new(0)));

        let cut_at = Instant::now() + Duration::from_millis(150);
        let played = mouth
            .play_paced(&silence(30_000), || Instant::now() < cut_at)
            .await;
        drop(mouth);
        mouth_thread.join().expect("mouth thread");

        assert!(!played, "the pacer did not notice the barge-in");
        let discarded = queued_ms(&queue);
        assert!(
            discarded <= PLAYBACK_LEAD_MS + MOUTH_CHUNK_MS * 2,
            "a barge-in threw away {discarded}ms of rendered audio (the unbounded queue threw away 16680ms)"
        );
    }

    /// The burst-of-Play-commands case, in one assertion. The pacer hands a clause over as 40ms chunks,
    /// so ~20 Play commands land in a burst and the mouth loop turns 20 times inside a
    /// single 512-frame CoreAudio period. Counting TURNS, four of them read as "frozen for
    /// 2.0s"; the child restarted the stream three times in 20ms and then killed a call in
    /// which the device was rendering at exactly realtime.
    #[test]
    fn a_burst_of_paced_chunks_is_not_a_frozen_render_callback() {
        let start = Instant::now();
        // The real numbers off that call's log.
        let mut watch = StallWatch::new(1_487_872, start);
        for turn in 0..24u32 {
            let now = start + Duration::from_micros(300 * turn as u64);
            assert_eq!(
                watch.observe(1_487_872, now),
                Stall::None,
                "loop turn {turn} at {}µs called a live mouth stalled",
                300 * turn
            );
        }
        // …and one buffer later the counter moves, exactly as it did on the call.
        assert_eq!(
            watch.observe(1_488_384, start + Duration::from_millis(11)),
            Stall::None
        );
    }

    /// …and the other half: a callback that really has stopped still gets caught, on the
    /// clock rather than on the loop's mood.
    #[test]
    fn a_render_callback_still_for_two_seconds_is_a_stall_then_a_fatal() {
        let start = Instant::now();
        let mut watch = StallWatch::new(4_096, start);
        assert_eq!(
            watch.observe(4_096, start + Duration::from_millis(1_999)),
            Stall::None,
            "called it a stall before the window was up"
        );
        assert_eq!(
            watch.observe(4_096, start + Duration::from_millis(2_000)),
            Stall::Restart(Duration::from_millis(2_000))
        );
        // The restart bought a fresh window, not a free pass.
        assert_eq!(
            watch.observe(4_096, start + Duration::from_millis(3_999)),
            Stall::None
        );
        assert_eq!(
            watch.observe(4_096, start + Duration::from_millis(4_000)),
            Stall::Fatal(Duration::from_millis(2_000))
        );
        // And a mouth that comes back is forgiven: the next freeze earns its own restart.
        let mut watch = StallWatch::new(4_096, start);
        assert_eq!(
            watch.observe(4_096, start + Duration::from_millis(2_000)),
            Stall::Restart(Duration::from_millis(2_000))
        );
        assert_eq!(
            watch.observe(8_192, start + Duration::from_millis(2_010)),
            Stall::None
        );
        assert_eq!(
            watch.observe(8_192, start + Duration::from_millis(4_100)),
            Stall::Restart(Duration::from_millis(2_090))
        );
    }

    /// A 24k ramp, resampled to 48k, must take exactly as long to play — resample
    /// quality must never become a rate change. This pins the ratio.
    #[test]
    fn resampling_does_not_change_speed() {
        let input: Vec<i16> = (0..480).map(|i| i as i16 * 60).collect();
        let mut queue: VecDeque<i16> = input.iter().copied().collect();
        let mut resampler = LinearResampler::new(SAMPLE_RATE, OUTPUT_RATE);

        let expected = input.len() * OUTPUT_RATE as usize / SAMPLE_RATE as usize;
        let mut frames = 0usize;
        while !queue.is_empty() {
            resampler.render(&mut queue);
            frames += 1;
            assert!(frames <= expected * 2, "resampler never drained its queue");
        }
        assert!(
            frames.abs_diff(expected) <= 1,
            "{frames} output frames consumed {} input samples; expected ~{expected}",
            input.len()
        );
    }

    /// The actual regression guard: a zero-order hold emits every source sample TWICE at
    /// 2x, so the output is a staircase. Linear interpolation must put a real midpoint
    /// between each pair — on a ramp that means the output is itself a clean ramp.
    #[test]
    fn interpolates_midpoints_instead_of_holding_the_previous_sample() {
        let input: Vec<i16> = (0..64).map(|i| i as i16 * 500).collect();
        let mut queue: VecDeque<i16> = input.iter().copied().collect();
        let mut resampler = LinearResampler::new(SAMPLE_RATE, OUTPUT_RATE);
        let out: Vec<i16> = (0..124).map(|_| resampler.render(&mut queue)).collect();

        // No repeated neighbours anywhere — a sample-and-hold staircase would repeat
        // on every other frame (and read dull/deeper on a call).
        let repeats = out[2..].windows(2).filter(|w| w[0] == w[1]).count();
        assert_eq!(repeats, 0, "sample-and-hold staircase: {:?}", &out[2..16]);

        // Every interior frame lands strictly between its neighbours.
        for (i, w) in out[2..120].windows(3).enumerate() {
            assert!(
                w[1] > w[0] && w[1] < w[2],
                "frame {} not between its neighbours: {w:?}",
                i + 3
            );
        }

        // Lerping a linear ramp reproduces that ramp at the output rate: after the
        // two-frame prime, each step is exactly half a source step (500 / 2).
        for (i, value) in out.iter().enumerate().take(120).skip(2) {
            assert_eq!(*value, 250 * (i as i16 - 2), "frame {i}");
        }
    }

    /// Startup and underrun both read as silence and RAMP rather than step, so the
    /// mouth never clicks when a clause ends or before the first one lands.
    #[test]
    fn startup_and_underrun_are_silent_and_click_free() {
        let mut queue: VecDeque<i16> = VecDeque::new();
        let mut resampler = LinearResampler::new(SAMPLE_RATE, OUTPUT_RATE);

        // nothing queued yet → pure silence, no garbage
        for _ in 0..16 {
            assert_eq!(resampler.render(&mut queue), 0);
        }

        // a clause arrives at full amplitude: the first frames ease in from zero
        queue.extend([20_000i16; 8]);
        let ramp_in: Vec<i16> = (0..6).map(|_| resampler.render(&mut queue)).collect();
        assert!(ramp_in[0] < 20_000, "jumped straight to full scale: {ramp_in:?}");
        assert!(
            ramp_in.windows(2).all(|w| w[1] >= w[0]),
            "ramp-in not monotonic: {ramp_in:?}"
        );
        assert_eq!(*ramp_in.last().expect("frames"), 20_000);

        // queue drains mid-tone: the tail eases back to zero instead of cutting
        let ramp_out: Vec<i16> = (0..16).map(|_| resampler.render(&mut queue)).collect();
        assert!(
            ramp_out.contains(&10_000),
            "underrun stepped to zero instead of ramping: {ramp_out:?}"
        );
        assert_eq!(*ramp_out.last().expect("frames"), 0);
    }
}
