import fs from "node:fs";

/**
 * Minimal WAV read/write for the call lane's ONE wire format: PCM16 LE, mono, 24kHz —
 * what tapout emits, what injectin eats, what the realtime API speaks, and what Kokoro
 * renders. One definition of "a call-lane wav" for the front-ends and bench harnesses.
 */

export const CALL_SAMPLE_RATE = 24000;
export const CALL_BYTES_PER_SAMPLE = 2;

export function readWav24kMono(p: string): Buffer {
  const b = fs.readFileSync(p);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a wav: " + p);
  let off = 12;
  let fmt: { code: number; ch: number; sr: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { code: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") data = b.subarray(off + 8, off + 8 + sz);
    off += 8 + sz + (sz % 2);
  }
  if (!fmt || !data) throw new Error("wav missing fmt/data: " + p);
  // code 1 = plain PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE, which afconvert emits for the
  // same LEI16 samples (the subformat is still PCM at these params).
  if ((fmt.code !== 1 && fmt.code !== 0xfffe) || fmt.ch !== 1 || fmt.sr !== 24000 || fmt.bits !== 16)
    throw new Error(`wav must be pcm16/mono/24k (got code=${fmt.code} ch=${fmt.ch} sr=${fmt.sr} bits=${fmt.bits}) — run afconvert first`);
  return data;
}

export function writeWav24kMono(p: string, pcm: Buffer): void {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(p, Buffer.concat([h, pcm]));
}

/** Seconds of audio in a pcm16/mono/24k buffer. */
export function pcmSeconds(pcm: Buffer): number {
  return pcm.length / CALL_BYTES_PER_SAMPLE / CALL_SAMPLE_RATE;
}
