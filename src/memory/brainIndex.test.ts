/**
 * Brain index tests. Deterministic, no API, no network.
 *
 * Everything runs against a temp vault + temp db — the real vault at
 * config.brainDir is never touched.
 *
 * Run:  npx tsx src/memory/brainIndex.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrainIndex, _internals, type BrainIndexOptions, type IngestDocument, type SourceAdapter } from "./brainIndex";
import { authorValues, createConversationSource, parseConversationFile, toCreatedAt } from "./conversationSource";
import { MODEL as EMBED_MODEL } from "./embedder";

const { matchCandidates, chunkText, upperDateBound } = _internals;

// The speaker vocabulary derives from OWNER_NAME at parse/query time. The fixtures
// below use this machine's historical labels, so pin the env to match — the
// derived-name tests further down flip it (and restore it) to prove a different
// owner works too.
process.env.OWNER_NAME = "sam";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/**
 * Async checks are collected and run after the synchronous ones, so the file keeps its
 * straight-line top-level style instead of becoming one giant async IIFE.
 */
const asyncChecks: [string, () => Promise<void>][] = [];
const acheck = (name: string, fn: () => Promise<void>): void => {
  asyncChecks.push([name, fn]);
};

// --- temp vault scaffolding -------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fig-brainindex-"));
const convDir = path.join(tmpRoot, "Conversations");
const notesDir = path.join(tmpRoot, "Notes");
const dbPath = path.join(tmpRoot, ".state", "test-index.db");

function writeDay(date: string, body: string): string {
  const month = date.slice(0, 7);
  const dir = path.join(convDir, month);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.md`);
  fs.writeFileSync(file, `# ${date}\n\n${body}`);
  return file;
}

/**
 * A second, deliberately trivial corpus. Its only job is to prove the "adding a
 * source is a new adapter, not a schema change" claim — and that source_type is a
 * real pre-filter rather than decoration.
 */
function createNoteSource(): SourceAdapter {
  return {
    sourceType: "note",
    listFiles: () =>
      fs.existsSync(notesDir)
        ? fs
            .readdirSync(notesDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => path.join(notesDir, f))
        : [],
    owns: (p: string) => path.dirname(p) === notesDir && p.endsWith(".md"),
    parseFile: (p: string, content: string): IngestDocument[] => [
      {
        sourceId: path.basename(p),
        uri: p,
        title: path.basename(p, ".md"),
        author: null,
        recipients: null,
        threadId: null,
        labels: ["note"],
        createdAt: "2026-07-05T12:00:00-07:00",
        text: content,
      },
    ],
  };
}

function newIndex(): BrainIndex {
  return new BrainIndex({
    dbPath,
    sources: [createConversationSource({ conversationsDir: convDir }), createNoteSource()],
  });
}

console.log("brain index");

// --- 1. parsing (unchanged from the bespoke build) --------------------------

check("parses both speakers, a # header, and a multi-line continuation", () => {
  const content = [
    "# 2026-07-01",
    "",
    "[09:15] sam: what's the plan for coffee today",
    "[09:16] fig: philz at 10, then the drive",
    "this line wrapped and is a continuation",
    "so is this one",
    "[09:20] sam: sounds good",
    "",
  ].join("\n");

  const msgs = parseConversationFile("/x/2026-07-01.md", content);
  assert.equal(msgs.length, 3, "three messages");
  assert.equal(msgs[0].speaker, "owner", "the configured name normalizes to the canonical label");
  assert.equal(msgs[0].time, "09:15");
  assert.equal(msgs[0].date, "2026-07-01", "date comes from the filename");
  assert.equal(msgs[1].speaker, "agent");
  assert.equal(
    msgs[1].text,
    "philz at 10, then the drive\nthis line wrapped and is a continuation\nso is this one",
    "continuations join with newlines",
  );
  assert.equal(msgs[2].text, "sounds good");
  assert(msgs[0].ts > 0 && msgs[1].ts > msgs[0].ts, "ts is derived and monotonic within a day");
  assert.deepEqual(
    msgs.map((m) => m.ord),
    [0, 1, 2],
    "ord is the stable half of source_id",
  );
});

check("normalizes pre-rename (owner/bot) and [bg] speaker labels", () => {
  // Older transcripts label the two speakers owner/bot, and /bg turns carry a [bg] suffix.
  // They're the same two speakers either way and must not be dropped from the index.
  const content = [
    "# 2026-06-13",
    "",
    "[20:12] owner: yo gonna test something",
    "[20:12] bot: yeah send it over",
    "[20:30] sam[bg]: background question",
    "[20:31] fig[bg]: background answer",
  ].join("\n");
  const msgs = parseConversationFile("/x/2026-06-13.md", content);
  assert.equal(msgs.length, 4);
  assert.deepEqual(
    msgs.map((m) => m.speaker),
    ["owner", "agent", "owner", "agent"],
  );
});

