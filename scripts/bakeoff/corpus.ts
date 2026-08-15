/**
 * Bake-off corpus loader.
 *
 * Reads the conversation log through the SAME parser + chunker the production index
 * uses (conversationSource.parseFile + brainIndex.chunkText), so the thing we're
 * scoring is the real corpus, not a re-implementation of it. If the chunker changes,
 * the bake-off follows automatically.
 *
 * Ground truth is keyed on a content hash rather than (file, ord): ords shift the
 * moment a message is inserted or a file is hand-edited in Obsidian, and an eval set
 * whose answers silently drift is worse than no eval set. The hash is sha256 of the
 * message body, first 16 hex — same body the index hashes into documents.content_hash.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { chunkText } from "../../src/memory/brainIndex";
import { createConversationSource } from "../../src/memory/conversationSource";

export interface CorpusDoc {
  /** 0-based dense index into `docs`. Used everywhere downstream as the doc id. */
  id: number;
  /** `Conversations/2026-07/2026-07-27.md#12` — matches documents.source_id. */
  sourceId: string;
  /** `Conversations/2026-07/2026-07-27.md` */
  file: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  speaker: string;
  text: string;
  /** sha256(text)[0..16). The stable ground-truth key. */
  hash: string;
}

export interface CorpusChunk {
  id: number;
  docId: number;
  ord: number;
  text: string;
}

export interface Corpus {
  docs: CorpusDoc[];
  chunks: CorpusChunk[];
  byHash: Map<string, CorpusDoc[]>;
  bySourceId: Map<string, CorpusDoc>;
}

export function docHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function loadCorpus(conversationsDir?: string): Corpus {
  const source = createConversationSource(conversationsDir ? { conversationsDir } : {});
  const vaultRoot = path.dirname(source.conversationsDir);

  const docs: CorpusDoc[] = [];
  const chunks: CorpusChunk[] = [];

  for (const filePath of source.listFiles()) {
    const content = fs.readFileSync(filePath, "utf8");
    const rel = path.relative(vaultRoot, filePath).split(path.sep).join("/");
    for (const d of source.parseFile(filePath, content)) {
      const created = d.createdAt ?? "";
      const doc: CorpusDoc = {
        id: docs.length,
        sourceId: d.sourceId,
        file: rel,
        date: created.slice(0, 10),
        time: created.slice(11, 16),
        speaker: d.author ?? "",
        text: d.text,
        hash: docHash(d.text),
      };
      docs.push(doc);
      const pieces = chunkText(d.text);
      for (let ord = 0; ord < pieces.length; ord++) {
        chunks.push({ id: chunks.length, docId: doc.id, ord, text: pieces[ord] });
      }
    }
  }

  const byHash = new Map<string, CorpusDoc[]>();
  const bySourceId = new Map<string, CorpusDoc>();
  for (const d of docs) {
    const list = byHash.get(d.hash);
    if (list) list.push(d);
    else byHash.set(d.hash, [d]);
    bySourceId.set(d.sourceId, d);
  }

  return { docs, chunks, byHash, bySourceId };
}
