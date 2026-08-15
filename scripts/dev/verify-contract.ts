/** Prove the production embedder reproduces the bake-off's vectors bit-for-bit-ish. */
import crypto from "node:crypto";
import { loadCorpus } from "../bakeoff/corpus";
import { VectorStore } from "../bakeoff/vectorStore";
import { vectorDbPath } from "../bakeoff/embedCorpus";
import { tryEmbedDocuments, tryEmbedQuery, MODEL } from "../../src/memory/embedder";

const key = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const dot = (a: Float32Array, b: Float32Array) => { let s=0; for (let i=0;i<a.length;i++) s+=a[i]*b[i]; return s; };

(async () => {
  const corpus = loadCorpus();
  const store = new VectorStore(vectorDbPath("harrier"));
  // Sample across the corpus: short, long, early, late.
  const picks = [0, 137, 1500, 4000, 7777, corpus.chunks.length - 1].map(i => corpus.chunks[i]);
  const cached = picks.map(c => store.get(`d:${key(c.text)}`, MODEL.dim));
  const missing = cached.filter(v => !v).length;
  console.log(`sampled ${picks.length} chunks, ${missing} missing from bake-off cache`);

  const fresh = await tryEmbedDocuments(picks.map(c => c.text));
  if (!fresh) { console.log("FAILED"); process.exit(1); }
  console.log("\nchunk  len  cos(production, bakeoff)");
  let worst = 1;
  picks.forEach((c, i) => {
    if (!cached[i]) return;
    const cs = dot(fresh[i], cached[i]!);
    worst = Math.min(worst, cs);
    console.log(`  ${String(i).padStart(2)}  ${String(c.text.length).padStart(5)}   ${cs.toFixed(8)}`);
  });
  console.log(`\nworst cosine: ${worst.toFixed(8)}  -> ${worst > 0.9999 ? "IDENTICAL contract ✅" : "DIVERGENT ❌"}`);
  store.close();
})();
