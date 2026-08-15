import { config } from "../core/config";
import { mapWithConcurrency } from "../core/concurrency";
import { currentModel } from "../core/model";
import { fetchServer } from "../fetch/tool";
import { log, warn } from "../core/log";
import { runBrainTextResult } from "../runtimes/brain";

/**
 * The deep-research pipeline. Depth here does NOT come from one agent firing many
 * web searches — a single context summarizes away its sources, runs out of room,
 * and "verifies" its own claims with the same context that made them. Real depth
 * comes from many INDEPENDENT contexts, which the Agent SDK gives us as separate
 * query() calls:
 *
 *   1. plan     — decompose the question into focused sub-questions
 *   2. research — one parallel context per sub-question (WebSearch + WebFetch)
 *   3. verify   — a FRESH context per sub-question, prompted to refute, with its
 *                 own searches (adversarial — a different context than found it)
 *   4. synthesize — one context weaves verified findings into a cited report + TLDR
 *
 * Each worker is sandboxed: bypassPermissions (so it never prompts the owner over
 * iMessage mid-run) but the `tools` option hard-restricts what exists in its
 * context — web access only for researchers, nothing at all for plan/synthesize.
 * So a worker can read the web and that's it; only this module's caller writes to
 * the vault. (`allowedTools` would just auto-approve; `tools` is what limits.)
 */

function researchModel(): string {
  return process.env.RESEARCH_MODEL || currentModel();
}
// The fan-out is the depth. Each sub-question is a full independent agent and
// verification doubles it, so ~12 sub-questions ≈ 24 worker contexts + plan +
// synth — perplexity/chatgpt-deep-research tier. The real ceiling isn't cost,
// it's Anthropic rate limits + wall-clock (more parallel workers = more 429s and
// a longer wait), so it's env-tunable rather than cranked blindly.
const MAX_SUBQUESTIONS = Number(process.env.RESEARCH_MAX_SUBQUESTIONS || 12);
// Per-researcher turn budget — higher than the default so each worker can pull
// several primary sources per claim instead of stopping at the first hit.
const RESEARCH_MAX_TURNS = Number(process.env.RESEARCH_MAX_TURNS || 24);
// How many worker contexts may be in flight at once. This is NOT a cost knob — it's
// a correctness one. Firing all ~12 sub-questions as simultaneous SDK sessions is
// what trips the account's session/rate limit, and because every worker's failure
// was swallowed into an empty string, the whole run then died with the useless
// "no sub-question produced any findings" instead of "you're rate limited".
const RESEARCH_CONCURRENCY = Number(process.env.RESEARCH_CONCURRENCY || 4);
// A single transient 429/529 used to permanently lose that sub-question's section.
const WORKER_RETRIES = Number(process.env.RESEARCH_WORKER_RETRIES || 1);
const RETRY_BACKOFF_MS = Number(process.env.RESEARCH_RETRY_BACKOFF_MS || 20_000);

export interface ResearchResult {
  /** Dense, scannable decision brief — what the orchestrator reads to package for the owner. */
  brief: string;
  /** Full vault doc: brief + granular cited evidence base + sources (no frontmatter — worker adds it). */
  report: string;
}

