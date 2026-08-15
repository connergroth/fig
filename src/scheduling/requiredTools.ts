import path from "node:path";

import { config } from "../core/config";
import { readJson, writeJson } from "../core/jsonStore";
import { warn } from "../core/log";
import { isRegisteredToolName, serverByKey } from "../tools/registry";

/**
 * Structural tool dependencies for scheduled skill runs — declaration, instruction, and
 * the FAIL-LOUD guard.
 *
 * Background (the bug this exists for): a nightly sweep can hit the same wall on EVERY run —
 * 6-10 ToolSearch calls, "No matching deferred tools found", a written-out conclusion that
 * "no email/calendar specialists are attached this session", then hand-rolled throwaway
 * scripts against the repo's raw Google/Outlook clients, all reported as a normal run.
 *
 * NOT the deferred-tool registry (measured, see scripts/dev/tool-surface.ts): it would be easy
 * to blame indexing — "in-process SDK MCP server tools are not indexed into it" — and that is
 * FALSE. A real scheduled-lane run shows in-process SDK tools listed by name in
 * the deferred registry and loadable with `ToolSearch select:mcp__jobs__list`. The actual
 * causes were duller and both structural:
 *   (a) the scheduled lane's `mcpServers` map was a hand-maintained SUBSET of the live lane's
 *       — seven servers were simply never passed, so no discovery mechanism could have found
 *       them. Fixed in scheduling/lane.ts, which now OWNS membership for both lanes: the
 *       unattended set is derived as live-minus-an-explicit-exclusion-table, every exclusion
 *       carries a written reason, and a test fails if any registered server is on neither
 *       side. Note the fix is not "give scheduled passes everything" — that was the first
 *       attempt and it handed unattended runs deep_research and coding delegation;
 *       `laneServerDrift()` guards both directions;
 *   (b) nothing ever told a headless pass the fully-qualified names, so it guessed server keys
 *       (`select:email,calendar`) and `select:` is an exact-name lookup — it legitimately
 *       matched nothing.
 *
 * (b) is what this module fixes, and it is the half that generalizes: making the NEXT
 * instance of this class of failure impossible to miss.
 *
 * Two mechanisms, because pre-flight alone provably isn't enough — the SDK's init message
 * listed the mail/calendar tools in `tools` even in the lane where the model could not
 * actually see or call them, so a registration check would have passed happily through all
 * four weeks:
 *
 *  1. INSTRUCTION — a skill declares `requiredTools:` in its SKILL.md frontmatter, and the
 *     scheduler injects the exact tool names into the run prompt plus an explicit ban on
 *     improvising a workaround.
 *  2. BEHAVIORAL GUARD — the runtime records which top-level tools the pass actually
 *     called. A required tool that was never invoked means the run is DEGRADED, and that
 *     surfaces to the owner as a flagged alert instead of a sentence buried in a run log.
 */

/** Where degraded runs are recorded, so a repeat offender is visible as a streak. */
const DEGRADED_FILE = path.join(config.stateDir, "skill-degradations.json");

/** Named error string for the degraded case — greppable in logs, stable for tests. */
export const DEGRADED_ERROR = "SCHEDULED_SKILL_DEGRADED";

export interface DegradationRecord {
  skill: string;
  at: string;
  missing: string[];
  toolsUsed: string[];
  /** Of `missing`, the ones the lane genuinely does not publish. Absent on older records. */
  unreachable?: string[];
  /** Of `missing`, the ones the lane DID publish — the pass simply never called them. */
  uncalled?: string[];
}

/**
 * Pull a scalar SKILL.md frontmatter field, supporting both a single-line value
 * (`runPrompt: do the thing`) and a YAML `|` block scalar spanning several indented lines.
 * Lives here (rather than privately in scheduler.ts) so the frontmatter contract a skill
 * declares — `runPrompt`, `requiredTools` — is parsed and unit-tested in one place.
 */
export function frontmatterField(fm: string, key: string): string | undefined {
  // Block form: `key: |` followed by indented lines until the next top-level key/EOF.
  // Blank lines count as part of the block (they're legal inside a YAML block scalar and are
  // how anyone naturally paragraph-breaks a multi-step runPrompt). Without the all-whitespace
  // alternative the match stopped dead at the first blank line and silently handed a
  // TRUNCATED instruction to the pass — a scheduled skill quietly losing half its prompt.
  const block = fm.match(new RegExp(`^${key}:\\s*\\|\\s*\\n((?:(?:[ \\t]+.*|[ \\t]*)(?:\\n|$))+)`, "m"));
  if (block) {
    return block[1]
      .replace(/^[ \t]+/gm, "") // dedent
      .trim();
  }
  const line = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  return line || undefined;
}

