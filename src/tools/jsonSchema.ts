import { z, type ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Zod → JSON Schema, the ONE direction this codebase converts.
 *
 * It used to go the other way, and that was the whole problem. `FigTool.inputSchema` was a
 * hand-written JSON Schema object served verbatim to Codex over stdio, while every standalone
 * SDK server declared a Zod shape — so the same capability carried two independently authored
 * schemas, and `claudeAdapter.ts` hand-rolled a JSON-Schema→Zod converter to bridge them. Two
 * authored schemas for one input is the same disease as two names for one tool: they drift, and
 * nothing catches it. A silent drift here is worse than a lane bug, because Codex tool-calling
 * fails at the argument level with no test looking.
 *
 * So Zod is canonical (it's the richer type — it carries refinements the JSON Schema round-trip
 * would have dropped, e.g. `.min(2).max(10)` on send_carousel's paths) and JSON Schema is
 * DERIVED. `registry.schema.test.ts` pins the derived output for every fallback-published tool
 * against the exact JSON Schema that shipped before this rewrite.
 *
 * `$refStrategy: "none"` inlines everything: a `$ref`/`definitions` pair is legal JSON Schema
 * but not every MCP client resolves it, and no fig tool is recursive so there is nothing to
 * gain. `$schema` is stripped because the previous hand-written schemas didn't carry one and
 * MCP `inputSchema` doesn't want it.
 */
/**
 * The library's own signature is generic over the input schema, and resolving it against an
 * open `ZodRawShape` sends tsc into an unbounded instantiation (TS2589). Narrowing it to a
 * plain function type cuts the inference off; the runtime call is identical.
 */
const convert = zodToJsonSchema as unknown as (
  schema: unknown,
  options: Record<string, unknown>,
) => Record<string, unknown>;

export function inputJsonSchema(shape: ZodRawShape): Record<string, unknown> {
  const out = convert(z.object(shape).strict(), {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  delete out.$schema;
  return out;
}
