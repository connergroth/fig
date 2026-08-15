import "dotenv/config";

/**
 * Live smoke test for the Pangram detector — one real, billed request through the REAL tool
 * handler (registry definition → client → poll loop → render), not a stub.
 *
 *   npx tsx scripts/dev/pangram-live.ts
 *
 * The unit tests in `src/pangram/detect.test.ts` cover the contract against fixtures; this
 * covers the two things fixtures structurally cannot: that PANGRAM_API_KEY actually
 * authenticates, and that the live response still parses into the shape we render.
 *
 * The sample is DELIBERATELY public: a public-domain Melville paragraph (human, 1851) plus an
 * obviously LLM-styled paragraph written for this file. Nothing private ever goes in here —
 * this endpoint ships its input off the mini, which is the same rule the tool description
 * states to the model. ~120 words ≈ $0.006 per run.
 */

const HUMAN_PUBLIC_DOMAIN =
  "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world. It is a way I have of driving off the spleen and regulating the circulation. Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul, I account it high time to get to sea as soon as I can.";

const SYNTHETIC_LLM_SLOP =
  "In today's rapidly evolving digital landscape, it is important to note that leveraging synergistic frameworks can significantly enhance stakeholder outcomes. By fostering a culture of continuous improvement, organizations are able to unlock transformative value while simultaneously navigating an increasingly complex ecosystem. Ultimately, embracing these best practices empowers teams to deliver robust, scalable solutions that drive meaningful impact across the enterprise.";

async function main(): Promise<void> {
  const { pangramServerDef } = await import("../../src/pangram/tools");
  const key = process.env.PANGRAM_API_KEY?.trim();
  console.log(`PANGRAM_API_KEY: ${key ? `present (…${key.slice(-4)})` : "MISSING"}`);
  if (!key) process.exit(1);

  const models = await fetch("https://text.external-api.pangram.com/models", { headers: { "x-api-key": key } });
  console.log(`GET /models → ${models.status} ${await models.text()}`);

  const detect = pangramServerDef.capabilities.find((c) => c.name === "detect")!;
  const t0 = Date.now();
  const out = await detect.handler({ text: `${HUMAN_PUBLIC_DOMAIN}\n\n${SYNTHETIC_LLM_SLOP}` });
  console.log(`\n${out}\n`);
  console.log(`--- ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
  if (out.startsWith("Pangram check failed:")) process.exit(1);
}

void main();