/**
 * Parse a `requiredTools:` frontmatter field. Accepts the shapes people actually write:
 *   requiredTools: [email, calendar]
 *   requiredTools: email, calendar
 *   requiredTools: []
 * plus a YAML block list:
 *   requiredTools:
 *     - email
 *
 * An entry is a SERVER KEY (`email`) or, when the grant genuinely has to be finer, a
 * fully-qualified tool name (`mcp__agentmail__check_inbox`). Server granularity is the default
 * because the tool list then derives from the registry and can't go stale when a server gains
 * a tool — the declaration names a boundary the registry already enforces, rather than
 * restating its contents.
 *
 * `|` ALTERNATION IS GONE. It existed only because one capability had two names
 * (`mcp__fetch__fetch_url|mcp__fig_tools__fetch_url`), so declaring either alone would flag a
 * run that did its job through the other. One capability now has one name, so an entry with a
 * `|` in it is a leftover from the old surface: it fails the shape check here and the lint
 * reports it, rather than being silently normalized into something that no longer means
 * anything.
 *
 * Returns [] for absent/empty/garbage rather than throwing — a malformed declaration must
 * not stop the skill from running at all (it just doesn't get guarded), and `lintSkill()`
 * reports it separately.
 */
export function parseRequiredTools(frontmatter: string): string[] {
  const inline = frontmatter.match(/^requiredTools:[ \t]*(.+)$/m)?.[1]?.trim();
  let raw: string[] = [];
  if (inline) {
    raw = inline.replace(/^\[|\]$/g, "").split(",");
  } else {
    const block = frontmatter.match(/^requiredTools:[ \t]*\n((?:[ \t]*-[ \t]*.+(?:\n|$))+)/m)?.[1];
    if (block) raw = block.split("\n").map((l) => l.replace(/^[ \t]*-[ \t]*/, ""));
  }
  const cleaned = raw
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter((s) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(s));
  return [...new Set(cleaned)];
}

/** Does the frontmatter declare `requiredTools:` at all? `[]` is a decision; absent is not. */
export function declaresRequiredTools(frontmatter: string): boolean {
  return /^requiredTools:/m.test(frontmatter);
}

/**
 * Is the declaration an explicit, deliberate EMPTY (`requiredTools: []`)?
 *
 * A skill that legitimately needs no tools says so this way, and that must be
 * distinguishable from a declaration whose contents failed to parse — otherwise the
 * "guard is OFF" warning fires forever on skills that are perfectly in spec, and a real
 * unparseable declaration hides inside that noise.
 */
export function declaresEmptyRequiredTools(frontmatter: string): boolean {
  const inline = frontmatter.match(/^requiredTools:[ \t]*(.*)$/m)?.[1]?.trim();
  if (inline === undefined) return false;
  if (inline === "[]") return true;
  // Block form with no `- entry` lines under it is the same deliberate "none".
  if (inline === "") {
    return !/^requiredTools:[ \t]*\n(?:[ \t]*-[ \t]*.+)/m.test(frontmatter);
  }
  return false;
}

/**
 * The fully-qualified tool names one requirement entry covers.
 *
 * A server key expands to every tool that server publishes — DERIVED from the registry, so a
 * server gaining a tool never leaves a declaration stale. An `mcp__…` entry is itself, if the
 * registry publishes it. Anything else resolves to nothing, which is what the lint reports.
 */
export function resolveRequirement(entry: string): string[] {
  if (entry.startsWith("mcp__")) return isRegisteredToolName(entry) ? [entry] : [];
  const server = serverByKey(entry);
  if (!server) return [];
  return server.capabilities.map((c) => `mcp__${server.key}__${c.name}`);
}

/**
 * Back-compat shim for the "which names satisfy this entry" question the guard asks.
 * Alternation is gone, so this is now exactly `resolveRequirement`.
 */
export function requirementAlternatives(requirement: string): string[] {
  return resolveRequirement(requirement);
}

export interface SkillLintFinding {
  skill: string;
  /** `missing-declaration` | `unresolvable` | `alternation` | `empty-entry` */
  kind: "missing-declaration" | "unresolvable" | "alternation";
  detail: string;
}