check("the speaker vocabulary derives from OWNER_NAME — a different owner's lines parse too", () => {
  // THE public-readiness failure this guards: with OWNER_NAME=alex the transcript
  // writer emits "[09:15] alex: …", and a hardcoded vocabulary silently dropped
  // every owner message from the index.
  const prev = process.env.OWNER_NAME;
  process.env.OWNER_NAME = "alex";
  try {
    const content = ["[09:15] alex: the boiler in the basement is leaking again", "[09:16] fig: calling the plumber"].join("\n");
    const msgs = parseConversationFile("/x/2026-07-04.md", content);
    assert.deepEqual(
      msgs.map((m) => m.speaker),
      ["owner", "agent"],
    );
    assert.deepEqual(authorValues("owner"), ["owner", "alex"], "reads accept the canonical label AND the configured name");
  } finally {
    process.env.OWNER_NAME = prev;
  }
});

check("skips empty messages and non-dated filenames", () => {
  const msgs = parseConversationFile("/x/2026-07-01.md", "# 2026-07-01\n\n[10:00] sam: \n[10:01] fig: real\n");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, "real");
  assert.equal(parseConversationFile("/x/notes.md", "[10:00] sam: hi\n").length, 0);
});

check("created_at is a real ISO timestamp whose first 10 chars are the date", () => {
  const c = toCreatedAt("2026-07-01", "09:15");
  assert.equal(c.slice(0, 10), "2026-07-01");
  assert.equal(c.slice(11, 16), "09:15");
  assert(/[+-]\d{2}:\d{2}$/.test(c), `carries a zone offset: ${c}`);
  // A bare-date upper bound must sort ABOVE every timestamp on that day.
  assert(c <= upperDateBound("2026-07-01")!, "date filters can't silently drop the boundary day");
});

// --- 2. chunking ------------------------------------------------------------

check("short text is exactly one chunk", () => {
  assert.deepEqual(chunkText("philz at 10, then the drive"), ["philz at 10, then the drive"]);
  assert.deepEqual(chunkText("   "), []);
  assert.equal(chunkText("x".repeat(_internals.CHUNK_MAX_CHARS)).length, 1, "at the cap, still one chunk");
});

check("a long message splits into overlapping, boundary-aligned chunks", () => {
  const para = "the ceiling is the hvac and there are no dropped ceilings anywhere in the ring. ";
  const long = para.repeat(400); // ~32k chars, same order as the real 45k outlier
  const pieces = chunkText(long);
  assert(pieces.length > 10, `splits into many chunks, got ${pieces.length}`);
  assert(
    pieces.every((p) => p.length <= _internals.CHUNK_MAX_CHARS),
    "no chunk exceeds the max",
  );
  // Overlap: consecutive chunks share text, so a phrase across a cut still matches.
  const joined = pieces.join("").length;
  assert(joined > long.trim().length, "chunks overlap rather than tile exactly");
  assert(joined < long.length * 1.4, "overlap stays modest (~15%), not a duplication blowup");
});

// --- 3. incremental ingest --------------------------------------------------

const fileA = writeDay(
  "2026-07-01",
  ["[09:15] sam: what's the plan for coffee today", "[09:16] fig: philz at 10, then the drive"].join("\n") + "\n",
);
const fileB = writeDay(
  "2026-07-02",
  [
    "[11:00] sam: is supabase still the right call for the auth table",
    "[11:02] fig: yeah, supabase row level security handles it",
    "[19:30] sam: pin the dark knight for thursday",
    "[19:31] fig: pinned, dark knight 6:45 on the porto vista roof",
  ].join("\n") + "\n",
);

// One genuinely long message, so the multi-chunk path is exercised end to end.
const longNeedle = "the seele glass panels are the largest curved architectural glass ever produced";
const filler = "apple park has nine thousand trees and twenty five varieties of fruit. ";
writeDay("2026-07-03", `[08:00] fig: ${filler.repeat(30)}${longNeedle}. ${filler.repeat(30)}\n`);

fs.mkdirSync(notesDir, { recursive: true });
fs.writeFileSync(path.join(notesDir, "coffee-spots.md"), "philz, blue bottle, and the coffee cart at bubb rd\n");

