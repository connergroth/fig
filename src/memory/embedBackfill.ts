/**
 * One-off backfill of chunk vectors.
 *
 * Run:  npm run embed:brain
 *       npm run embed:brain -- --force     # re-embed everything (after a model change)
 *       npm run embed:brain -- --limit 500 # partial, for a smoke test
 *
 * This is deliberately a SCRIPT and not something boot does for you. Embedding the
 * whole corpus is tens of minutes of saturated CPU; starting that automatically on a
 * machine that's also running Messages and Chrome is how you get a mysteriously
 * unresponsive laptop. Boot catches up small gaps only (see catchUpEmbeddings) and
 * points here for anything larger.
 *
 * Memory is the reason the batch budget is what it is. The bake-off ran an 8192
 * padded-token budget and peaked at 9.2GB RSS — fine for a benchmark on an idle
 * machine, not fine on a 16GB mini with a browser open. The production budget is 2048
 * (src/memory/embedder.ts), which trades wall clock for headroom. This runs once,
 * overnight; the trade is free.
 */

import { getBrainIndex } from "./brainIndex";
import { MAX_BATCH, MODEL, TOKEN_BUDGET } from "./embedder";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function mins(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
}

async function main(): Promise<void> {
  const idx = getBrainIndex();
  const limit = Number(arg("limit") ?? 0) || undefined;
  const force = flag("force");

  const status = idx.vectorStatus();
  console.log(`brain index: ${idx.dbPath}`);
  console.log(`  model:   ${MODEL.upstream} (${MODEL.dim}d, ${MODEL.dtype})`);
  console.log(`  batches: ${TOKEN_BUDGET} padded-token budget, max ${MAX_BATCH} rows`);
  console.log(`  chunks:  ${status.chunks}, with vectors: ${status.vectors}`);

  if (status.mismatch) {
    if (!force) {
      console.error(
        `\nREFUSING: existing vectors were built under a different embedding contract.\n` +
          `  stored:  ${status.contract}\n` +
          `  running: ${MODEL.repo}|${MODEL.dtype}|${MODEL.dim}|...\n\n` +
          `Vectors from two models are not comparable — cosine still returns numbers, they're\n` +
          `just meaningless. Re-embed everything with:  npm run embed:brain -- --force`,
      );
      process.exit(1);
    }
    console.log(`  ! contract mismatch — --force given, dropping all existing vectors`);
  }

  if (force) {
    idx.dropVectors();
    console.log(`  dropped existing vectors`);
  }

  const pending = idx.pendingEmbedCount();
  if (!pending) {
    console.log(`\nnothing to embed — every chunk already has a vector.`);
    idx.close();
    return;
  }
  console.log(`\nembedding ${limit ? Math.min(limit, pending) : pending} chunk(s)…\n`);

  // Sample RSS across the whole run. The peak is dominated by the onnxruntime arena
  // during a forward pass, not by the resident weights, so a before/after reading
  // would miss it entirely.
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peakRss) peakRss = r;
  }, 200);
  sampler.unref();

  const t0 = performance.now();
  let lastLog = 0;
  const done = await idx.embedPending({
    limit,
    onProgress: (n, total) => {
      if (n - lastLog < 250 && n !== total) return;
      lastLog = n;
      const el = (performance.now() - t0) / 1000;
      const rate = n / Math.max(el, 0.001);
      const eta = (total - n) / Math.max(rate, 0.001);
      process.stdout.write(
        `  ${n}/${total}  ${rate.toFixed(1)}/s  eta ${(eta / 60).toFixed(1)}m  rss ${gb(peakRss)}\n`,
      );
    },
  });
  const elapsed = performance.now() - t0;

  const after = idx.vectorStatus();
  console.log(`\nembedded ${done} chunk(s) in ${mins(elapsed)}`);
  console.log(`  peak RSS:  ${gb(peakRss)}`);
  console.log(`  vectors:   ${after.vectors}/${after.chunks}`);
  console.log(`  db size:   ${(idx.stats().dbBytes / 1e6).toFixed(1)} MB`);
  if (after.vectors < after.chunks) {
    console.log(`  ! ${after.chunks - after.vectors} chunk(s) still unembedded — re-run to finish`);
  }
  idx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