/**
 * The lint: a skill that runs on a SCHEDULE must have decided what tools it needs.
 *
 * The rule this enforces, and why it's mechanical rather than asked-for: `requiredTools` was
 * built as a diagnostic for one broken skill, then added to whatever else was open during that
 * debugging session. Nothing checked that a scheduled skill declared anything, so coverage
 * stopped exactly where somebody's hands stopped — 7 of 16 scheduled skills declared, two of
 * those incompletely. That is the same failure class as the lane maps, one layer up: a rule
 * with no enforcement decays to "whoever remembered".
 *
 * `requiredTools: []` is LEGAL and means "needs nothing, and someone decided that". A blank is
 * not the same as a zero.
 */
export function lintSkill(name: string, frontmatter: string): SkillLintFinding[] {
  const findings: SkillLintFinding[] = [];
  if (!/^schedule:/m.test(frontmatter)) return findings;

  if (!declaresRequiredTools(frontmatter)) {
    findings.push({
      skill: name,
      kind: "missing-declaration",
      detail:
        "runs on a schedule but declares no requiredTools. Add one — `requiredTools: []` is legal and means \"needs nothing\", which is a decision; a missing line is not.",
    });
    return findings;
  }

  const rawLine = frontmatter.match(/^requiredTools:[ \t]*(.*)$/m)?.[1] ?? "";
  if (rawLine.includes("|")) {
    findings.push({
      skill: name,
      kind: "alternation",
      detail: `\`|\` alternation is no longer a thing — one capability has one name now. Replace with the single name: ${rawLine.trim()}`,
    });
  }

  for (const entry of parseRequiredTools(frontmatter)) {
    if (resolveRequirement(entry).length === 0) {
      findings.push({
        skill: name,
        kind: "unresolvable",
        detail: `declares "${entry}", which is neither a registered server key nor a published mcp__server__tool name`,
      });
    }
  }
  return findings;
}

/**
 * The prompt block naming the exact tools this run structurally depends on.
 *
 * Two jobs. First, hand over the FULLY-QUALIFIED names — the failing runs' single most
 * telling move was `ToolSearch select:email,calendar`, i.e. the model guessing at server
 * keys because nothing ever told it the real tool names. Second, and the important one:
 * remove "quietly build a workaround" as an option. A headless pass with no human watching
 * treats improvising as helpfulness; for a skill whose whole value is using the vetted,
 * permission-gated path, an unvetted hand-rolled substitute is a worse outcome than not
 * running at all.
 */
export function requiredToolsPreamble(tools: string[]): string {
  if (tools.length === 0) return "";
  const list = tools
    .map((t) => {
      const names = resolveRequirement(t);
      // A server-granularity entry renders as the server plus the names it covers, because
      // `select:` needs exact tool names and the model has to be told what they are.
      if (t.startsWith("mcp__") || names.length <= 1) return `\`${names[0] ?? t}\``;
      return `\`${t}\` (${names.map((n) => `\`${n}\``).join(", ")})`;
    })
    .join(", ");
  const selectable = [...new Set(tools.flatMap(resolveRequirement))];
  return `REQUIRED TOOLS FOR THIS RUN: ${list}

These are the tools this run structurally depends on. A bare server name is followed by the tools it publishes, and calling any ONE of them satisfies that requirement. You must actually CALL them — a run that reasons its way to an answer without them is a failed run, even if the answer looks right.

Some are already in your turn-1 tool list; the rest are DEFERRED and listed by name in the deferred-tools system-reminder, so their schemas have to be fetched before use. If a name above isn't already callable, fetch them in one call:

  ToolSearch: select:${selectable.join(",")}

\`select:\` is an EXACT-name lookup, not a search. Use the full \`mcp__server__tool\` names above verbatim — guessing at a server key (\`select:email\`) matches nothing and will tell you no such tool exists, which is not the same as the tool being unavailable.

If a required tool is still unreachable after that, you must STOP and report it. Do NOT improvise a substitute: no throwaway scripts, no Bash against the repo's internal clients, no reading raw state files to reconstruct what the tool would have returned. Those workarounds bypass the permission gating and injection handling the real tool provides, and they make a broken run look like a successful one. Say plainly which tool you could not reach and end the run.

`;
}

/**
 * Requirements the pass never satisfied. Matching is exact and case-sensitive; an entry with
 * `|` alternatives is satisfied when ANY of its alternatives was called.
 */