const idx = newIndex();

check("initial build indexes every file across every source", () => {
  const r = idx.rebuildAll();
  assert.equal(r.files, 4, "3 conversation days + 1 note");
  assert.equal(r.documents, 8, "7 messages + 1 note");
  const s = idx.stats();
  assert.equal(s.bySourceType.conversation.documents, 7);
  assert.equal(s.bySourceType.note.documents, 1);
  assert(
    s.bySourceType.conversation.chunks > s.bySourceType.conversation.documents,
    "the long message contributed extra chunks",
  );
});

check("unchanged file is skipped on reindex", () => {
  assert.equal(idx.indexFile(fileA), 0, "mtime+size unchanged => 0 documents written");
  assert.equal(idx.syncAll().changed, 0, "nothing changed across the whole index");
});

check("changed file is re-parsed without duplicating documents", () => {
  fs.appendFileSync(fileA, "[09:40] sam: one more coffee line\n");
  // Force a distinct mtime — the test can otherwise run inside one fs tick.
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(fileA, future, future);

  const written = idx.indexFile(fileA);
  assert.equal(written, 3, "the whole file is re-parsed, not appended to");
  assert.equal(idx.stats().bySourceType.conversation.documents, 8, "7 + 1 new, no duplicates");

  const hits = idx.search({ query: "coffee", sourceTypes: ["conversation"] });
  assert.equal(hits.totalHits, 2, "both coffee messages, each exactly once");
});

check("content_hash gates re-chunking — untouched documents are left alone", () => {
  // The property the whole incremental design rests on: appending one message to a
  // day file must not re-chunk the other 300. Once vectors land, "re-chunked" means
  // "re-embedded", and a full re-embed on every inbound message is the failure mode
  // the spec's content_hash exists to prevent.
  //
  // Chunk ids are the proof: they're autoincrement, so a delete+reinsert can't
  // preserve them.
  const chunkIds = () =>
    JSON.stringify(
      idx.search({ query: "philz", sourceTypes: ["conversation"] }).results.map((h) => h.document_id),
    );
  const priorDoc = chunkIds();
  const priorChunkCount = idx.stats().bySourceType.conversation.chunks;

  fs.appendFileSync(fileA, "[09:50] fig: adding a line that touches nothing else\n");
  const future = new Date(Date.now() + 3000);
  fs.utimesSync(fileA, future, future);
  idx.indexFile(fileA);

  assert.equal(chunkIds(), priorDoc, "the untouched message kept its document id");
  assert.equal(
    idx.stats().bySourceType.conversation.chunks,
    priorChunkCount + 1,
    "exactly one chunk added — the other messages were not re-chunked",
  );
});

const FILE_A_FULL =
  "# 2026-07-01\n\n" +
  "[09:15] sam: what's the plan for coffee today\n" +
  "[09:16] fig: philz at 10, then the drive\n" +
  "[09:40] sam: one more coffee line\n" +
  "[09:50] fig: adding a line that touches nothing else\n";

check("a deleted message is dropped from the index on re-parse", () => {
  const before = idx.stats().bySourceType.conversation.documents;
  fs.writeFileSync(fileA, "# 2026-07-01\n\n[09:15] sam: what's the plan for coffee today\n");
  const future = new Date(Date.now() + 4000);
  fs.utimesSync(fileA, future, future);
  assert.equal(idx.indexFile(fileA), 1);
  assert.equal(idx.stats().bySourceType.conversation.documents, before - 3, "three removed messages are gone");
  assert.equal(
    idx.search({ query: "philz", sourceTypes: ["conversation"] }).totalHits,
    0,
    "their chunks went too, not just the doc rows (the note still mentions philz)",
  );

  // Put it back so later assertions read the fuller file.
  fs.writeFileSync(fileA, FILE_A_FULL);
  const later = new Date(Date.now() + 6000);
  fs.utimesSync(fileA, later, later);
  assert.equal(idx.indexFile(fileA), 4);
  assert.equal(idx.stats().bySourceType.conversation.documents, before);
});

check("stats report range, chunk counts, and a real db size", () => {
  const s = idx.stats();
  assert.equal(s.bySourceType.conversation.firstDate, "2026-07-01");
  assert.equal(s.bySourceType.conversation.lastDate, "2026-07-03");
  assert.equal(s.bySourceType.conversation.files, 3);
  assert(s.chunks >= s.documents, "at least one chunk per document");
  assert(s.dbBytes > 0, "db file exists on disk");
});

// --- 4. search --------------------------------------------------------------

