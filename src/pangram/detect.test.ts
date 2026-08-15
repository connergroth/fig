import assert from "node:assert/strict";

/**
 * Tests for the Pangram AI-detection tool.
 *
 * What's actually worth locking down here — all four are things a wrong answer would be
 * relayed to the owner as fact, or would quietly ship their text somewhere:
 *
 *   1. The ASYNC contract. Pangram's current API is POST /task → poll GET /task/{id}; the
 *      synchronous endpoint is deprecated. If the poll loop stops looping, or stops honouring
 *      STAGE_FAILED, we either hang a turn or report a zeroed-out failure body as a verdict of
 *      "0% AI, 100% human" — the worst possible silent wrong answer this tool can give.
 *   2. The CAVEATS. This wrapper exists because the number is easy and knowing when the number
 *      is meaningless is not. A 12-word sample must come back marked inconclusive no matter how
 *      confident Pangram's own JSON looks, and the "evidence, not proof" line must be
 *      unremovable from the render.
 *   3. Failure is a VALUE, never a throw — a throw inside a tool handler costs the whole turn,
 *      and every network path here is a live third-party API.
 *   4. Registry wiring, and that the tool never calls out with no key (a keyless request is a
 *      wasted round-trip that returns a 401 we'd have to translate anyway).
 */

let failures = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

/** ~60 words, so the short-sample caveat doesn't fire unless a test wants it to. */
const LONG_TEXT = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

/** The docs' own success example: 0% AI, 60% assisted, 40% human. */
function mixedBody() {
  return {
    stage: "STAGE_SUCCESS",
    text: "AI-assisted passage. Human passage.",
    version: "4.0",
    headline: "AI Assisted",
    prediction: "We believe that this text is a mix of AI-assisted and human-written content.",
    prediction_short: "Mixed",
    fraction_ai: 0.0,
    fraction_ai_assisted: 0.6,
    fraction_human: 0.4,
    num_ai_segments: 0,
    num_ai_assisted_segments: 1,
    num_human_segments: 1,
    windows: [
      {
        text: "AI-assisted passage. ",
        label: "AI-Assisted",
        ai_assistance_score: 0.55,
        confidence: "High",
        start_index: 0,
        end_index: 21,
        word_count: 2,
        token_length: 5,
        is_humanized: true,
        humanizer_score: 0.91,
      },
      {
        text: "Human passage.",
        label: "Human Written",
        ai_assistance_score: 0.02,
        confidence: "Medium",
        start_index: 21,
        end_index: 35,
        word_count: 2,
        token_length: 4,
        is_humanized: false,
        humanizer_score: 0.0,
      },
    ],
  };
}

function humanBody() {
  return {
    stage: "STAGE_SUCCESS",
    text: LONG_TEXT,
    version: "4.0",
    headline: "Human Written",
    prediction: "We believe that this entire text is human-written.",
    prediction_short: "Human",
    fraction_ai: 0.0,
    fraction_ai_assisted: 0.0,
    fraction_human: 1.0,
    num_ai_segments: 0,
    num_ai_assisted_segments: 0,
    num_human_segments: 1,
    windows: [
      {
        text: LONG_TEXT,
        label: "Human Written",
        ai_assistance_score: 0.02,
        confidence: "High",
        word_count: 60,
        is_humanized: false,
        humanizer_score: 0.0,
      },
    ],
  };
}

/** The zeroed-out STAGE_FAILED body from the docs — the one that must never read as "human". */
function failedBody() {
  return {
    stage: "STAGE_FAILED",
    text: "",
    version: "",
    headline: "preprocessing: Input text contains no valid text after preprocessing",
    prediction: "",
    prediction_short: "",
    fraction_ai: 0.0,
    fraction_ai_assisted: 0.0,
    fraction_human: 0.0,
    num_ai_segments: 0,
    num_ai_assisted_segments: 0,
    num_human_segments: 0,
    windows: [],
  };
}

/**
 * A fake Pangram: one POST for the task id, then a scripted sequence of poll bodies (the last
 * repeats). Records every URL so the async contract itself is assertable.
 */