// Bounded-parallel map moved to core/concurrency.ts (one owner — the calendar fan-out
// needs the same primitive, and a second private copy is how two versions drift).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a worker on transient failure (429/529/overloaded) with linear backoff. */
async function withRetry<R>(label: string, fn: () => Promise<R>): Promise<R> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= WORKER_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === WORKER_RETRIES) break;
      const wait = RETRY_BACKOFF_MS * (attempt + 1);
      warn(`research: ${label} failed (attempt ${attempt + 1}), retrying in ${Math.round(wait / 1000)}s: ${e}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Run one isolated worker query and return its final text. */
async function runWorker(opts: {
  prompt: string;
  system?: string;
  tools?: string[];
  maxTurns?: number;
}): Promise<string> {
  // The fetch_url tool is an in-process SDK MCP server; only wire it in when this
  // worker is actually allowed to use it (researchers/verifiers), not plan/synthesize.
  const needsFetch = (opts.tools ?? []).includes(FETCH_TOOL);
  const res = await runBrainTextResult({
    label: "research worker",
    prompt: opts.prompt,
    lane: "research",
    options: {
      cwd: config.brainDir,
      model: researchModel(),
      systemPrompt: opts.system,
      tools: opts.tools ?? [], // hard cap on available tools (none unless given)
      ...(needsFetch ? { mcpServers: { fetch: fetchServer } } : {}),
      permissionMode: "bypassPermissions",
      maxTurns: opts.maxTurns ?? 16,
      // Deliberately bare: no canUseTool, no project settings, no skills, no
      // subagents, no other MCP servers. An isolated research worker.
    },
  });
  if (!res.ok) throw new Error("research worker failed");
  return res.text;
}

/**
 * Parse a newline-delimited list, stripping any leading bullet/number the model
 * added. Avoids JSON entirely — a sub-question containing a bracket or quote can't
 * break a line-split the way it breaks JSON.parse.
 */
function parseList(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0 && !/^(here are|sub-?questions?:)/i.test(l));
}

const REPORT_SENTINEL = "===REPORT===";
const FETCH_TOOL = "mcp__fetch__fetch_url";
const WEB_TOOLS = ["WebSearch", "WebFetch", FETCH_TOOL];

async function plan(question: string, focus?: string): Promise<string[]> {
  const scope = focus ? `\n\nScope / constraints to honor: ${focus}` : "";
  const raw = await runWorker({
    prompt:
      `Break this research question into ${MAX_SUBQUESTIONS} or fewer focused, non-overlapping sub-questions ` +
      `that together cover what's needed to answer it well. Each should be independently researchable.\n\n` +
      `Question: ${question}${scope}\n\n` +
      `Output ONE sub-question per line. No numbering, no bullets, no other text.`,
    system: "You are a research planner. You decompose questions into sharp, non-redundant sub-questions.",
  });
  const subs = parseList(raw).slice(0, MAX_SUBQUESTIONS);
  // Fall back to the bare question if planning produced nothing usable.
  return subs.length ? subs : [question];
}

async function research(subQuestion: string, question: string, focus?: string): Promise<string> {
  const scope = focus ? `\nOverall constraints: ${focus}` : "";
  return runWorker({
    prompt:
      `Research this sub-question thoroughly using web search and by fetching the most credible primary sources.\n\n` +
      `Sub-question: ${subQuestion}\n` +
      `(Part of the larger question: ${question})${scope}\n\n` +
      `Report your findings as markdown. State concrete facts and figures, and put a source URL in ` +
      `parentheses immediately after each claim it supports. Corroborate each KEY claim with more than one ` +
      `independent primary source where you can — don't stop at the first hit. Prefer primary/authoritative ` +
      `sources over aggregators. Note where sources disagree or evidence is thin. Be specific, not generic.\n\n` +
      `Tools: WebSearch to find sources. To read one, prefer fetch_url — it returns the page's REAL content ` +
      `(exact figures, tables, quotes, a JSON API, or a youtube transcript), which matters when the precise ` +
      `numbers do; WebFetch only gives a paraphrase. If fetch_url comes back thin/empty or 401/403 (a ` +
      `JavaScript-rendered or login-walled page), note the source is inaccessible and move on.`,
    system:
      "You are a meticulous researcher. You ground every claim in a citable source and you flag uncertainty " +
      "rather than papering over it.",
    tools: WEB_TOOLS,
    maxTurns: RESEARCH_MAX_TURNS,
  });
}

async function verify(subQuestion: string, findings: string): Promise<string> {
  return runWorker({
    prompt:
      `Adversarially fact-check the findings below. Your job is to REFUTE, not to agree. For the key claims, ` +
      `run your own web searches to confirm, correct, or debunk them. Watch for: outdated figures, ` +
      `misread sources, claims with no real support, and overstated certainty.\n\n` +
      `Sub-question: ${subQuestion}\n\nFindings to check:\n${findings}\n\n` +
      `Return a short markdown "verification note": which claims hold up (with a corroborating source), ` +
      `which need correction (give the corrected fact + source), and which are unsupported and should be ` +
      `dropped. If everything checks out, say so plainly.`,
    system:
      "You are a skeptical fact-checker. You assume claims are wrong until a credible source proves them, " +
      "and you cite the source that settles each one.",
    tools: WEB_TOOLS,
  });
}

