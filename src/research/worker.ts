import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { setSession } from "../session/agent";
import { isQuietSentinel, OUTPUT_CONTRACT, sleep, stripMarkdown, unwrapOutput } from "../render/chunking";
import { pacedSend } from "../render/deliver";
import { config } from "../core/config";
import { log, warn } from "../core/log";
import { proactiveOwnerTarget } from "../core/owner";
import { isProviderExhaustion } from "../runtimes/claude";
import { logOutbound } from "../session/transcript";
import type { Transport } from "../transport";
import { runAgentPass } from "../scheduling/scheduler";
import { claimNextPending, finishResearch, requeueStale, type ResearchJob } from "./jobs";
import { runDeepResearch, type ResearchResult } from "./pipeline";
import { runDeepResearchWorkflow } from "./workflowRunner";

/**
 * Background research worker. Polls the job queue, runs one deep-research job at a
 * time (each is a heavy parallel fan-out — running several at once would hammer
 * rate limits), writes the full breakdown into the vault as an Obsidian note, then
 * hands the result BACK to the orchestrator (a fresh "fig" pass) to package and
 * text the owner. It does NOT text them the raw output: the headless pipeline has no
 * idea WHY the research was run or what's relevant to the owner right now — only the
 * orchestrator does (it carries the conversation + `intent`). So the research is an
 * INPUT to fig, and fig writes the actual message the owner reads.
 */

const POLL_MS = Number(process.env.RESEARCH_POLL_MS || 10_000);
const RESEARCH_DIR = "Wiki/reports"; // relative to the vault root

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "research";
}

/** Reserve a unique "Wiki/reports/<date>-<slug>.md" path (vault-relative + absolute). */
function reserveNotePath(question: string): { rel: string; abs: string } {
  const dir = path.join(config.brainDir, RESEARCH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const base = `${date}-${slugify(question)}`;
  let name = `${base}.md`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.md`;
  return { rel: `${RESEARCH_DIR}/${name}`, abs: path.join(dir, name) };
}

const execFileAsync = promisify(execFile);

/** The openpage renderer that turns a Wiki/reports/*.md report into its open-page.cc page. */
const RENDER_RESEARCH_SCRIPT =
  process.env.RESEARCH_RENDERER || path.join(os.homedir(), "GitHub", "openpage", "render-research.mjs");

/**
 * Render the finished report into its branded open-page.cc page and return the public
 * URL. The renderer is idempotent and prints "public url open-page.cc/research/<slug>"
 * as its final stdout line — the slug is parsed from there rather than re-derived, so
 * this never drifts from the renderer's own slug logic. Returns undefined on ANY
 * failure (non-zero exit, ~60s timeout, unparseable output) so the caller falls back
 * to the obsidian link — a broken renderer must never eat a finished report.
 */
async function renderResearchPage(absReportPath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [RENDER_RESEARCH_SCRIPT, absReportPath], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const m = stdout.match(/^public url open-page\.cc\/research\/(\S+)\s*$/m);
    if (!m) {
      warn(
        `research render: renderer exited 0 but printed no public-url line — falling back to obsidian link ` +
          `(stdout tail: ${stdout.slice(-200).trim()}${stderr ? ` | stderr: ${stderr.slice(-200).trim()}` : ""})`,
      );
      return undefined;
    }
    return `https://open-page.cc/research/${m[1]}`;
  } catch (e) {
    warn(`research render failed — falling back to obsidian link: ${String(e).slice(0, 300)}`);
    return undefined;
  }
}

/** Deep link that opens the note in the Obsidian app (bare URL → tappable in iMessage). */
function obsidianLink(relPath: string): string {
  const vault = (process.env.OBSIDIAN_VAULT || path.basename(config.brainDir)).trim();
  const file = relPath.replace(/\.md$/, "");
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

function noteFrontmatter(job: ResearchJob): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  return [
    "---",
    `title: "${esc(job.question)}"`,
    "type: research",
    `created: ${new Date().toISOString()}`,
    ...(job.focus ? [`focus: "${esc(job.focus)}"`] : []),
    "tags: [research]",
    "---",
    "",
  ].join("\n");
}

async function deliver(transport: Transport, owner: string, message: string): Promise<void> {
  // Unwrap the <output>…</output> payload the packaging pass emits, so its narration
  // doesn't ride along. The error-path message (no wrapper) falls through unchanged.
  const clean = stripMarkdown(unwrapOutput(message));
  // Backstop: same class of leak as scheduler.ts's deliver() — a wrapped
  // `<output>NOTHING</output>` would unwrap clean to bare NOTHING here with nothing
  // downstream left to catch it.
  if (!clean || isQuietSentinel(clean)) {
    warn(`research deliver: suppressed quiet-sentinel payload (raw: ${message.slice(0, 80)})`);
    return;
  }
  logOutbound(clean);
  const target = proactiveOwnerTarget() || owner;
  await pacedSend(transport, target, clean, {
    onError: (e) => warn(`research send failed: ${e}`),
  });
  // The packaged research message just entered the thread out of band — reset the
  // interactive session so the next interactive turn rebuilds from the transcript and
  // sees it (otherwise the resumed main session has no idea the research was delivered,
  // the exact "still cooking?" confusion this fixes).
  setSession(undefined);
}