export function missingRequiredTools(required: string[], toolsUsed: string[]): string[] {
  const used = new Set(toolsUsed);
  return required.filter((t) => !requirementAlternatives(t).some((alt) => used.has(alt)));
}

/**
 * Split the unsatisfied requirements by WHY they went unsatisfied.
 *
 * Without it the guard eats real output: `briefing` declares email + calendar, the pass calls
 * neither, and the guard announces it "improvised around them" and suppresses the brief — while
 * both tools were pinned into that pass's turn-1 prompt the whole time. The wiring was fine; the
 * declaration named a tool the skill's own body tells the run not to use.
 *
 * The two cases deserve opposite responses. Unreachable = a wiring bug, the class that runs
 * silently for weeks — that stays loud and still overrides the output. Reachable but
 * uncalled = the skill's instructions and its declaration disagree, or the model judged the
 * call unnecessary; that's worth a log line and a streak counter, not an alarm that eats the
 * run's actual output. A guard that cries wolf gets ignored, which costs more than it saves.
 *
 * A requirement with `|` alternatives counts as reachable when ANY alternative is published.
 */
export function splitMissingByReachability(
  missing: string[],
  provides: (tool: string) => boolean,
): { unreachable: string[]; uncalled: string[] } {
  const unreachable: string[] = [];
  const uncalled: string[] = [];
  for (const req of missing) {
    (requirementAlternatives(req).some(provides) ? uncalled : unreachable).push(req);
  }
  return { unreachable, uncalled };
}

/** Append a degraded run to the on-disk record (best-effort; never throws into the tick). */
export function recordDegradation(rec: DegradationRecord): void {
  try {
    const all = readJson<DegradationRecord[]>(DEGRADED_FILE, []);
    const list = Array.isArray(all) ? all : [];
    list.push(rec);
    writeJson(DEGRADED_FILE, list.slice(-50));
  } catch (e) {
    warn(`could not record skill degradation: ${e}`);
  }
}

/**
 * How many degraded runs this skill has on record (including the one just written). Used
 * only to sharpen the alert's wording — "this is run 4 that's hit it" is the line that
 * would have gotten this looked at weeks ago.
 */
export function degradationCount(skill: string, kind?: "unreachable" | "uncalled"): number {
  const all = readJson<DegradationRecord[]>(DEGRADED_FILE, []);
  if (!Array.isArray(all)) return 0;
  const mine = all.filter((r) => r?.skill === skill);
  if (!kind) return mine.length;
  // Records written before the split carry neither field; they were all raised as wiring
  // failures, so they count as "unreachable" and never inflate the softer counter.
  return mine.filter((r) =>
    kind === "unreachable" ? (r.unreachable?.length ?? r.missing?.length ?? 0) > 0 : (r.uncalled?.length ?? 0) > 0,
  ).length;
}

/**
 * The message the owner actually receives when a scheduled skill ran without a tool it
 * structurally needs. Deliberately overrides the skill's own quiet/NOTHING path — silent
 * fallback is the exact failure mode being fixed, so a degraded run is never quiet.
 */
export function degradedAlert(skill: string, missing: string[], count: number): string {
  // An `a|b` requirement renders as "a or b" — the alert is read by a human on a phone, and
  // a raw pipe reads like a typo rather than "either of these would have counted".
  const names = missing.map((m) => requirementAlternatives(m).join(" or ")).join(", ");
  const nth = count > 1 ? ` that's ${count} runs now.` : "";
  return `⚠️ the ${skill} run couldn't reach ${names} — the tool isn't wired into scheduled runs, so whatever it did went around it. don't trust it as a clean pass.${nth} the lane wiring needs a look.`;
}

/**
 * The softer case: the tool WAS in the lane and the pass just didn't call it. The run's own
 * output still ships — this only appends a line, and only once it's a pattern rather than a
 * one-off judgement call, because a flag on every occurrence is how a guard becomes wallpaper.
 */
export const UNCALLED_STREAK_THRESHOLD = 3;

export function uncalledToolNote(skill: string, uncalled: string[], streak: number): string | null {
  if (streak < UNCALLED_STREAK_THRESHOLD) return null;
  const names = uncalled.map((m) => requirementAlternatives(m).join(" or ")).join(", ");
  return `(heads up: ${skill} has skipped ${names} ${streak} runs in a row now — it's wired and reachable, so either the skill shouldn't be declaring it or its instructions need to say to use it.)`;
}
