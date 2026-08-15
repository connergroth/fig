// One-off live verification: run the real extraction pass (opus) over today's
// actual transcript and print the rendered block + the persisted JSON, so we can
// eyeball that opus emits parseable output before flipping the flag on for real.
import fs from "node:fs";
import path from "node:path";

import { config } from "../../src/core/config";
import { buildWorkingState, readWorkingState } from "../../src/session/compaction";

async function main() {
  console.log(`model = ${process.env.WORKING_STATE_MODEL}`);
  console.log(`flag  = ${process.env.SESSION_WORKING_STATE}`);
  const t0 = Date.now();
  const block = await buildWorkingState();
  console.log(`\n--- elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
  console.log("\n===== RENDERED BLOCK =====\n");
  console.log(block ?? "(null — fell back to raw seed)");
  console.log("\n===== PERSISTED .state/working-state.json =====\n");
  const sf = path.join(config.stateDir, "working-state.json");
  console.log(fs.existsSync(sf) ? fs.readFileSync(sf, "utf8") : "(no file written)");
  console.log("\n===== parsed back =====\n", JSON.stringify(readWorkingState(), null, 2));
}

main().catch((e) => {
  console.error("verify failed:", e);
  process.exit(1);
});