check("search returns ranked, snippeted results — never the whole document", () => {
  const r = idx.search({ query: "supabase" });
  assert.equal(r.totalHits, 2);
  assert(r.results.length > 0);
  assert(r.results[0].snippet.includes("«"), "match is delimited with guillemets");
  assert(r.results.every((h) => h.snippet.length <= _internals.MAX_SNIPPET_CHARS + 1));
  assert.equal(r.results[0].source_type, "conversation");
  assert(r.results[0].document_id > 0);
  assert(r.results[0].thread_id?.startsWith("Conversations/"), "thread_id is the vault relpath");
  assert(r.results[0].uri?.endsWith("2026-07-02.md"));
});

check("a multi-chunk document collapses to ONE hit, matched in the right chunk", () => {
  const r = idx.search({ query: "seele glass" });
  assert.equal(r.totalHits, 1, "one document, not one hit per matching chunk");
  assert.equal(r.results.length, 1);
  assert(r.results[0].snippet.includes("«"), "the snippet is the matching window, not the head of a 4kb blob");
  assert(/seele/i.test(r.results[0].snippet));
});

check("source_type is a pre-filter, not decoration", () => {
  const all = idx.search({ query: "coffee" });
  const convo = idx.search({ query: "coffee", sourceTypes: ["conversation"] });
  const note = idx.search({ query: "coffee", sourceTypes: ["note"] });
  assert.equal(all.totalHits, 3, "2 messages + 1 note mention coffee");
  assert.equal(convo.totalHits, 2);
  assert.equal(note.totalHits, 1);
  assert(convo.results.every((h) => h.source_type === "conversation"));
  assert.equal(note.results[0].source_type, "note");
  assert.equal(idx.search({ query: "coffee", sourceTypes: ["email"] }).totalHits, 0, "unknown type matches nothing");
});

check("k is respected and hard-capped at 50", () => {
  assert.equal(idx.search({ query: "the", k: 1 }).results.length, 1);
  assert(idx.search({ query: "the", k: 999 }).results.length <= 50);
});

check("author filter narrows to one speaker", () => {
  const owner = idx.search({ query: "supabase", author: authorValues("owner") });
  const agent = idx.search({ query: "supabase", author: authorValues("agent") });
  assert.equal(owner.totalHits, 1);
  assert.equal(agent.totalHits, 1);
  assert(owner.results.every((h) => h.author === "owner"), "new rows carry the canonical label");
  assert(agent.results.every((h) => h.author === "agent"));
});

check("legacy author rows (the configured names) still match without a rebuild", () => {
  // The on-disk index predating the canonical labels stores the then-configured
  // names in documents.author. authorValues() carries both vocabularies, so those
  // rows must keep matching as-is — no migration, no rebuild.
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE documents SET author = 'sam' WHERE author = 'owner'").run();
  raw.prepare("UPDATE documents SET author = 'fig' WHERE author = 'agent'").run();
  raw.close();

  const owner = idx.search({ query: "supabase", author: authorValues("owner") });
  const agent = idx.search({ query: "supabase", author: authorValues("agent") });
  assert.equal(owner.totalHits, 1, "the legacy owner row matched the owner filter");
  assert.equal(agent.totalHits, 1, "the legacy agent row matched the agent filter");
  assert(owner.results.every((h) => h.author === "sam"), "and it really is a legacy-vocabulary row");
  // Left mutated on purpose: nothing below filters on author until the rebuild
  // checks re-parse the files, which restores the canonical labels.
});

check("an OWNER_NAME=alex vault indexes and recalls its owner's messages end to end", () => {
  const prev = process.env.OWNER_NAME;
  process.env.OWNER_NAME = "alex";
  const alexDir = path.join(tmpRoot, "AlexConversations");
  try {
    const dir = path.join(alexDir, "2026-07");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "2026-07-04.md"),
      "# 2026-07-04\n\n[09:15] alex: the boiler in the basement is leaking again\n[09:16] fig: calling the plumber\n",
    );
    const aidx = new BrainIndex({
      dbPath: path.join(tmpRoot, ".state", "alex-index.db"),
      sources: [createConversationSource({ conversationsDir: alexDir })],
    });
    const r = aidx.rebuildAll();
    assert.equal(r.documents, 2, "the owner's line was not dropped on the floor");
    const owner = aidx.search({ query: "boiler", author: authorValues("owner") });
    assert.equal(owner.totalHits, 1);
    assert.equal(owner.results[0].author, "owner");
    aidx.close();
  } finally {
    process.env.OWNER_NAME = prev;
    fs.rmSync(alexDir, { recursive: true, force: true });
  }
});

