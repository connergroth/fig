/**
 * Pangram AI-text detection — the async inference API, wrapped.
 *
 * WHY THIS EXISTS: "is this AI-written" is a question the owner asks about arbitrary text they
 * runs into online, and the answer previously required opening pangram.com and pasting into
 * a browser. Same discoverability bug `maps/directions.ts` fixed for traffic: the capability
 * moves to the surface fig already looks at.
 *
 * WHAT IT IS NOT: proof. Pangram is the strongest detector currently available (near-zero
 * false positives on long passages in independent testing) and it is still EVIDENCE. Short
 * text, heavy human editing, formulaic academic prose, and adversarial/"humanized" output all
 * move the answer. Every formatted result therefore carries that line — see `EVIDENCE_LINE`
 * — and the too-short / no-clear-majority cases carry a blunter one on top. A detector score
 * relayed without its caveat is how someone gets accused of cheating over a 0.6.
 *
 * PRIVACY: this is the only tool in the surface whose whole job is shipping the owner's pasted
 * text to a third party. Nothing private (Apple work material, NDA'd docs, other people's
 * DMs) should ever be fed to it, which is stated in the tool description AND repeated in the
 * output so it survives being quoted out of context.
 *
 * THE API SHAPE (docs.pangram.com/api-reference/ai-detection): it's async. POST /task returns
 * a `task_id`, then GET /task/{id} is polled until `stage` is STAGE_SUCCESS or STAGE_FAILED.
 * There is no synchronous endpoint any more — the old one is on the deprecated-endpoints page.
 *
 * Failure is a VALUE, never a throw (same rule as `maps/directions.ts`): a throw inside a tool
 * handler costs the whole turn, and "the detector was down" is a perfectly relayable answer.
 */

/** AI detection + bulk live here; file upload and plagiarism are different hosts entirely. */
export const PANGRAM_BASE = "https://text.external-api.pangram.com";

/**
 * PINNED to `pangram-4`, against their docs' own advice to send `"default"`.
 *
 * Measured, not assumed: `GET /models` for this key returned ["default", "pangram-4"],
 * and a live `"default"` request came back `version: "3.3.2"` — i.e. `default` is still the
 * PREVIOUS generation for us. That matters twice over. Pangram 4 is the release the accuracy
 * case rests on, and it is the generation that emits the `AI-Assisted` window label and the
 * `is_humanized` / humanizer-score head — the two signals this module's verdict and caveats
 * are built on. On 3.3.2 the ai-assisted branch is dead code and the humanizer caveat can
 * never fire, so "default" silently degrades the thing that makes this more than a percentage.
 *
 * The cost of pinning is that we don't automatically ride to Pangram 5. That's the right trade
 * for a detector whose output gets quoted at people: a generation change should be a diff
 * someone reads, and `PANGRAM_MODEL` overrides this without a deploy in the meantime.
 */
export const DEFAULT_MODEL = "pangram-4";

/**
 * The short-sample floor, in words. NOT an API field — Pangram's API accepts anything and
 * returns a confident-looking number regardless, which is precisely the trap. Detection
 * accuracy collapses on short text, so anything under this gets an explicit "inconclusive"
 * caveat rather than a verdict fig will relay as fact.
 */
export const SHORT_SAMPLE_WORDS = 50;

/** A verdict needs a real majority behind it; below this the honest answer is "mixed". */
export const MAJORITY = 0.6;

export const POLL_INTERVAL_MS = 500;
/** A tool call blocking a whole turn is worse than a "took too long" string. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** How many flagged passages get quoted back. Enough to show the pattern, not a wall of text. */
export const MAX_FLAGGED_SHOWN = 3;
const FLAGGED_SNIPPET_CHARS = 200;

export const EVIDENCE_LINE =
  "⚠️ evidence, not proof — detectors can be fooled by editing/humanizers, and 'human' doesn't prove human either. Text was sent to Pangram (left the mini).";

/**
 * The normalized verdict. DERIVED from the fractions Pangram returns, not a field it sends:
 * its own `prediction_short` is only "AI" / "Human" / "Mixed", which collapses the
 * ai-assisted case that the fractions and window labels do distinguish.
 */
