use anyhow::{bail, Context, Result};
use std::fs;
use std::path::Path;

use crate::SAMPLE_RATE;

pub fn read_wav_24k_mono(path: &Path) -> Result<Vec<u8>> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("not a wav: {}", path.display());
    }
    let mut offset = 12usize;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into()?) as usize;
        let start = offset + 8;
        let end = start.saturating_add(size).min(bytes.len());
        if id == b"fmt " && end >= start + 16 {
            format = Some((
                u16::from_le_bytes(bytes[start..start + 2].try_into()?),
                u16::from_le_bytes(bytes[start + 2..start + 4].try_into()?),
                u32::from_le_bytes(bytes[start + 4..start + 8].try_into()?),
                u16::from_le_bytes(bytes[start + 14..start + 16].try_into()?),
            ));
        } else if id == b"data" {
            data = Some(bytes[start..end].to_vec());
        }
        offset = start + size + (size % 2);
    }
    let Some((code, channels, rate, bits)) = format else {
        bail!("wav missing fmt: {}", path.display());
    };
    let Some(data) = data else {
        bail!("wav missing data: {}", path.display());
    };
    if !matches!(code, 1 | 0xfffe) || channels != 1 || rate != SAMPLE_RATE || bits != 16 {
        bail!("wav must be pcm16/mono/24k (got code={code} ch={channels} sr={rate} bits={bits})");
    }
    Ok(data)
}

pub fn write_wav_24k_mono(path: &Path, pcm: &[u8]) -> Result<()> {
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36u32 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    fs::write(path, out).with_context(|| format!("write {}", path.display()))
}