function fakeApi(pollBodies: unknown[], opts: { submitStatus?: number; pollStatus?: number; submitBody?: unknown } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  let polls = 0;
  const impl = (async (url: any, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === "POST") {
      const status = opts.submitStatus ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () => opts.submitBody ?? { task_id: "task-123" },
        text: async () => JSON.stringify(opts.submitBody ?? { task_id: "task-123" }),
      } as unknown as Response;
    }
    const status = opts.pollStatus ?? 200;
    const body = pollBodies[Math.min(polls++, pollBodies.length - 1)];
    return {
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls, pollCount: () => polls };
}

const noSleep = async () => {};

async function main(): Promise<void> {
  process.env.PANGRAM_API_KEY = process.env.PANGRAM_API_KEY || "test-key";
  const {
    detectAiText,
    formatDetection,
    normalizeVerdict,
    countWords,
    buildCaveats,
    EVIDENCE_LINE,
    SHORT_SAMPLE_WORDS,
    PANGRAM_BASE,
  } = await import("./detect");

  console.log("pangram: the async task contract");

  await check("submits to POST /task with text + model, then polls GET /task/{id}", async () => {
    const api = fakeApi([humanBody()]);
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, true);
    assert.equal(api.calls[0].method, "POST");
    assert.equal(api.calls[0].url, `${PANGRAM_BASE}/task`);
    assert.equal(api.calls[0].body.text, LONG_TEXT);
    // Pinned to pangram-4 on purpose — `"default"` measured as 3.3.2 which emits
    // neither the AI-Assisted label nor the humanizer head this module's caveats read.
    assert.equal(api.calls[0].body.model, "pangram-4", "a selector must be sent explicitly, per the docs");
    assert.equal(api.calls[0].body.public_dashboard_link, false, "no public link unless asked");
    assert.equal(api.calls[1].url, `${PANGRAM_BASE}/task/task-123`);
  });

  await check("PANGRAM_MODEL overrides the pin, and an explicit arg beats both", async () => {
    // The escape hatch that makes pinning safe: a new generation is reachable without a deploy.
    const saved = process.env.PANGRAM_MODEL;
    process.env.PANGRAM_MODEL = "pangram-5";
    try {
      const api = fakeApi([humanBody()]);
      await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
      assert.equal(api.calls[0].body.model, "pangram-5");

      const api2 = fakeApi([humanBody()]);
      await detectAiText({ text: LONG_TEXT, model: "pangram-4", fetchImpl: api2.impl, sleepImpl: noSleep });
      assert.equal(api2.calls[0].body.model, "pangram-4", "an explicit model wins over the env");
    } finally {
      if (saved === undefined) delete process.env.PANGRAM_MODEL;
      else process.env.PANGRAM_MODEL = saved;
    }
  });

  await check("keeps polling through non-terminal stages instead of reading one as a result", async () => {
    const api = fakeApi([
      { task_id: "task-123", stage: "STAGE_PREPROCESSING" },
      { task_id: "task-123", stage: "STAGE_INFERENCE" },
      humanBody(),
    ]);
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(api.pollCount(), 3, "must poll to a TERMINAL stage");
    assert.equal(r.read.verdict, "human");
  });

  await check("STAGE_FAILED is a failure, NOT a 0%-AI verdict", async () => {
    // The single most dangerous silent bug available here: the failure body is all zeroes, so
    // a parser that ignores `stage` reports "0% AI" on text that was never analyzed at all.
    const api = fakeApi([failedBody()]);
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no valid text after preprocessing/, "the reason rides in headline on failure");
  });

  await check("a task that never finishes times out instead of hanging the turn", async () => {
    const api = fakeApi([{ stage: "STAGE_PREPROCESSING" }]);
    const r = await detectAiText({
      text: LONG_TEXT,
      fetchImpl: api.impl,
      sleepImpl: noSleep,
      timeoutMs: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /didn't finish/);
  });

  await check("dashboard_link is opt-in and comes back when asked", async () => {
    const body: any = humanBody();
    body.dashboard_link = "https://pangram.com/r/abc";
    const api = fakeApi([body]);
    const r = await detectAiText({ text: LONG_TEXT, dashboardLink: true, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(api.calls[0].body.public_dashboard_link, true);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.read.dashboardLink, "https://pangram.com/r/abc");
  });

  console.log("pangram: parsing + the derived verdict");

  await check("the docs' mixed example parses into an ai-assisted read", async () => {
    const api = fakeApi([mixedBody()]);
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.read.verdict, "ai-assisted");
    assert.equal(r.read.headline, "AI Assisted", "Pangram's own words are preserved, not replaced");
    assert.equal(r.read.predictionShort, "Mixed");
    assert.equal(r.read.fractionAiAssisted, 0.6);
    assert.equal(r.read.version, "4.0");
    assert.deepEqual(r.read.segments, { ai: 0, aiAssisted: 1, human: 1 });
    assert.equal(r.read.windows.length, 2);
    assert.equal(r.read.flagged.length, 1, "only the AI-ish window is flagged");
    assert.equal(r.read.flagged[0].label, "AI-Assisted");
    assert.equal(r.read.flagged[0].confidence, "High");
    assert.equal(r.read.flagged[0].humanized, true);
  });

  await check("flagged passages come back strongest-first", async () => {
    const body: any = mixedBody();
    body.windows = [
      { text: "weak", label: "AI-Generated", ai_assistance_score: 0.4, confidence: "Low" },
      { text: "strong", label: "AI-Generated", ai_assistance_score: 0.95, confidence: "High" },
      { text: "mine", label: "Human Written", ai_assistance_score: 0.01, confidence: "High" },
    ];
    const api = fakeApi([body]);
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.read.flagged.map((w) => w.text), ["strong", "weak"]);
  });

  await check("only genuinely AI-ish labels are flagged, and unknown labels are not", async () => {
    const { isFlagged } = await import("./detect");
    // The three Pangram 4 actually emits.
    assert.equal(isFlagged("AI-Generated"), true);
    assert.equal(isFlagged("AI-Assisted"), true);
    assert.equal(isFlagged("Human Written"), false);
    // 3.x-era labels a PANGRAM_MODEL override could still surface.
    assert.equal(isFlagged("Lightly Assisted"), true);
    assert.equal(isFlagged("Moderately Assisted"), true);
    // A label we don't recognise must not manufacture a finding.
    assert.equal(isFlagged("unknown"), false);
    assert.equal(isFlagged("Maintained"), false, "'ai' as a substring of another word is not a flag");
  });

  await check("the verdict needs a real majority — anything less is 'mixed', not rounded up", () => {
    assert.equal(normalizeVerdict(1.0, 0, 0), "ai");
    assert.equal(normalizeVerdict(0, 0, 1.0), "human");
    assert.equal(normalizeVerdict(0, 0.6, 0.4), "ai-assisted");
    assert.equal(normalizeVerdict(0.45, 0.1, 0.45), "mixed", "a coin flip is not a verdict");
    assert.equal(normalizeVerdict(0.5, 0.1, 0.4), "mixed", "50% is short of the 60% majority");
    assert.equal(normalizeVerdict(0, 0, 0), "unclear");
    assert.equal(normalizeVerdict(null, null, null), "unclear");
  });

  await check("missing/garbage numeric fields become null, never 0", async () => {
    // `0` and "Pangram didn't say" are different claims; conflating them invents a finding.
    const api = fakeApi([{ stage: "STAGE_SUCCESS", headline: "x", windows: [] }]);
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.read.fractionAi, null);
    assert.equal(r.read.fractionHuman, null);
    assert.equal(r.read.verdict, "unclear");
  });

  console.log("pangram: caveats — the reason this wrapper exists");

  await check("a short sample is marked inconclusive however confident the JSON looks", async () => {
    const body: any = humanBody();
    body.fraction_ai = 1.0;
    body.fraction_human = 0.0;
    body.headline = "AI Detected";
    const api = fakeApi([body]);
    const r = await detectAiText({ text: "just twelve short words here to trip the floor okay fine", fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.read.wordCount < SHORT_SAMPLE_WORDS);
    assert.ok(
      r.read.caveats.some((c) => /INCONCLUSIVE/.test(c)),
      "a sub-50-word sample must be called inconclusive",
    );
    const out = formatDetection(r.read);
    assert.match(out.split("\n")[0], /inconclusive/, "the headline itself has to carry it");
  });

  await check("a long, clean sample carries no invented caveats", async () => {
    const api = fakeApi([humanBody()]);
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.read.caveats, [], "crying wolf on a clean read is its own failure");
  });

  await check("all-low-confidence flags are called a weak signal", () => {
    const caveats = buildCaveats({
      verdict: "ai",
      headline: null,
      prediction: null,
      predictionShort: null,
      version: null,
      model: "default",
      fractionAi: 1,
      fractionAiAssisted: 0,
      fractionHuman: 0,
      segments: { ai: 1, aiAssisted: 0, human: 0 },
      windows: [],
      flagged: [{ text: "x", label: "AI-Generated", score: 0.9, confidence: "Low", wordCount: 10, humanized: false }],
      dashboardLink: null,
      wordCount: 500,
    });
    assert.ok(caveats.some((c) => /LOW confidence/.test(c)));
  });

  await check("a humanizer hit is surfaced, since it changes how the result reads", () => {
    const caveats = buildCaveats({
      verdict: "ai",
      headline: null,
      prediction: null,
      predictionShort: null,
      version: null,
      model: "default",
      fractionAi: 1,
      fractionAiAssisted: 0,
      fractionHuman: 0,
      segments: { ai: 1, aiAssisted: 0, human: 0 },
      windows: [],
      flagged: [{ text: "x", label: "AI-Generated", score: 0.9, confidence: "High", wordCount: 10, humanized: true }],
      dashboardLink: null,
      wordCount: 500,
    });
    assert.ok(caveats.some((c) => /humanizer/i.test(c)));
  });

  await check("the render always carries 'evidence, not proof' and the leaves-the-mini note", async () => {
    for (const body of [humanBody(), mixedBody()]) {
      const api = fakeApi([body]);
      const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      const out = formatDetection(r.read);
      assert.ok(out.includes(EVIDENCE_LINE), "the caveat line is not optional on any result");
      assert.match(out, /evidence, not proof/);
      assert.match(out, /left the mini/);
      const json = JSON.parse(out.split("\n").find((l) => l.startsWith("json: "))!.slice(6));
      assert.equal(typeof json.verdict, "string");
      assert.equal(typeof json.inconclusive, "boolean");
    }
  });

  await check("countWords ignores whitespace runs", () => {
    assert.equal(countWords("  one   two\nthree\t four "), 4);
    assert.equal(countWords("   "), 0);
  });

  console.log("pangram: failure is a value, not a throw");

  await check("a thrown fetch on submit is caught", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: impl, sleepImpl: noSleep });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /ENOTFOUND/);
  });

  await check("a thrown fetch mid-poll is caught", async () => {
    let n = 0;
    const impl = (async (_u: any, init?: any) => {
      if ((init?.method ?? "GET") === "POST") {
        return { ok: true, status: 200, json: async () => ({ task_id: "t" }), text: async () => "" } as unknown as Response;
      }
      n += 1;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: impl, sleepImpl: noSleep });
    assert.equal(r.ok, false);
    assert.equal(n, 1);
    if (!r.ok) assert.match(r.error, /socket hang up/);
  });

  await check("HTTP statuses are translated into the actual reason", async () => {
    const cases: [number, RegExp][] = [
      [401, /missing or invalid/],
      [403, /isn't enabled/],
      [422, /rejected the input/],
      [429, /rate limited/],
      [503, /temporarily unavailable/],
    ];
    for (const [status, re] of cases) {
      const api = fakeApi([humanBody()], { submitStatus: status });
      const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
      assert.equal(r.ok, false, `${status} must fail`);
      if (!r.ok) assert.match(r.error, re);
    }
  });

  await check("a submit with no task_id fails instead of polling nothing", async () => {
    const api = fakeApi([humanBody()], { submitBody: {} });
    const r = await detectAiText({ text: LONG_TEXT, fetchImpl: api.impl, sleepImpl: noSleep });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no task_id/);
  });

  await check("empty text is refused before any request", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await detectAiText({ text: "   ", fetchImpl: impl, sleepImpl: noSleep });
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });

  await check("a missing key fails without spending a request", async () => {
    const saved = process.env.PANGRAM_API_KEY;
    process.env.PANGRAM_API_KEY = "";
    try {
      let called = false;
      const impl = (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      const r = await detectAiText({ text: LONG_TEXT, fetchImpl: impl, sleepImpl: noSleep });
      assert.equal(r.ok, false);
      assert.equal(called, false, "no point spending a round-trip on a guaranteed 401");
      if (!r.ok) assert.match(r.error, /PANGRAM_API_KEY/);
    } finally {
      process.env.PANGRAM_API_KEY = saved;
    }
  });

  console.log("pangram: the tool handler");

  async function callTool(args: Record<string, unknown>, pollBodies: unknown[]): Promise<string> {
    const { pangramServerDef } = await import("./tools");
    const detect = pangramServerDef.capabilities.find((c) => c.name === "detect")!;
    const saved = globalThis.fetch;
    globalThis.fetch = fakeApi(pollBodies).impl;
    try {
      return await detect.handler(args);
    } finally {
      globalThis.fetch = saved;
    }
  }

  await check("the handler returns the formatted read", async () => {
    const out = await callTool({ text: LONG_TEXT }, [mixedBody()]);
    assert.match(out.split("\n")[0], /^AI-ASSISTED/);
    assert.match(out, /flagged passages \(1\)/);
    assert.ok(out.includes(EVIDENCE_LINE));
  });

  await check("a failed check is relayed as a failure, never as a verdict", async () => {
    const out = await callTool({ text: LONG_TEXT }, [failedBody()]);
    assert.match(out, /^Pangram check failed:/);
    assert.ok(!/HUMAN|AI-GENERATED/.test(out), "a failure must not carry an authorship claim");
  });

  await check("blank text is refused by the handler", async () => {
    const { pangramServerDef } = await import("./tools");
    const detect = pangramServerDef.capabilities.find((c) => c.name === "detect")!;
    assert.match(await detect.handler({ text: "   " }), /needs some text/);
  });

  console.log("pangram: the description carries the rules the model has to follow");

  await check("evidence-not-proof and the privacy rule are in the model-facing description", async () => {
    // These live in the description because that's the only copy the model reads before it
    // decides what to paste in. A rule that exists only in a comment governs nothing.
    const { pangramServerDef } = await import("./tools");
    const d = pangramServerDef.capabilities.find((c) => c.name === "detect")!.description;
    assert.match(d, /EVIDENCE, NEVER AS PROOF/);
    assert.match(d, /LEAVES the mini/);
    assert.match(d, /PRIVACY/);
  });

  console.log("pangram: registry wiring");

  await check("published as mcp__pangram__detect, read-only, in both lanes, off the fallback", async () => {
    const { allCapabilities } = await import("../tools/registry");
    const { inLane } = await import("../scheduling/lane");
    const mine = allCapabilities().filter((c) => c.server.key === "pangram");
    assert.deepEqual(mine.map((c) => c.name), ["mcp__pangram__detect"]);
    assert.equal(mine[0].capability.mutates, "read");
    assert.equal(mine[0].capability.fallback, undefined, "new tools must not join the Codex stdio surface");
    assert.equal(inLane(mine[0].server.exposure, "live"), true);
    assert.equal(inLane(mine[0].server.exposure, "unattended"), true);
  });

  await check("the always-loaded prompt keeps the detector discoverable after context rollover", async () => {
    const { buildStaticSystemPrompt } = await import("../session/agent");
    const prompt = buildStaticSystemPrompt();
    assert.match(prompt, /mcp__pangram__detect/);
    assert.match(prompt, /evidence, never proof/);
    assert.match(prompt, /private apple\/work text/i);
  });

  console.log(`\n${ran - failures}/${ran} pangram checks passed`);
  if (failures) process.exit(1);
}

void main();