check("date filters bound the range inclusively on both ends", () => {
  const c = { sourceTypes: ["conversation"] };
  assert.equal(idx.search({ ...c, query: "coffee", dateFrom: "2026-07-02" }).totalHits, 0, "coffee is only on 07-01");
  assert.equal(idx.search({ ...c, query: "coffee", dateTo: "2026-07-01" }).totalHits, 2, "the boundary day is included");
  assert.equal(idx.search({ ...c, query: "knight", dateFrom: "2026-07-02", dateTo: "2026-07-02" }).totalHits, 2);
});

check("multi-word query is AND-ed (phrase intent)", () => {
  const r = idx.search({ query: "dark knight" });
  assert.equal(r.totalHits, 2);
});

check("a natural-language question falls back past the AND rung instead of returning nothing", () => {
  // THE regression. fts5's implicit operator is AND, so the raw-query rung asks for
  // every term in one chunk. A real recall question never satisfies that, and fts5
  // returns zero rows WITHOUT throwing — so a ladder that advanced only on `throw`
  // left the OR fallback unreachable for exactly the queries it exists to serve.
  // Measured cost of the bug on the 94-case bake-off set: 64 cases returning nothing,
  // and the mined-paraphrase category at a literal 0.000 MRR.
  const q = "what movie did we end up pinning for thursday night";
  const r = idx.search({ query: q, sourceTypes: ["conversation"] });

  // matchQuery is self-proving: the OR rung is the LAST one on the ladder, so
  // settling there means every tighter rung (raw AND, quoted-terms AND, whole-string
  // phrase) came back empty and the loop advanced past each of them. Before the fix
  // this call returned zero rows with matchQuery = the raw query.
  assert(r.matchQuery.includes(" OR "), `settled on the OR fallback, got ${JSON.stringify(r.matchQuery)}`);
  assert(r.totalHits > 0, "the ladder advanced past the empty AND rung and found real rows");
  assert(r.results.length > 0, "and returned them");
  assert(
    r.results.some((h) => /knight/i.test(h.snippet)),
    "the dark knight message is in the recovered result set",
  );
});

check("a query that DOES match at a tight rung is not diluted by the looser ones", () => {
  // The other half of the fix: advancing on empty must not turn every search into the
  // widest possible OR. A precise query still stops at the first rung that matched.
  const r = idx.search({ query: "dark knight" });
  assert.equal(r.matchQuery, "dark knight", "stopped at the raw AND rung");
  assert.equal(r.totalHits, 2, "did not widen to every message containing 'dark' or 'knight'");
});

check("payload stays under the 8000-char cap", () => {
  const r = idx.search({ query: "the", k: 50 });
  const total = r.results.reduce((n, h) => n + h.snippet.length, 0);
  assert(total <= _internals.MAX_PAYLOAD_CHARS, `payload ${total} must stay under the cap`);
});

// --- 5. adversarial fts5 syntax --------------------------------------------

check("adversarial fts5 syntax does not throw", () => {
  const nasty = [
    'foo"bar AND',
    "coffee AND",
    '"unbalanced',
    "NEAR(",
    "*",
    "((()))",
    "OR OR OR",
    "-",
    "supabase OR",
    'dark "knight',
  ];
  for (const q of nasty) {
    const r = idx.search({ query: q }); // must not throw
    assert(Array.isArray(r.results), `query ${JSON.stringify(q)} returned a result set`);
  }
});

check("adversarial query still finds the obvious match", () => {
  // 'foo"bar AND' is junk, but a quote-mangled real term should still resolve
  // via the fallback candidates rather than silently returning nothing.
  const r = idx.search({ query: 'supabase" AND' });
  assert(r.totalHits > 0, "falls back to a safe expression and still matches");
});

check("bare AND/OR are dropped, not searched as literal words", () => {
  // The regression this guards: quoting `AND` as a term over-constrains the fallback
  // and turns a recoverable query into a silent zero-hit result — the worst failure
  // mode, a search that looks like it worked.
  assert(idx.search({ query: "coffee AND" }).totalHits > 0, "dangling AND still finds coffee");
  assert(idx.search({ query: "supabase OR" }).totalHits > 0, "dangling OR still finds supabase");
  assert(!matchCandidates("coffee AND").some((c) => c.includes('"AND"')), "AND is never quoted as a term");
});

check("empty query returns empty, not a throw", () => {
  assert.equal(idx.search({ query: "" }).results.length, 0);
  assert.equal(idx.search({ query: "   " }).totalHits, 0);
});

