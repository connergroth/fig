/**
 * The MCP tool-result wrapper. Every `tool()` handler returns its reply as a
 * single text content block; this is that shape in one place instead of the
 * `const text = (s) => ({ content: [{ type: "text", text: s }] })` one-liner
 * that was copy-pasted into ~15 tool modules.
 */
import { stripLoneSurrogates } from "./sanitize";

export const text = (s: string) => ({ content: [{ type: "text" as const, text: stripLoneSurrogates(s) }] });