export type Verdict = "ai" | "ai-assisted" | "human" | "mixed" | "unclear";

export interface DetectWindow {
  /** The window text as Pangram segmented it. */
  text: string;
  /** Pangram 4: "AI-Generated" | "AI-Assisted" | "Human Written". */
  label: string;
  /** 0..1 — 0 entirely human, 1 fully AI-generated. */
  score: number | null;
  /** "High" | "Medium" | "Low", Pangram's own confidence in this window. */
  confidence: string | null;
  wordCount: number | null;
  /** Pangram 4's humanizer head: was this window run through a "humanizer"? */
  humanized: boolean | null;
}

export interface DetectRead {
  /** Ours, derived. See `Verdict`. */
  verdict: Verdict;
  /** Pangram's own one-liner, e.g. "AI Assisted" / "Human Written". */
  headline: string | null;
  /** Pangram's own long-form sentence. */
  prediction: string | null;
  /** Pangram's own short form: "AI" | "Human" | "Mixed". */
  predictionShort: string | null;
  /** API version identifier, e.g. "4.0". */
  version: string | null;
  model: string;
  fractionAi: number | null;
  fractionAiAssisted: number | null;
  fractionHuman: number | null;
  segments: { ai: number | null; aiAssisted: number | null; human: number | null };
  /** Every window Pangram returned, in document order. */
  windows: DetectWindow[];
  /** The AI / AI-assisted windows, strongest score first. Empty when nothing was flagged. */
  flagged: DetectWindow[];
  /** Only present when the caller asked for a shareable link. */
  dashboardLink: string | null;
  /** Word count of the submitted text — ours, and the basis of the short-sample caveat. */
  wordCount: number;
  /** Blunt, conditional warnings. Never empty-meaning: an empty list means none applied. */
  caveats: string[];
}

export type DetectResult = { ok: true; read: DetectRead } | { ok: false; error: string };