/**
 * Build the prompt that hands a finished research job back to the orchestrator (fig)
 * to package for the owner. Fig has the context the headless pipeline never did — why
 * this was run (`intent`) and what's relevant — so it writes the actual text.
 */
function packagingPrompt(opts: { question: string; intent?: string; brief: string; link: string }): string {
  return `Deep research you kicked off just finished. Package it for the owner and text them — you have the context the headless researcher didn't: why you ran this and what's relevant to them right now.

THE QUESTION RESEARCHED: "${opts.question}"
${opts.intent ? `WHY YOU RAN IT / HOW IT'LL BE USED: ${opts.intent}\n` : ""}
THE BRIEF (what the research found — dense; this is for you, not for sending verbatim):
${opts.brief}

The full breakdown is saved in the vault. Link to share so they can drill in: ${opts.link}

Write the text the owner gets. Lead with the takeaway that matters given WHY you ran this — don't just dump the brief, surface the signal relevant to what you two were actually doing and frame it that way. Keep it tight and skimmable, they won't read a wall. Put the link on its own line.

Deliver the message by wrapping the EXACT text the owner should receive in <output></output> tags — ONLY what's inside is sent, so any thinking/narration outside the tags is dropped. Inside: speak straight to them in your normal voice, second person, lowercase, no preamble ("here's the summary").`;
}

/**
 * Which engine runs the pipeline. "workflow" (default) = the saved deep-research
 * workflow script via workflowRunner.ts; anything else = the legacy hand-rolled
 * pipeline.ts. The workflow path falls back to legacy on tool/workflow failures, but
 * provider-exhaustion failures fail closed so a tapped account doesn't launch a
 * second expensive fan-out.
 */
const RESEARCH_ENGINE = (process.env.RESEARCH_ENGINE || "workflow").toLowerCase();

async function runPipeline(job: ResearchJob): Promise<ResearchResult> {
  if (RESEARCH_ENGINE === "workflow") {
    try {
      return await runDeepResearchWorkflow(job.question, job.focus);
    } catch (e) {
      if (isProviderExhaustion(String(e))) {
        throw e;
      }
      warn(`research job ${job.id}: workflow engine failed (${e}); falling back to legacy pipeline`);
    }
  }
  return runDeepResearch(job.question, job.focus);
}

async function runJob(job: ResearchJob, transport: Transport, owner: string): Promise<void> {
  log(`research job ${job.id} started`);
  try {
    const { brief, report } = await runPipeline(job);
    const { rel, abs } = reserveNotePath(job.question);
    fs.writeFileSync(abs, `${noteFrontmatter(job)}# ${job.question}\n\n${report}\n`);
    finishResearch(job.id, { status: "done", notePath: rel });
    log(`research job ${job.id} done → ${rel}`);

    // Hand the result back to fig to package for the owner (the whole point: research
    // is an input to fig, not a thing that texts them directly). The link the owner gets
    // is the rendered open-page.cc page; the raw obsidian link is the fail-safe only.
    const link = (await renderResearchPage(abs)) ?? obsidianLink(rel);
    const packaged = await runAgentPass(
      packagingPrompt({ question: job.question, intent: job.intent, brief, link }),
      `research:${job.id}`,
      OUTPUT_CONTRACT.wrapped,
    );
    // Fall back to a minimal direct message only if the packaging pass came back empty.
    const message = packaged.trim() || `${brief.split("\n").find((l) => l.trim()) ?? "research done"}\n\nfull breakdown: ${link}`;
    await deliver(transport, owner, message);
  } catch (e) {
    warn(`research job ${job.id} failed: ${e}`);
    finishResearch(job.id, { status: "failed", error: String(e) });
    await deliver(transport, owner, `couldn't finish the research on "${job.question}" — ${String(e).slice(0, 120)}`);
  }
}

export function startResearchWorker(transport: Transport, owner: string): void {
  requeueStale(); // a job left "running" by a crash gets another shot.
  void (async function loop() {
    for (;;) {
      try {
        const job = claimNextPending();
        if (job) await runJob(job, transport, owner);
      } catch (e) {
        warn(`research worker tick: ${e}`);
      }
      await sleep(POLL_MS);
    }
  })();
  log("research worker started");
}
