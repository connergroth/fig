/**
 * Capability tiers — the public setup story in data form. A fresh machine isn't
 * "installing fig", it's standing at some tier, and doctor's whole job is to say
 * which one and what the NEXT tier still needs. This module is the pure half:
 * given check results, compute the tier and render the report. The machine
 * probes live in doctor.ts so this part is trivially testable.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  /** One human line of evidence (a version, a path, an age) — never a stack trace. */
  detail?: string;
  /** How to fix it. Shown only when the check fails. */
  hint?: string;
}

export interface TierReport {
  tier: number;
  label: string;
  checks: CheckResult[];
}

export interface Verdict {
  /** Highest fully-passing tier, -1 when even tier 0 is incomplete. */
  tier: number;
  /** The tier right above where you stand, null at the top. */
  next: TierReport | null;
  /** Only the FAILING checks of `next` — the exact to-do list, nothing already done. */
  missing: CheckResult[];
}

export function tierPasses(t: TierReport): boolean {
  return t.checks.every((c) => c.ok);
}

/**
 * Tiers are cumulative: rich iMessage rides the imsg CLI, find-my rides the same
 * injection, so a passing tier 2 on top of a broken tier 1 is a lie — you are at
 * the highest tier with NO broken tier at or below it.
 */
export function evaluate(reports: TierReport[]): Verdict {
  const sorted = [...reports].sort((a, b) => a.tier - b.tier);
  let tier = -1;
  for (const t of sorted) {
    if (!tierPasses(t)) break;
    tier = t.tier;
  }
  const next = sorted.find((t) => t.tier === tier + 1) ?? null;
  return { tier, next, missing: next ? next.checks.filter((c) => !c.ok) : [] };
}

export function formatText(reports: TierReport[], verdict: Verdict): string {
  const lines: string[] = [];
  for (const t of [...reports].sort((a, b) => a.tier - b.tier)) {
    lines.push(`tier ${t.tier} — ${t.label}`);
    for (const c of t.checks) {
      lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      if (!c.ok && c.hint) lines.push(`      → ${c.hint}`);
    }
  }
  lines.push("");
  lines.push(verdict.tier < 0 ? "you are not at tier 0 yet" : `you are at tier ${verdict.tier}`);
  if (verdict.next) {
    const todo = verdict.missing.map((c) => (c.hint ? `${c.name} (${c.hint})` : c.name));
    lines.push(`to reach tier ${verdict.next.tier}: ${todo.join("; ")}`);
  }
  return lines.join("\n");
}

/** Machine shape for --json: the raw reports plus the verdict, nothing rendered. */
export function toJson(reports: TierReport[], verdict: Verdict): string {
  return JSON.stringify(
    {
      tier: verdict.tier,
      toReachNext: verdict.next
        ? { tier: verdict.next.tier, missing: verdict.missing }
        : null,
      tiers: [...reports].sort((a, b) => a.tier - b.tier),
    },
    null,
    2,
  );
}
