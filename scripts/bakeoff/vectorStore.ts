/**
 * Per-model vector cache: one sqlite file per candidate (.state/bakeoff-<model>.db).
 *
 * Content-addressed on sha256(text) rather than on chunk id, so re-running after the
 * eval set grows — or after the chunker changes and most chunks come out identical —
 * only embeds what's actually new. Embedding 11k chunks with the 0.6B model is the
 * expensive step in this whole exercise; paying it twice would be a self-inflicted wound.
 *
 * Vectors are stored as raw float32 BLOBs. 11,092 × 768 × 4B = 34MB for granite,
 * 45MB for harrier. sqlite-vec is deliberately NOT used: brute-force cosine over 11k
 * vectors is tens of milliseconds in plain JS, and the point of this harness is to pick
 * a MODEL, not to prove out an ANN index.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

function loadSqlite(): typeof import("node:sqlite") {
  const orig = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : (warning?.message ?? "");
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return (orig as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:sqlite") as typeof import("node:sqlite");
}

export function textKey(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectors (
  key  TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  dim  INTEGER NOT NULL,
  vec  BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class VectorStore {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = OFF"); // rebuildable cache; a crash just re-embeds
    this.db.exec(SCHEMA);
  }

  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  getMeta(k: string): string | null {
    return (this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v ?? null;
  }

  has(keys: string[]): Set<string> {
    const out = new Set<string>();
    const stmt = this.db.prepare("SELECT key FROM vectors WHERE key = ?");
    for (const k of keys) if (stmt.get(k)) out.add(k);
    return out;
  }

  put(rows: { key: string; role: string; vec: Float32Array }[]): void {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO vectors (key, role, dim, vec) VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        stmt.run(r.key, r.role, r.vec.length, Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Load vectors for `keys` into one flat Float32Array of length keys.length * dim.
   * Rows are in the order given; a missing key leaves its slot zeroed and is reported.
   */
  loadMatrix(keys: string[], dim: number): { matrix: Float32Array; missing: number } {
    const matrix = new Float32Array(keys.length * dim);
    const stmt = this.db.prepare("SELECT vec FROM vectors WHERE key = ?");
    let missing = 0;
    for (let i = 0; i < keys.length; i++) {
      const row = stmt.get(keys[i]) as { vec: Uint8Array } | undefined;
      if (!row) {
        missing++;
        continue;
      }
      const f = new Float32Array(row.vec.buffer, row.vec.byteOffset, dim);
      matrix.set(f, i * dim);
    }
    return { matrix, missing };
  }

  get(key: string, dim: number): Float32Array | null {
    const row = this.db.prepare("SELECT vec FROM vectors WHERE key = ?").get(key) as { vec: Uint8Array } | undefined;
    if (!row) return null;
    return new Float32Array(row.vec.slice().buffer, 0, dim);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as { n: number }).n;
  }

  /** On-disk bytes including the WAL, which is the honest number for a live cache. */
  bytes(): number {
    let n = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        n += fs.statSync(this.dbPath + suffix).size;
      } catch {
        /* absent */
      }
    }
    return n;
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }
}
