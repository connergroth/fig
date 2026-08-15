/**
 * Grounding tool for building the eval set.
 *
 * `tsx scripts/bakeoff/loggrep.ts <regex> [--speaker <owner|agent name>] [--from YYYY-MM-DD]
 *   [--to YYYY-MM-DD] [--limit N] [--chars N] [--json]`
 *
 * Prints one line per matching MESSAGE with its stable ground-truth key, so an eval
 * case can be written against a hash that survives file edits:
 *
 *   2026-07-15 14:02 owner   a1b2c3d4e5f60718  Conversations/2026-07/2026-07-15.md#88
 *     the thing you asked me to look up …
 *
 * Also supports `--id <sourceId>` / `--hash <hash>` to dump one message in full, which
 * is how you VERIFY a case before committing it to the set. A case with a fabricated
 * answer is worse than no case at all.
 */

import { loadCorpus, type CorpusDoc } from "./corpus";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function oneLine(s: string, n: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

function print(d: CorpusDoc, chars: number): void {
  console.log(`${d.date} ${d.time} ${d.speaker.padEnd(6)} ${d.hash}  ${d.sourceId}`);
  console.log(`   ${oneLine(d.text, chars)}`);
}

function main(): void {
  const corpus = loadCorpus();

  const wantId = arg("id");
  const wantHash = arg("hash");
  if (wantId || wantHash) {
    const hits = wantId
      ? [corpus.bySourceId.get(wantId)].filter(Boolean as unknown as (v: CorpusDoc | undefined) => v is CorpusDoc)
      : (corpus.byHash.get(wantHash ?? "") ?? []);
    if (!hits.length) {
      console.log("no such message");
      return;
    }
    for (const d of hits) {
      console.log(`--- ${d.date} ${d.time} ${d.speaker} ${d.hash} ${d.sourceId}`);
      console.log(d.text);
    }
    return;
  }

  const pattern = process.argv[2];
  if (!pattern || pattern.startsWith("--")) {
    console.error("usage: loggrep <regex> [--speaker s] [--from d] [--to d] [--limit n] [--chars n] [--json]");
    process.exit(2);
  }
  const re = new RegExp(pattern, "i");
  const speaker = arg("speaker");
  const from = arg("from");
  const to = arg("to");
  const limit = Number(arg("limit") ?? 40);
  const chars = Number(arg("chars") ?? 260);

  const hits = corpus.docs.filter(
    (d) =>
      re.test(d.text) &&
      (!speaker || d.speaker === speaker) &&
      (!from || d.date >= from) &&
      (!to || d.date <= to),
  );

  if (flag("json")) {
    console.log(
      JSON.stringify(
        hits.slice(0, limit).map((d) => ({ hash: d.hash, date: d.date, time: d.time, speaker: d.speaker, sourceId: d.sourceId, text: oneLine(d.text, chars) })),
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${hits.length} message(s) match /${pattern}/i  (showing ${Math.min(limit, hits.length)})`);
  for (const d of hits.slice(0, limit)) print(d, chars);
}

main();