check("matchCandidates degrades from raw to phrase", () => {
  assert.equal(matchCandidates("dark knight")[0], "dark knight", "clean query passes through first");
  const nasty = matchCandidates('foo"bar AND');
  assert(!nasty.includes('foo"bar AND'), "unbalanced quotes never offered as-is");
  assert(nasty.length > 0);
});

// --- 6. rebuild is idempotent ----------------------------------------------

check("rebuildAll is idempotent and leaves no orphaned fts rows", () => {
  const before = idx.search({ query: "supabase" }).totalHits;
  idx.rebuildAll();
  idx.rebuildAll();
  assert.equal(idx.search({ query: "supabase" }).totalHits, before, "still 2, not 4");
  assert.equal(idx.search({ query: "seele glass" }).totalHits, 1);
});

check("a vanished file is forgotten on syncAll", () => {
  fs.rmSync(fileB);
  const s = idx.syncAll();
  assert.equal(s.files, 3, "one conversation day gone");
  assert.equal(idx.search({ query: "supabase" }).totalHits, 0, "its documents and chunks went with it");
});

// --- 7. vectors + hybrid retrieval -----------------------------------------
//
// All of this runs on SYNTHETIC vectors injected through the BrainIndexOptions.embed
// seam. Nothing here downloads a 700MB model or runs ONNX: the point is to prove the
// wiring — storage, cascade, contract enforcement, fusion, degradation — not to
// re-measure retrieval quality, which is what scripts/bakeoff/runProduction.ts does
// against the real model.

const DIM = EMBED_MODEL.dim;

/**
 * A deterministic stand-in for a real embedder.
 *
 * Builds a unit vector from a bag of words, so texts sharing vocabulary are close and
 * unrelated texts are near-orthogonal — enough structure for "does the right document
 * come back" to mean something, with zero model dependency.
 */
function fakeEmbed(texts: string[]): Float32Array[] {
  return texts.map((t) => {
    const v = new Float32Array(DIM);
    for (const word of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
      v[h % DIM] += 1;
    }
    let n = 0;
    for (let i = 0; i < DIM; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < DIM; i++) v[i] /= n;
    return v;
  });
}

function vecIndex(embed?: BrainIndexOptions["embed"]): BrainIndex {
  return new BrainIndex({
    dbPath: path.join(tmpRoot, ".state", "vec-index.db"),
    sources: [createConversationSource({ conversationsDir: vecConvDir }), createNoteSource()],
    embed: embed ?? (async (texts) => fakeEmbed(texts)),
  });
}

