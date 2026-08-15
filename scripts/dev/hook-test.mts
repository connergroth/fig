import { query } from "@anthropic-ai/claude-agent-sdk";
import { SURFACE_HOOKS } from "../../src/runtimes/hooks";

const tool = process.argv[2] === "fetch" ? "WebFetch" : "WebSearch";
const ask =
  tool === "WebFetch"
    ? "Use WebFetch once on https://example.com with prompt 'what is the title?'."
    : "Use the WebSearch tool once for 'apple park trees arborist'.";

const q = query({
  prompt: `${ask} Then reply with the exact text of any SURFACE NOTE you received after the tool result, or NONE if you got none.`,
  options: {
    model: "claude-haiku-4-5-20251001",
    permissionMode: "bypassPermissions",
    allowedTools: [tool],
    systemPrompt: "You are a test harness. Do exactly what is asked, minimal output.",
    hooks: SURFACE_HOOKS,
  },
});

for await (const m of q) {
  if ((m as any).type === "result") console.log("RESULT:", (m as any).result);
}
