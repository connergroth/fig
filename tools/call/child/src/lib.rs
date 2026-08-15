pub mod audio;
pub mod barge;
pub mod bridge;
pub mod clause;
pub mod drain;
pub mod hold;
pub mod interrupt;
pub mod pending;
pub mod transcript;
pub mod vad;
pub mod wav;
pub mod worker;

pub const SAMPLE_RATE: u32 = 24_000;
pub const BYTES_PER_SAMPLE: usize = 2;

pub fn pcm_seconds(pcm: &[u8]) -> f64 {
    pcm.len() as f64 / BYTES_PER_SAMPLE as f64 / SAMPLE_RATE as f64
}

pub fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn log(message: impl AsRef<str>) {
    let now = epoch_ms();
    let day_ms = now % 86_400_000;
    let hours = day_ms / 3_600_000;
    let minutes = (day_ms / 60_000) % 60;
    let seconds = (day_ms / 1_000) % 60;
    let millis = day_ms % 1_000;
    println!(
        "{hours:02}:{minutes:02}:{seconds:02}.{millis:03} {}",
        message.as_ref()
    );
}