export function pangramConfigured(): boolean {
  return !!process.env.PANGRAM_API_KEY?.trim();
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Largest fraction wins, ties break toward the more-AI label, and anything short of a real
 * majority is reported as "mixed" rather than rounded into a verdict.
 */
export function normalizeVerdict(ai: number | null, assisted: number | null, human: number | null): Verdict {
  const a = num(ai) ?? 0;
  const s = num(assisted) ?? 0;
  const h = num(human) ?? 0;
  const top = Math.max(a, s, h);
  if (top <= 0) return "unclear";
  if (top < MAJORITY) return "mixed";
  if (a === top) return "ai";
  if (s === top) return "ai-assisted";
  return "human";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Is this window one of the AI-ish ones? Matched on the label rather than on a score
 * threshold of our own, because the threshold is Pangram's call to make, not ours.
 *
 * Pangram 4 emits exactly "AI-Generated" | "AI-Assisted" | "Human Written". The `assisted`
 * arm is for the 3.x-era labels the docs mention ("lightly/moderately assisted"), which a
 * PANGRAM_MODEL override could still put in front of us. Unknown labels do NOT get flagged —
 * inventing a finding from a label we don't recognise is the wrong direction to fail in.
 */
export function isFlagged(label: string): boolean {
  const l = label.toLowerCase();
  if (l.includes("human")) return false;
  return /\bai\b/.test(l) || l.startsWith("ai-") || l.includes("assisted");
}

function parseWindows(raw: unknown): DetectWindow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((w: any) => ({
    text: typeof w?.text === "string" ? w.text : "",
    label: str(w?.label) ?? "unknown",
    score: num(w?.ai_assistance_score),
    confidence: str(w?.confidence),
    wordCount: num(w?.word_count),
    humanized: typeof w?.is_humanized === "boolean" ? w.is_humanized : null,
  }));
}

/**
 * The conditional warnings. These are the whole reason this wrapper exists rather than fig
 * relaying raw JSON: the number is easy, knowing when the number means nothing is the job.
 */
export function buildCaveats(read: Omit<DetectRead, "caveats">): string[] {
  const out: string[] = [];

  if (read.wordCount < SHORT_SAMPLE_WORDS) {
    out.push(
      `Sample is ${read.wordCount} word${read.wordCount === 1 ? "" : "s"} — under ~${SHORT_SAMPLE_WORDS}, Pangram is unreliable and this should be treated as INCONCLUSIVE, not a verdict.`,
    );
  }

  if (read.verdict === "mixed") {
    out.push("No clear majority — the text splits across human and AI-ish segments. Read the passages, don't quote a single verdict.");
  }
  if (read.verdict === "unclear") {
    out.push("Pangram returned no usable breakdown for this sample — treat as inconclusive.");
  }

  if (read.flagged.length) {
    const confidences = read.flagged.map((w) => (w.confidence ?? "").toLowerCase());
    if (confidences.length && confidences.every((c) => c === "low")) {
      out.push("Every flagged passage came back LOW confidence — that's a weak signal, not a finding.");
    } else if (confidences.some((c) => c === "low")) {
      out.push("Some flagged passages are LOW confidence — weigh those less.");
    }
    if (read.flagged.some((w) => w.humanized)) {
      out.push("Pangram's humanizer head fired on at least one passage — it thinks the text was run through a humanizer.");
    }
  }

  return out;
}

interface DetectOptions {
  text: string;
  /** A selector from GET /models. Defaults to PANGRAM_MODEL, then "default". */
  model?: string;
  /** Ask for a shareable pangram.com result page in the response. */
  dashboardLink?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injected in tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so polling doesn't spend real seconds. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Turn a non-2xx into the specific reason, because "400" alone tells the owner nothing. */
function httpError(status: number, body: string): string {
  const detail = body.trim().slice(0, 200);
  const known: Record<number, string> = {
    400: "malformed request",
    401: "PANGRAM_API_KEY is missing or invalid",
    403: "that model isn't enabled for this API key (or the task belongs to another key)",
    404: "task not found",
    422: "Pangram rejected the input text or model selector",
    429: "rate limited",
    500: "Pangram had a server error",
    503: "that model is temporarily unavailable",
  };
  const why = known[status] ?? "unexpected response";
  return `Pangram ${status} — ${why}${detail ? `: ${detail}` : ""}`;
}

/**
 * Submit text and poll to a terminal stage. Never throws.
 */
export async function detectAiText(opts: DetectOptions): Promise<DetectResult> {
  const text = String(opts.text ?? "");
  if (!text.trim()) return { ok: false, error: "Nothing to check — `text` was empty." };

  const key = process.env.PANGRAM_API_KEY?.trim();
  if (!key) {
    return { ok: false, error: "Pangram isn't configured — set PANGRAM_API_KEY (key from pangram.com)." };
  }

  const model = opts.model?.trim() || process.env.PANGRAM_MODEL?.trim() || DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const napper = opts.sleepImpl ?? sleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = Math.max(100, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  const headers = { "Content-Type": "application/json", "x-api-key": key };

  let taskId: string;
  try {
    const res = await doFetch(`${PANGRAM_BASE}/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, model, public_dashboard_link: !!opts.dashboardLink }),
    });
    if (!res.ok) return { ok: false, error: httpError(res.status, await res.text().catch(() => "")) };
    const body: any = await res.json();
    const id = str(body?.task_id);
    if (!id) return { ok: false, error: "Pangram accepted the text but returned no task_id." };
    taskId = id;
  } catch (e) {
    return { ok: false, error: `Pangram submit failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await napper(pollMs);
    let body: any;
    try {
      const res = await doFetch(`${PANGRAM_BASE}/task/${taskId}`, { headers: { "x-api-key": key } });
      if (!res.ok) return { ok: false, error: httpError(res.status, await res.text().catch(() => "")) };
      body = await res.json();
    } catch (e) {
      return { ok: false, error: `Pangram poll failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    const stage = str(body?.stage);
    if (stage === "STAGE_FAILED") {
      // On failure the reason rides in `headline` — the rest of the object is zeroed out.
      return { ok: false, error: `Pangram couldn't analyze that: ${str(body?.headline) ?? "no reason given"}` };
    }
    if (stage === "STAGE_SUCCESS") return { ok: true, read: toRead(body, text, model) };

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: `Pangram didn't finish within ${Math.round(timeoutMs / 1000)}s (last stage: ${stage ?? "unknown"}).`,
      };
    }
  }
}

function toRead(body: any, submitted: string, model: string): DetectRead {
  const windows = parseWindows(body?.windows);
  const fractionAi = num(body?.fraction_ai);
  const fractionAiAssisted = num(body?.fraction_ai_assisted);
  const fractionHuman = num(body?.fraction_human);
  const base: Omit<DetectRead, "caveats"> = {
    verdict: normalizeVerdict(fractionAi, fractionAiAssisted, fractionHuman),
    headline: str(body?.headline),
    prediction: str(body?.prediction),
    predictionShort: str(body?.prediction_short),
    version: str(body?.version),
    model,
    fractionAi,
    fractionAiAssisted,
    fractionHuman,
    segments: {
      ai: num(body?.num_ai_segments),
      aiAssisted: num(body?.num_ai_assisted_segments),
      human: num(body?.num_human_segments),
    },
    windows,
    flagged: windows.filter((w) => isFlagged(w.label)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    dashboardLink: str(body?.dashboard_link),
    // The SUBMITTED text, not the normalized `text` Pangram echoes back — the short-sample
    // caveat is about what the owner actually pasted.
    wordCount: countWords(submitted),
  };
  return { ...base, caveats: buildCaveats(base) };
}

const VERDICT_LABEL: Record<Verdict, string> = {
  ai: "AI-GENERATED",
  "ai-assisted": "AI-ASSISTED",
  human: "HUMAN",
  mixed: "MIXED",
  unclear: "INCONCLUSIVE",
};

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function snippet(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > FLAGGED_SNIPPET_CHARS ? `${clean.slice(0, FLAGGED_SNIPPET_CHARS)}…` : clean;
}

/**
 * The model-facing render. Verdict first, Pangram's own words second, the passages third, the
 * caveats last and unskippable — plus a `json:` line so a downstream turn can branch on the
 * numbers without re-parsing prose (same convention as `formatRoute`).
 */
export function formatDetection(read: DetectRead): string {
  const lines: string[] = [];
  const inconclusive = read.verdict === "mixed" || read.verdict === "unclear" || read.wordCount < SHORT_SAMPLE_WORDS;
  lines.push(
    `${VERDICT_LABEL[read.verdict]}${inconclusive ? " (inconclusive)" : ""} — Pangram${read.version ? ` ${read.version}` : ""}${read.headline ? `: "${read.headline}"` : ""}`,
  );
  lines.push(
    `${pct(read.fractionAi)} AI · ${pct(read.fractionAiAssisted)} AI-assisted · ${pct(read.fractionHuman)} human` +
      ` — ${read.wordCount} words, ${read.windows.length} segment${read.windows.length === 1 ? "" : "s"}`,
  );
  if (read.prediction) lines.push(read.prediction);

  if (read.flagged.length) {
    lines.push("", `flagged passages (${read.flagged.length}):`);
    for (const w of read.flagged.slice(0, MAX_FLAGGED_SHOWN)) {
      const meta = [w.label, w.confidence ? `${w.confidence} confidence` : null, w.score === null ? null : `score ${w.score.toFixed(2)}`]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  [${meta}] "${snippet(w.text)}"`);
    }
    if (read.flagged.length > MAX_FLAGGED_SHOWN) {
      lines.push(`  …and ${read.flagged.length - MAX_FLAGGED_SHOWN} more`);
    }
  }

  if (read.caveats.length) {
    lines.push("", ...read.caveats.map((c) => `⚠️ ${c}`));
  }
  if (read.dashboardLink) lines.push("", read.dashboardLink);
  lines.push("", EVIDENCE_LINE);
  lines.push(
    `json: ${JSON.stringify({
      verdict: read.verdict,
      inconclusive,
      fraction_ai: read.fractionAi,
      fraction_ai_assisted: read.fractionAiAssisted,
      fraction_human: read.fractionHuman,
      segments: read.segments,
      flagged_segments: read.flagged.length,
      word_count: read.wordCount,
      prediction_short: read.predictionShort,
      model: read.model,
      version: read.version,
    })}`,
  );
  return lines.join("\n");
}