// The vector section gets its OWN conversation dir. The sync section above mutates and
// deletes its fixtures as part of what it's testing, so sharing them would make these
// checks depend on the exact order the earlier ones happened to leave things in.
const vecConvDir = path.join(tmpRoot, "VecConversations");
function writeVecDay(date: string, body: string): string {
  const dir = path.join(vecConvDir, date.slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.md`);
  fs.writeFileSync(file, `# ${date}\n\n${body}`);
  return file;
}

const vFileA = writeVecDay(
  "2026-07-01",
  ["[09:15] sam: what's the plan for coffee today", "[09:16] fig: philz at 10, then the drive"].join("\n") + "\n",
);
writeVecDay(
  "2026-07-02",
  [
    "[11:00] sam: is supabase still the right call for the auth table",
    "[11:02] fig: yeah, supabase row level security handles it",
    "[19:30] sam: pin the dark knight for thursday",
  ].join("\n") + "\n",
);
writeVecDay(
  "2026-07-03",
  `[08:00] fig: ${"apple park has nine thousand trees and twenty five varieties of fruit. ".repeat(30)}${longNeedle}. ${"apple park has nine thousand trees and twenty five varieties of fruit. ".repeat(30)}\n`,
);

const vidx = vecIndex();
vidx.rebuildAll();

acheck("a fresh index has no vectors and reports every chunk as pending", async () => {
  const s = vidx.vectorStatus();
  assert.equal(s.vectors, 0);
  assert.equal(s.contract, null, "no contract is stamped until the first vector is written");
  assert.equal(s.mismatch, false);
  assert.equal(vidx.pendingEmbedCount(), s.chunks);
  assert(s.chunks > 0);
});

acheck("hybrid degrades to keyword-only when nothing is embedded", async () => {
  const r = await vidx.searchHybrid({ query: "supabase", sourceTypes: ["conversation"] });
  assert.equal(r.retrieval, "bm25", "no vectors => keyword path, and it SAYS so");
  assert(r.results.length > 0, "still returns real results rather than failing");
});

acheck("embedPending writes one vector per chunk and stamps the contract", async () => {
  const n = await vidx.embedPending();
  const s = vidx.vectorStatus();
  assert.equal(n, s.chunks, "every chunk got a vector");
  assert.equal(s.vectors, s.chunks);
  assert.equal(vidx.pendingEmbedCount(), 0);
  assert(s.contract?.includes(String(DIM)), `contract records the dimension: ${s.contract}`);
  assert.equal(s.mismatch, false);
  assert.equal(await vidx.embedPending(), 0, "a second pass is a no-op");
});

acheck("hybrid actually fuses once vectors exist", async () => {
  const r = await vidx.searchHybrid({ query: "supabase", sourceTypes: ["conversation"] });
  assert.equal(r.retrieval, "hybrid");
  assert(r.results.length > 0);
  assert(r.results.every((h) => h.snippet.length > 0), "every hit carries a snippet");
});

acheck("a vector-only match is found where keyword search returns nothing", async () => {
  // No shared token with any message, but heavy vocabulary overlap with the philz line.
  // bm25 cannot do this; the fused vector list must.
  const q = "philz drive plan";
  const hybrid = await vidx.searchHybrid({ query: q, sourceTypes: ["conversation"], k: 10 });
  assert.equal(hybrid.retrieval, "hybrid");
  assert(hybrid.results.some((h) => /philz/i.test(h.snippet)), "the semantically-near message came back");
});

acheck("only pending chunks are re-embedded after an append", async () => {
  const before = vidx.vectorStatus().vectors;
  fs.appendFileSync(vFileA, "[10:30] sam: a brand new line needing exactly one vector\n");
  const future = new Date(Date.now() + 9000);
  fs.utimesSync(vFileA, future, future);
  vidx.indexFile(vFileA);

  assert.equal(vidx.pendingEmbedCount(), 1, "exactly one chunk is missing a vector");
  const n = await vidx.embedPending();
  assert.equal(n, 1, "and exactly one is embedded — not the whole corpus");
  assert.equal(vidx.vectorStatus().vectors, before + 1);
});

acheck("re-chunking a document cascades its stale vectors away", async () => {
  // A vector outliving the text it describes is the one corruption that survives a
  // rebuild silently. ON DELETE CASCADE is what prevents it.
  const before = vidx.vectorStatus();
  assert.equal(before.vectors, before.chunks, "precondition: fully embedded");

  fs.writeFileSync(vFileA, "# 2026-07-01\n[09:15] sam: what's the plan for coffee today\n");
  const future = new Date(Date.now() + 11000);
  fs.utimesSync(vFileA, future, future);
  vidx.indexFile(vFileA);

  const after = vidx.vectorStatus();
  assert(after.chunks < before.chunks, "chunks were removed");
  assert.equal(after.vectors, after.chunks, "no vector outlived its chunk");
});

acheck("a contract mismatch REFUSES the vectors instead of using them", async () => {
  // The failure this guards is the quiet one: cosine over vectors from two different
  // models still returns numbers, they're just meaningless.
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const raw = new DatabaseSync(path.join(tmpRoot, ".state", "vec-index.db"));
  raw.prepare("UPDATE index_meta SET v = ? WHERE k = 'embed_contract'").run("some-other-model|q8|768|");
  raw.close();

  const fresh = vecIndex();
  const s = fresh.vectorStatus();
  assert.equal(s.mismatch, true, "the mismatch is detected and reported");
  assert(s.vectors > 0, "the stale vectors are still on disk, not silently deleted");

  const r = await fresh.searchHybrid({ query: "supabase", sourceTypes: ["conversation"] });
  assert.equal(r.retrieval, "bm25", "search refused the vectors and degraded");
  assert(r.results.length > 0, "keyword search still works — a bad contract is not an outage");

  assert.equal(await fresh.embedPending(), 0, "ingest also refuses to add to a mismatched space");
  fresh.close();
});

acheck("embed_model is stamped iff a vector exists, both ways", async () => {
  // The column sat NULL for every row for a week — written by nothing, read by nothing.
  // It's provenance now (which model embedded this chunk), and the only thing that makes
  // it trustworthy is that it can't drift from chunk_vectors in either direction.
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const dbPath = path.join(tmpRoot, ".state", "vec-index.db");

  const violations = (): number => {
    const raw = new DatabaseSync(dbPath);
    const n = (
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM chunks " +
            "WHERE (embed_model IS NOT NULL) != (id IN (SELECT chunk_id FROM chunk_vectors))",
        )
        .get() as { n: number }
    ).n;
    raw.close();
    return n;
  };

  const stampedCount = (): number => {
    const raw = new DatabaseSync(dbPath);
    const n = (
      raw.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embed_model IS NOT NULL").get() as { n: number }
    ).n;
    raw.close();
    return n;
  };

  const fresh = vecIndex();
  assert.equal(violations(), 0, "embedded corpus: every vector has a stamp and vice versa");
  assert(stampedCount() > 0, "and the stamp is actually written, not just consistently absent");

  fresh.dropVectors();
  assert.equal(stampedCount(), 0, "dropping vectors clears the stamps with them");
  assert.equal(violations(), 0);

  await fresh.embedPending();
  assert(stampedCount() > 0, "re-embedding restores both sides together");
  assert.equal(violations(), 0);
  fresh.close();
});

