import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";
import { currentModel } from "../core/model";
import { fetchServer } from "../fetch/tool";
import { log, warn } from "../core/log";
import { runBrainTextResult } from "../runtimes/brain";
import type { ResearchResult } from "./pipeline";

/**
 * The Workflow-engine research runner — the port of pipeline.ts onto the harness's
 * Workflow tool. The plan→research→verify→synthesize guts now live as a saved,
 * deterministic workflow script (brain/.claude/workflows/fig-deep-research.js ("fig-" prefix: the harness ships a built-in workflow named "deep-research" that shadows same-named local scripts)): schema-
 * validated agent outputs, pipelined verify (no barrier), a completeness-critic gap
 * round, budget-aware fan-out, and journal-backed resume — all for free from the
 * workflow harness instead of hand-rolled query() orchestration.
 *
 * Invocation is necessarily model-mediated (the Workflow tool is harness-side, not a
 * programmatic API), so this spins up ONE thin wrapper query whose only job is: call
 * Workflow({name:"fig-deep-research"}), block on TaskOutput until it finishes, done. The
 * actual DATA contract is disk, not the model: the workflow's synthesis agent writes
 * the report + brief to temp paths we choose, and we read those files back — nothing
 * flows through the wrapper model's mouth, so nothing gets paraphrased or lost.
 *
 * The worker can fall back to the legacy pipeline.ts on tool/workflow failures, but
 * not on provider-exhaustion failures — those must fail closed rather than launching
 * a second expensive research engine after quota is already tapped.
 */

function researchModel(): string {
  return process.env.RESEARCH_MODEL || currentModel();
}
const MAX_SUBQUESTIONS = Number(process.env.RESEARCH_MAX_SUBQUESTIONS || 12);
/** Hard wall-clock cap on the whole workflow run (ms). */
const WORKFLOW_TIMEOUT_MS = Number(process.env.RESEARCH_WORKFLOW_TIMEOUT_MS || 45 * 60_000);

const TMP_DIR = path.join(config.stateDir, "research-tmp");

export async function runDeepResearchWorkflow(question: string, focus?: string): Promise<ResearchResult> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const id = randomUUID().slice(0, 8);
  const reportPath = path.join(TMP_DIR, `${id}-report.md`);
  const briefPath = path.join(TMP_DIR, `${id}-brief.md`);

  const workflowArgs = {
    question,
    ...(focus ? { focus } : {}),
    maxSubs: MAX_SUBQUESTIONS,
    reportPath,
    briefPath,
  };

  // Invoke by scriptPath, not name: the name registry is cached at session start and
  // the harness ships a built-in workflow named "deep-research" that shadows local
  // same-named scripts — an absolute scriptPath is unambiguous on both counts.
  const scriptPath = path.join(config.brainDir, ".claude", "workflows", "fig-deep-research.js");

  const prompt =
    `Run the saved deep-research workflow and wait for it to finish. Exactly this, nothing else:\n\n` +
    `1. Call the Workflow tool with: {"scriptPath": ${JSON.stringify(scriptPath)}, "args": ${JSON.stringify(workflowArgs)}}\n` +
    `   (pass args as a JSON object exactly as given — do not rephrase the question or drop fields).\n` +
    `2. It returns a task id immediately and runs in the background. Wait for it with the TaskOutput tool: ` +
    `{"task_id": "<id>", "block": true, "timeout": 600000}. If it times out while the task is still running, ` +
    `call TaskOutput again with the same args and keep waiting.\n` +
    `3. When the workflow completes successfully, reply with exactly: DONE\n` +
    `   If it fails, reply with: FAILED: <the error, briefly>\n\n` +
    `Do not research anything yourself, do not write any files yourself, and do not summarize the result — ` +
    `the workflow writes its output to disk and the caller reads it from there.`;

  log(`research: workflow engine starting (${id}) for "${question.slice(0, 60)}"`);

  const res = await runBrainTextResult({
    label: "research workflow wrapper",
    prompt,
    lane: "research",
    timeoutMs: WORKFLOW_TIMEOUT_MS,
    options: {
      cwd: config.brainDir, // resolves the named workflow from brain/.claude/workflows/
      model: researchModel(),
      systemPrompt: "You are a headless job runner. You invoke the tool calls you are told to, wait, and report DONE or FAILED.",
      // This list is NOT just the wrapper's toolbox — it's the built-in tool set every
      // workflow SUBAGENT inherits too. Trim it to ["Workflow","TaskOutput"] and the workflow's
      // synthesis agent has no Write tool, so it physically cannot honor the disk handoff: it
      // dumps the finished report into its structured output instead, the file-check gate fails
      // the run, and a whole multi-agent research pass is thrown away. Write + Bash are what the
      // synthesis and
      // file-check stages require; WebSearch/WebFetch are what the researcher/verifier
      // prompts explicitly tell those agents to use for source discovery.
      tools: ["Workflow", "TaskOutput", "Write", "Bash", "WebSearch", "WebFetch"],
      // fetch_url for the workflow's researcher subagents (they reach session MCP via ToolSearch).
      mcpServers: { fetch: fetchServer },
      permissionMode: "bypassPermissions",
      maxTurns: 32, // room for repeated blocking TaskOutput waits on a long run
    },
  });
  const finalText = res.text.trim();

  try {
    const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8").trim() : "";
    const brief = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, "utf8").trim() : "";
    if (report.length < 500) {
      throw new Error(
        `workflow run produced no usable report (wrapper said: ${finalText.slice(0, 200) || "nothing"})`,
      );
    }
    if (!finalText.startsWith("DONE")) {
      // Files landed but the wrapper didn't confirm — trust the disk, note the oddity.
      warn(`research workflow ${id}: report landed but wrapper said "${finalText.slice(0, 120)}"`);
    }
    log(`research: workflow engine done (${id}), report ${report.length} chars`);
    return { brief: brief || report.slice(0, 1500), report };
  } finally {
    for (const p of [reportPath, briefPath]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }
}