async function synthesize(
  question: string,
  focus: string | undefined,
  sections: { sub: string; findings: string; check: string }[],
): Promise<ResearchResult> {
  const scope = focus ? `\nConstraints the answer must respect: ${focus}` : "";
  const dossier = sections
    .map(
      (s, i) =>
        `## Sub-question ${i + 1}: ${s.sub}\n\n### Findings\n${s.findings}\n\n### Verification\n${s.check}`,
    )
    .join("\n\n---\n\n");

  const raw = await runWorker({
    prompt:
      `Write the final research output answering the question below, using ONLY the researched and verified ` +
      `material in the dossier. Where verification corrected or dropped a claim, honor that — do not reinstate ` +
      `refuted claims. Preserve source URLs as inline markdown links throughout.\n\n` +
      `Question: ${question}${scope}\n\n` +
      `=== DOSSIER ===\n${dossier}\n=== END DOSSIER ===\n\n` +
      `Output EXACTLY two parts separated by a line containing only ${REPORT_SENTINEL}.\n\n` +
      `PART 1 — THE BRIEF (before the marker). Dense, scannable, decision-grade. An assistant reads this top ` +
      `to bottom to relay the relevant parts to the person who asked — so make it skim-fast, NOT an essay:\n` +
      `- "Bottom line:" — 2-4 sentences that directly, decisively answer the question.\n` +
      `- "Key findings:" — tight bullets, each a concrete fact or figure with an inline source link. Lead with ` +
      `the number/specifics, not prose. This is the substance, keep it dense.\n` +
      `- "Open questions:" — where evidence is thin or sources disagree (omit the heading if there are none).\n\n` +
      `${REPORT_SENTINEL}\n\n` +
      `PART 2 — THE FULL REPORT (after the marker), for durable storage and drill-down. Start by repeating the ` +
      `bottom line + key findings, then "## Evidence base" laying out each sub-question's verified findings in ` +
      `full with every claim keeping its inline citation, then a final "## Sources" list of all URLs used. ` +
      `This is the granular backing we drill into later — here completeness matters, not brevity.`,
    system:
      "You are a synthesis writer. You produce a crisp, scannable decision brief AND a complete, fully-cited " +
      "evidence base, and you never invent facts beyond the provided dossier.",
    maxTurns: 4,
  });

  // Plain-text sentinel split — no JSON, so braces/quotes in the report can't break it.
  const idx = raw.indexOf(REPORT_SENTINEL);
  if (idx !== -1) {
    const brief = raw.slice(0, idx).replace(/^\s*(?:brief:?)\s*/i, "").trim();
    const report = raw.slice(idx + REPORT_SENTINEL.length).trim();
    if (brief && report) return { brief, report };
    if (report) return { brief: report.slice(0, 1500), report };
  }
  // No marker — treat the whole thing as the report; the orchestrator can still
  // read it to package something for the owner. Never lose the findings.
  warn("research synthesis missing report marker; using whole body as report");
  const report = raw.trim() || `# Research notes\n\n${dossier}`;
  return { brief: report.slice(0, 1500), report };
}

/** Run the full pipeline for one question. Throws on hard failure (no findings). */
export async function runDeepResearch(question: string, focus?: string): Promise<ResearchResult> {
  log(`research: planning "${question.slice(0, 60)}"`);
  const subs = await plan(question, focus);
  log(`research: ${subs.length} sub-questions, fanning out`);

  // Bounded-parallel, independent research contexts — the heart of the depth.
  // Bounded (not Promise.all over every sub-question) because firing ~12 SDK
  // sessions at once is what trips the account session/rate limit; retried
  // because a single transient 429 used to silently delete a whole section.
  const workerErrors: string[] = [];
  const findings = await mapWithConcurrency(subs, RESEARCH_CONCURRENCY, async (sub) => {
    try {
      return { sub, findings: await withRetry(`worker "${sub.slice(0, 40)}"`, () => research(sub, question, focus)) };
    } catch (e) {
      warn(`research worker failed for "${sub.slice(0, 50)}": ${e}`);
      workerErrors.push(`${sub.slice(0, 60)}: ${e instanceof Error ? e.message : String(e)}`);
      return { sub, findings: "" };
    }
  });
  const usable = findings.filter((f) => f.findings.trim());
  if (!usable.length) {
    // Never throw the bare "no findings" again — it hid rate limits for weeks.
    // Surface WHY every worker came back empty.
    const why = workerErrors.length
      ? ` — every worker errored, first: ${workerErrors[0]}${workerErrors.length > 1 ? ` (+${workerErrors.length - 1} more)` : ""}`
      : " — workers returned empty text with no error (check the model/tool config)";
    throw new Error(`no sub-question produced any findings across ${subs.length} sub-questions${why}`);
  }

  log(`research: verifying ${usable.length} sections`);
  const sections = await mapWithConcurrency(usable, RESEARCH_CONCURRENCY, async (f) => {
    try {
      return { ...f, check: await withRetry(`verify "${f.sub.slice(0, 40)}"`, () => verify(f.sub, f.findings)) };
    } catch (e) {
      warn(`verification failed for "${f.sub.slice(0, 50)}": ${e}`);
      return { ...f, check: "(verification pass failed — treat these findings with extra caution)" };
    }
  });

  log("research: synthesizing");
  return synthesize(question, focus, sections);
}
