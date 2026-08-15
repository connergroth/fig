import fs from "node:fs";
import path from "node:path";

import { config } from "../core/config";

/**
 * Deterministic skill INLINING for unattended runs.
 *
 * The problem this replaces: every scheduled pass was handed an instruction shaped like
 * "Use your X skill to …" and then had to CHOOSE to call the Skill tool to find out what X
 * actually says. That made the procedure a suggestion. Two independent failure paths fall
 * out of it:
 *
 *   1. The model simply doesn't invoke it — nothing errors, the pass improvises something
 *      skill-shaped from the name alone, and the run reads as clean.
 *   2. The skill isn't in the listing to invoke. The skill listing is CHAR-BUDGETED
 *      (budget = contextTokens * 4 * skillListingBudgetFraction), and over budget every
 *      non-bundled skill collapses to a bare `- name` with no description. Worse, an
 *      automation-only skill has no business being in that listing at all, so the vault now
 *      sets `skillOverrides: {<skill>: "off"}` for every `internal: true` skill — which
 *      removes it from the listing AND hard-blocks model invocation ("is disabled for model
 *      invocation in skillOverrides settings").
 *
 * With the override in place, "use your X skill" is not merely unreliable, it is impossible.
 * So the scheduler stops asking and just embeds the procedure: read SKILL.md, strip the
 * frontmatter, paste the body into the prompt. Same bytes the Skill tool would have loaded,
 * with the choice and the listing removed from the path.
 *
 * FAIL LOUD, never fall back. A pass that cannot read its own procedure did not run. The old
 * "use your X skill" phrasing is not a safe degradation — it's the exact thing that produced
 * a successful-looking run with nothing behind it.
 */

/** The vault's skills directory — same one the scheduler scans. */
export const SKILLS_DIR = path.join(config.brainDir, ".claude", "skills");

/** Named error string — greppable in logs, stable for tests. */
export const SKILL_BODY_ERROR = "SKILL_BODY_UNREADABLE";

export class SkillBodyError extends Error {
  constructor(message: string) {
    super(`${SKILL_BODY_ERROR}: ${message}`);
    this.name = "SkillBodyError";
  }
}

/**
 * Everything below the YAML frontmatter. The frontmatter is machine contract
 * (`schedule`, `requiredTools`, `internal`, `runPrompt`) and is already consumed by the
 * scheduler — re-feeding it to the model just adds noise and invites it to re-read its own
 * `runPrompt` as a second, competing instruction.
 */
export function stripFrontmatter(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  return (m ? md.slice(m[0].length) : md).trim();
}

/**
 * The skill's procedure text. Throws (rather than returning "") on a missing/unreadable
 * file or a frontmatter-only file — see the fail-loud note above.
 *
 * `dir` is the skill's DIRECTORY name. It happens to equal the `name:` frontmatter field for
 * every skill today, and a test asserts that, but the caller passes the directory because
 * that's what actually locates the file.
 */
export function readSkillBody(dir: string, skillsDir: string = SKILLS_DIR): string {
  const file = path.join(skillsDir, dir, "SKILL.md");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new SkillBodyError(`cannot read ${file} (${e instanceof Error ? e.message : e})`);
  }
  const body = stripFrontmatter(raw);
  if (!body) throw new SkillBodyError(`${file} has frontmatter but no body — there is no procedure to run`);
  return body;
}

/**
 * The prompt block that carries the procedure.
 *
 * Two jobs beyond pasting the text. It tells the run NOT to go looking for the skill (an
 * automation skill is deliberately absent from the listing, and a pass that burns turns
 * hunting for it or reports "the skill isn't available" is a wasted run). And it names the
 * skill's own directory, because bodies reference their bundled assets RELATIVELY
 * (`references/interests.md`, `scripts/directions.py`) — the Skill tool resolved those from
 * the skill dir, whereas an inlined pass has the vault root as its cwd and would otherwise
 * resolve them to nothing.
 */
export function skillProcedureBlock(dir: string, skillsDir: string = SKILLS_DIR): string {
  const body = readSkillBody(dir, skillsDir);
  const rel = path.posix.join(".claude", "skills", dir);
  return `PROCEDURE — the "${dir}" skill, inlined below.

This is that skill's own SKILL.md, embedded verbatim instead of loaded through the Skill tool. Automation skills are deliberately hidden from your skill list, so there is nothing to invoke and nothing to look for — do NOT call the Skill tool for it, and do not report it as unavailable. Everything it says is right here; follow it as written.

Its own directory is \`${rel}/\` — any relative path it mentions (\`references/…\`, \`scripts/…\`) lives there, not at your cwd.

===== BEGIN ${dir}/SKILL.md =====
${body}
===== END ${dir}/SKILL.md =====`;
}
