/**
 * Full rebuild of the brain index, from the canonical sources.
 *
 * Run:  npm run index:brain
 *
 * The index is a pure cache — this is always safe to run, and it's the fix if the
 * db is ever deleted, corrupted, or drifts from the vault.
 */
import { getBrainIndex } from "./brainIndex";

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function main(): void {
  const idx = getBrainIndex();
  console.log(`rebuilding brain index`);
  console.log(`  sources: ${idx.sourceTypes().join(", ") || "(none)"}`);
  console.log(`  db:      ${idx.dbPath}`);

  const started = Date.now();
  const { files, documents } = idx.rebuildAll();
  const elapsed = Date.now() - started;

  const s = idx.stats();
  console.log(`\nindexed ${documents} documents / ${s.chunks} chunks from ${files} files in ${elapsed} ms`);
  for (const [type, st] of Object.entries(s.bySourceType)) {
    console.log(
      `  ${type}: ${st.documents} docs, ${st.chunks} chunks, ${st.files} files, ${st.firstDate ?? "-"} → ${st.lastDate ?? "-"}`,
    );
  }
  console.log(`  db size: ${mb(s.dbBytes)}`);
  idx.close();
}

main();
