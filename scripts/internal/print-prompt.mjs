// Prints fig's composed system prompt to stdout, verbatim, from the live builder.
// Used by fig's `prompt` skill so the owner can view the current prompt on demand.
// buildSystemPrompt() returns [staticParts, BOUNDARY, dynamicParts]; we join them
// so what prints is exactly what the live agent loop is handed each turn.
import { buildSystemPrompt } from "../../src/session/agent.js";

process.stdout.write(buildSystemPrompt().join("\n") + "\n");
