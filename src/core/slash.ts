import fs from "fs";
import path from "path";

import { config } from "./config";

/**
 * Explicit slash-command invocation. The owner types `/goal ...` and it unambiguously
 * forces the goal skill instead of relying on trigger-phrase pattern-matching. This is
 * NOT Claude-Code-style mechanical arg parsing — it just removes the "which skill did they
 * mean" guess. The command set derives from the skills directory itself (every visible
 * skill gets a slash for free), so adding a skill later auto-gives it a command. Skills
 * with `internal: true` in their frontmatter (poller/scheduler-only ones the owner never
 * types) are hidden. A small alias map shortens the awkward names.
 *
 * A few commands never reach here at all: `/spot`·`/fig`·`/switch` (spot/lane.ts),
 * `/model` (core/model.ts), `/voice` with no args or a mode word (core/voiceMode.ts),
 * `/usage` (usage/slash.ts) and
 * `/prompt` are intercepted in Conversation.enqueue() and answered in code, because they
 * change state rather than asking fig to do something — spending an agent turn on them
 * would defeat the point. `/voice` is the only overlap: bare `/voice` (and on/off/toggle/
 * status) toggles the persistent audio-reply MODE, while `/voice <anything else>` —
 * "/voice draft an email to sarah" — falls through to here and invokes the writing-voice
 * SKILL as it always did. `/draft` remains that skill's alias for the unambiguous case.
 */

const SKILLS_DIR = path.join(config.brainDir, ".claude", "skills");

/** Short aliases → canonical skill name. Keep small and obvious. */
const ALIASES: Record<string, string> = {
  idea: "ideate",
  draft: "voice", // there is no email-draft skill; voice owns outgoing email

  manim: "manim-compose",
};

/** Scan skills for their `name` + `internal:` flag; build the visible command set. */
function scanCommands(): Set<string> {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(SKILLS_DIR);
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const d of dirs) {
    let txt: string;
    try {
      txt = fs.readFileSync(path.join(SKILLS_DIR, d, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    if (!name) continue;
    const internal = /^internal:\s*true\s*$/m.test(fm[1]);
    if (internal) continue;
    out.add(name.toLowerCase());
  }
  return out;
}

/** Tiny Levenshtein for "did you mean" suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function closest(token: string, commands: Set<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of [...commands, ...Object.keys(ALIASES)]) {
    const d = editDistance(token, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  // Only suggest if it's actually close (a typo, not a random word).
  return best && bestD <= Math.max(2, Math.floor(token.length / 3)) ? best : undefined;
}

/**
 * If `userText` begins with a `/command`, return a directive to APPEND to the prompt
 * that forces the right behavior — either invoke the named skill, or (on a miss) tell
 * The owner there's no such command. Returns null when the text isn't a slash command, so
 * the normal turn runs untouched.
 */
export function resolveSlash(userText: string): string | null {
  const trimmed = userText.trimStart();
  const m = trimmed.match(/^\/([a-z0-9][a-z0-9-]*)\b[ \t]*([\s\S]*)$/i);
  if (!m) return null; // no leading /token (a bare "/" or "/ foo" isn't a command)
  const token = m[1].toLowerCase();
  const rest = m[2].trim();

  const commands = scanCommands();
  const skill = commands.has(token) ? token : ALIASES[token];

  if (skill && commands.has(skill)) {
    const input = rest
      ? `Everything after the command is their input for it: "${rest}".`
      : `They gave no extra text — invoke the skill and let it drive (ask them for anything it needs).`;
    return (
      `\n\n[the owner explicitly invoked the /${token} command. This is an unambiguous directive: ` +
      `use the "${skill}" skill — invoke it now via the Skill tool. Do NOT pattern-match or ` +
      `second-guess which skill they want; they named it. ${input}]`
    );
  }

  // Looks like a command but matches nothing visible — don't guess, don't run anything.
  const suggestion = closest(token, commands);
  const hint = suggestion ? ` Did you mean /${suggestion}?` : "";
  return (
    `\n\n[the owner typed "/${token}" but there's no skill by that name. Do NOT guess a skill or ` +
    `run anything. In your voice, short, tell them there's no /${token} command.${hint}]`
  );
}