acheck("dropVectors clears the space and lets it be rebuilt", async () => {
  const fresh = vecIndex();
  fresh.dropVectors();
  const s = fresh.vectorStatus();
  assert.equal(s.vectors, 0);
  assert.equal(s.contract, null, "the stale contract went with the vectors");
  assert.equal(s.mismatch, false);

  const n = await fresh.embedPending();
  assert(n > 0, "re-embeds from scratch");
  assert.equal(fresh.vectorStatus().mismatch, false);
  fresh.close();
});

acheck("an embedder that throws degrades instead of propagating", async () => {
  const broken = vecIndex(async () => {
    throw new Error("onnx runtime exploded");
  });
  const r = await broken.searchHybrid({ query: "supabase", sourceTypes: ["conversation"] });
  assert.equal(r.retrieval, "bm25", "a thrown embedder is not an error for the caller");
  assert(r.results.length > 0, "and the answer is still useful");
  broken.close();
});

acheck("an embedder that reports unavailable degrades too", async () => {
  const off = vecIndex(async () => null);
  const r = await off.searchHybrid({ query: "supabase", sourceTypes: ["conversation"] });
  assert.equal(r.retrieval, "bm25");
  assert(r.results.length > 0);
  // And ingest stops cleanly rather than half-writing.
  off.dropVectors();
  assert.equal(await off.embedPending(), 0, "no vectors written when the model is unavailable");
  off.close();
});

acheck("metadata filters pre-filter the vector half too", async () => {
  const fresh = vecIndex();
  await fresh.embedPending();
  const owner = await fresh.searchHybrid({
    query: "coffee plan today",
    sourceTypes: ["conversation"],
    author: authorValues("owner"),
  });
  assert(owner.results.length > 0);
  assert(
    owner.results.every((h) => h.author === "owner"),
    "a vector-only hit must still respect the author filter",
  );
  const noted = await fresh.searchHybrid({ query: "coffee", sourceTypes: ["note"] });
  assert(
    noted.results.every((h) => h.source_type === "note"),
    "source_type pre-filters the fused list, not just the keyword half",
  );
  fresh.close();
});

acheck("hybrid respects k and the payload cap", async () => {
  const fresh = vecIndex();
  await fresh.embedPending();
  const r = await fresh.searchHybrid({ query: "the", k: 3, sourceTypes: ["conversation"] });
  assert(r.results.length <= 3, "k is honoured after fusion");
  const total = r.results.reduce((n, h) => n + h.snippet.length, 0);
  assert(total <= _internals.MAX_PAYLOAD_CHARS, "fused results obey the same payload cap");
  fresh.close();
});

acheck("the top strict-bm25 hit is never displaced out of the returned set", async () => {
  // The rank-preserving floor. Modelled on bake-off case C03, where the vector list
  // flooded the top 10 and pushed a correct exact-token hit out entirely.
  //
  // The fake embedder is pointed AWAY from the keyword answer (it returns an unrelated
  // ordering), so without the pin the bm25 hit would be crowded out.
  const fresh = vecIndex(async (texts, role) =>
    role === "query" ? fakeEmbed(["apple park trees orchard ceiling glass"]) : fakeEmbed(texts),
  );
  await fresh.embedPending();
  const r = await fresh.searchHybrid({ query: "seele glass", sourceTypes: ["conversation"], k: 5 });
  assert(
    r.results.some((h) => /seele/i.test(h.snippet)),
    "the exact-token match survived fusion even though the vector list disagreed",
  );
  fresh.close();
});

// --- run the async checks, then tear down -----------------------------------

void (async () => {
  for (const [name, fn] of asyncChecks) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }

  vidx.close();
  idx.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`\n${passed} checks passed ✅`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
