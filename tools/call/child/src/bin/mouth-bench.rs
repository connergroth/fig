//! Does the cpal mouth still render after sitting idle? Answered without a phone call.
//!
//! A call can die 20ms into its first clause with three MOUTH-STALL detections, and the
//! only suggestive thing about it is the idle gap: the calls that worked had 14s and 12s
//! between the mouth opening and the first clause, the one that died had 31s.
//! That is a hypothesis, not a cause, and it is not one worth guessing at — so this opens
//! the mouth on the same pinned device, sits idle for a sweepable N, plays a tone, and
//! reports whether the render callback actually advanced in each phase.
//!
//! Usage: `cargo run --bin mouth-bench -- [idle_seconds ...]` (default sweep 5 15 30 45 60).
//! Everything it prints is measured; the verdict line is the render counter, not the
//! stream object's opinion of itself.

use anyhow::Result;
use fig_call_child::audio::Mouth;
use fig_call_child::{log, SAMPLE_RATE};
use std::f64::consts::TAU;
use std::time::{Duration, Instant};

/// Long enough to cover several clause-lengths of playback and the pacer's whole lead.
const PLAY_SECONDS: u64 = 3;
/// How often the render counter is sampled while the tone plays.
const SAMPLE_MS: u64 = 250;

struct Run {
    idle_s: u64,
    rate: u64,
    idle_frames: u64,
    idle_elapsed: Duration,
    play_frames: u64,
    play_elapsed: Duration,
    /// The longest the counter went without moving during playback — the number the stall
    /// watch is actually looking at.
    longest_freeze: Duration,
    fatal: Option<String>,
    stalled: bool,
}

impl Run {
    /// Fraction of realtime the callback ran at. 1.0 = the device pulled every frame it
    /// owed; 0.0 = frozen.
    fn idle_realtime(&self) -> f64 {
        self.rendered_realtime(self.idle_frames, self.idle_elapsed)
    }

    fn play_realtime(&self) -> f64 {
        self.rendered_realtime(self.play_frames, self.play_elapsed)
    }

    fn rendered_realtime(&self, frames: u64, elapsed: Duration) -> f64 {
        let expected = self.rate as f64 * elapsed.as_secs_f64();
        if expected <= 0.0 {
            return 0.0;
        }
        frames as f64 / expected
    }
}

/// A 220Hz sine at PCM16/mono/24k — real audio, so the resampler and the queue are on the
/// same path a clause takes, and so it is audible if anything is listening to BlackHole.
fn tone(seconds: u64) -> Vec<u8> {
    let samples = SAMPLE_RATE as u64 * seconds;
    (0..samples)
        .flat_map(|index| {
            let phase = TAU * 220.0 * index as f64 / SAMPLE_RATE as f64;
            ((phase.sin() * 8_000.0) as i16).to_le_bytes()
        })
        .collect()
}

async fn one_run(idle_s: u64) -> Result<Run> {
    log(format!("=== idle {idle_s}s: opening the mouth"));
    let (mouth, mut fatal_rx) = Mouth::start().await?;
    let rate = mouth.output_rate();

    // Phase 1: sit there. This is the whole hypothesis — a stream nobody has written to
    // for N seconds.
    let idle_started = Instant::now();
    let idle_from = mouth.rendered_frames();
    tokio::time::sleep(Duration::from_secs(idle_s)).await;
    let idle_elapsed = idle_started.elapsed();
    let idle_frames = mouth.rendered_frames().saturating_sub(idle_from);
    log(format!(
        "idle {idle_s}s: +{idle_frames} frames in {}ms",
        idle_elapsed.as_millis()
    ));

    // Phase 2: speak, through the real pacer, so the command burst that made the old
    // tick-counting stall watch misfire is present here too.
    let play_started = Instant::now();
    let play_from = mouth.rendered_frames();
    let speaker = mouth.clone();
    let playing = tokio::spawn(async move { speaker.play_paced(&tone(PLAY_SECONDS), || true).await });

    let mut longest_freeze = Duration::ZERO;
    let mut last_frames = play_from;
    let mut last_move = Instant::now();
    let mut stalled = false;
    while !playing.is_finished() || mouth.queued_samples() > 0 {
        tokio::time::sleep(Duration::from_millis(SAMPLE_MS)).await;
        let now = mouth.rendered_frames();
        if now != last_frames {
            last_frames = now;
            last_move = Instant::now();
        } else {
            longest_freeze = longest_freeze.max(last_move.elapsed());
        }
        if let Ok(reason) = fatal_rx.try_recv() {
            log(format!("FATAL during playback: {reason}"));
            mouth.stop();
            return Ok(Run {
                idle_s,
                rate,
                idle_frames,
                idle_elapsed,
                play_frames: mouth.rendered_frames().saturating_sub(play_from),
                play_elapsed: play_started.elapsed(),
                longest_freeze,
                fatal: Some(reason),
                stalled: true,
            });
        }
        if play_started.elapsed() > Duration::from_secs(PLAY_SECONDS + 15) {
            stalled = true;
            log("playback never finished — giving up on this run");
            break;
        }
    }
    let play_elapsed = play_started.elapsed();
    let play_frames = mouth.rendered_frames().saturating_sub(play_from);
    log(format!(
        "playback: +{play_frames} frames in {}ms (longest still stretch {}ms)",
        play_elapsed.as_millis(),
        longest_freeze.as_millis()
    ));

    let fatal = fatal_rx.try_recv().ok();
    mouth.stop();
    // Let the thread drop the stream before the next run opens one on the same device.
    tokio::time::sleep(Duration::from_millis(500)).await;
    Ok(Run {
        idle_s,
        rate,
        idle_frames,
        idle_elapsed,
        play_frames,
        play_elapsed,
        longest_freeze,
        fatal,
        stalled,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let requested: Vec<u64> = std::env::args()
        .skip(1)
        .filter_map(|arg| arg.parse().ok())
        .collect();
    let sweep = if requested.is_empty() {
        vec![5, 15, 30, 45, 60]
    } else {
        requested
    };
    log(format!(
        "mouth-bench: idle sweep {sweep:?}s, then {PLAY_SECONDS}s of tone each"
    ));

    let mut runs = Vec::new();
    for idle_s in sweep {
        runs.push(one_run(idle_s).await?);
    }

    println!();
    println!(
        "{:>6}  {:>8}  {:>14}  {:>14}  {:>12}  verdict",
        "idle", "rate", "idle render", "play render", "max still"
    );
    let mut reproduced = false;
    for run in &runs {
        let healthy = run.fatal.is_none()
            && !run.stalled
            && run.idle_realtime() > 0.95
            && run.play_realtime() > 0.95;
        reproduced |= !healthy;
        println!(
            "{:>5}s  {:>7}Hz  {:>13.1}%  {:>13.1}%  {:>10}ms  {}",
            run.idle_s,
            run.rate,
            run.idle_realtime() * 100.0,
            run.play_realtime() * 100.0,
            run.longest_freeze.as_millis(),
            match &run.fatal {
                Some(reason) => reason.as_str(),
                None if healthy => "ok — callback advanced at realtime throughout",
                None => "DEGRADED — see the render percentages",
            }
        );
    }
    println!();
    println!(
        "{}",
        if reproduced {
            "REPRODUCED: at least one idle length left the render callback short."
        } else {
            "NOT REPRODUCED: every idle length rendered at realtime, idle and playing."
        }
    );
    Ok(())
}
