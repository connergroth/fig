/**
 * MECHANICAL INVENTORY of fig's entire MCP tool surface.
 *
 * This is a read-only DERIVATION, not a hand-written table, and being THIN is the point: every
 * fact it prints — which tools a server publishes, whether two names are the same capability,
 * read-vs-write, what an exclusion means — is DECLARED on the capability, so this script mostly
 * formats. If it starts growing again, that's the signal that something has stopped being
 * declared and is being reverse-engineered here instead.
 *
 * What it can and cannot see, stated rather than implied:
 *   - In-process servers are read from their registry DEFINITIONS, so tool lists are exact.
 *   - FILE-BASED (stdio/http, from the vault's mcp.json) servers cannot be enumerated without
 *     spawning and connecting to them. Those rows report a null tool count and are never
 *     guessed at. They still carry a declared purpose, exposure and reason.
 *
 * Usage:
 *   tsx scripts/dev/tool-inventory.ts                 # writes ~/scratch/tool-inventory.md
 *   tsx scripts/dev/tool-inventory.ts --json          # machine-readable, to stdout
 *   tsx scripts/dev/tool-inventory.ts --out <path>
 */
import "dotenv/config";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../../src/core/config";
import { loadMcpServers } from "../../src/runtimes/mcp";
import {
  allRegisteredServerKeys,
  buildFigMcpServers,
  buildScheduledMcpServers,
  inLane,
  laneServerDrift,
} from "../../src/scheduling/lane";
import { lintSkill, parseRequiredTools, resolveRequirement } from "../../src/scheduling/requiredTools";
import { isPinned } from "../../src/tools/define";
import { fallbackCapabilities } from "../../src/tools/fallback";
import { ALL_SERVERS, allCapabilities, duplicatePublications } from "../../src/tools/registry";
import { FIG_TOOLS_MCP_NAME } from "../../src/tools/stdio";

const jsonOnly = process.argv.includes("--json");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(os.homedir(), "scratch", "tool-inventory.md");

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
const code = (s: string) => `\`${s}\``;

/* ------------------------------------------------------------------ skills */

interface SkillRow {
  skill: string;
  schedule: string;
  declared: string[];
  resolved: Record<string, string[]>;
  findings: string[];
}

function skillRows(): SkillRow[] {
  const dir = path.join(config.brainDir, ".claude", "skills");
  if (!fs.existsSync(dir)) return [];
  const rows: SkillRow[] = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, d, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    const fm = fs.readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1];
    if (!fm || !/^schedule:/m.test(fm)) continue;
    const declared = parseRequiredTools(fm);
    rows.push({
      skill: d,
      schedule: fm.match(/^schedule:[ \t]*(.+)$/m)?.[1]?.trim() ?? "",
      declared,
      resolved: Object.fromEntries(declared.map((e) => [e, resolveRequirement(e)])),
      findings: lintSkill(d, fm).map((x) => `${x.kind}: ${x.detail}`),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ report */

function build() {
  const live = buildFigMcpServers();
  const scheduled = buildScheduledMcpServers();
  const caps = allCapabilities();
  const fileMcp = loadMcpServers();

  return {
    repo: config.repoRoot,
    servers: ALL_SERVERS.map((s) => ({
      key: s.key,
      kind: s.kind,
      purpose: s.purpose,
      exposure: s.exposure,
      reason: s.reason ?? null,
      alwaysLoad: !!s.alwaysLoad,
      inLive: inLane(s.exposure, "live"),
      inUnattended: inLane(s.exposure, "unattended"),
      present: s.kind === "external" ? Object.hasOwn(fileMcp, s.key) : true,
      tools:
        s.kind === "external"
          ? null
          : s.capabilities.map((c) => ({
              name: c.name,
              full: `mcp__${s.key}__${c.name}`,
              purpose: c.purpose,
              mutates: c.mutates,
              fallback: c.fallback ?? "deny",
              fallbackReason: c.fallbackReason ?? null,
              namingException: c.namingException ?? null,
              alwaysLoad: isPinned(s, c),
            })),
    })),
    counts: {
      servers: ALL_SERVERS.length,
      inProcess: ALL_SERVERS.filter((s) => s.kind !== "external").length,
      external: ALL_SERVERS.filter((s) => s.kind === "external").length,
      live: Object.keys(live).length,
      unattended: Object.keys(scheduled).length,
      capabilities: caps.length,
      read: caps.filter((c) => c.capability.mutates === "read").length,
      write: caps.filter((c) => c.capability.mutates === "write").length,
      fallback: fallbackCapabilities().length,
      duplicates: duplicatePublications().length,
    },
    fallback: fallbackCapabilities().map((c) => ({ name: c.fallbackName, from: c.name })),
    duplicates: duplicatePublications().map((d) => d.names),
    drift: laneServerDrift(live, scheduled, allRegisteredServerKeys()),
    skills: skillRows(),
  };
}

function render(r: ReturnType<typeof build>): string {
  const L: string[] = [];
  L.push("# fig MCP tool inventory");
  L.push("");
  L.push(
    "> Generated by `scripts/dev/tool-inventory.ts` — do not hand-edit. Every field below is read " +
      "off the capability definitions in `src/tools/registry.ts`; nothing here is inferred or " +
      "hand-paired. See `docs/adding-a-tool.md` for what a definition must declare.",
  );
  L.push("");
  L.push(`Repo: ${code(r.repo)}`);
  L.push("");

  L.push("## Counts");
  L.push("");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| servers defined | ${r.counts.servers} |`);
  L.push(`| — in-process | ${r.counts.inProcess} |`);
  L.push(`| — file-mcp (vault mcp.json) | ${r.counts.external} |`);
  L.push(`| servers mounted in LIVE lane | ${r.counts.live} |`);
  L.push(`| servers mounted in UNATTENDED lane | ${r.counts.unattended} |`);
  L.push(`| **capabilities (one definition each)** | **${r.counts.capabilities}** |`);
  L.push(`| — read | ${r.counts.read} |`);
  L.push(`| — write | ${r.counts.write} |`);
  L.push(`| **capabilities published under more than one name** | **${r.counts.duplicates}** |`);
  L.push(`| published to the Codex stdio fallback | ${r.counts.fallback} |`);
  L.push("");
  L.push(
    "Counts cover only enumerable servers. The file-mcp servers publish an unknown number of " +
      "additional names that are NOT in the totals above.",
  );
  L.push("");

  L.push("## Servers");
  L.push("");
  L.push("| server | kind | purpose | live | unattended | tools |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const s of r.servers) {
    // The pin is per TOOL — a server can be partly pinned (scheduled_tasks pins schedule +
    // list, not cancel) — so the marker goes on the tool, and on the server only when every
    // one of its tools carries it.
    const tools = s.tools
      ? s.tools.map((t) => `${code(t.name)}${t.alwaysLoad ? " 📌" : ""}`).join(", ")
      : "_external, not enumerable_";
    const allPinned = !!s.tools?.length && s.tools.every((t) => t.alwaysLoad);
    const missing = s.present ? "" : " ⚠️ not in mcp.json";
    L.push(
      `| ${code(s.key)}${allPinned ? " 📌" : ""} | ${s.kind} | ${md(s.purpose)}${missing} | ${
        s.inLive ? "yes" : "no"
      } | ${s.inUnattended ? "yes" : "no"} | ${tools} |`,
    );
  }
  L.push("");
  L.push(
    "📌 = `alwaysLoad`, i.e. paid for in every turn-1 prompt. Everything else is deferred behind " +
      "ToolSearch. A server is marked only when ALL of its tools are.",
  );
  L.push("");

  const restricted = r.servers.filter((s) => s.exposure !== "both");
  L.push("## Lane exclusions (derived from each server's `exposure`)");
  L.push("");
  L.push(
    "There is no exclusion table. A server declares its own `exposure` next to its own definition " +
      "and both lanes are computed from that, which is why nothing here can go stale against the " +
      "thing it describes.",
  );
  L.push("");
  L.push("| server | exposure | reason |");
  L.push("| --- | --- | --- |");
  for (const s of restricted) L.push(`| ${code(s.key)} | ${s.exposure} | ${md(s.reason ?? "")} |`);
  L.push("");

  L.push("## Duplication");
  L.push("");
  if (r.duplicates.length === 0) {
    L.push(
      "**None.** Checked by HANDLER IDENTITY, not by name — which is what makes a hand-authored " +
        "rename table unnecessary. Most duplicates are one capability under two names " +
        "(`fig_tools.list_reminders` vs `reminders.list`), invisible to any name-based comparison " +
        "and knowable only if a human wrote the pairs down. A handler registered twice is a " +
        "structural property the code can see, under any names.",
    );
  } else {
    L.push("| handler | published as |");
    L.push("| --- | --- |");
    for (const names of r.duplicates) L.push(`| (shared) | ${names.map(code).join(" · ")} |`);
  }
  L.push("");

  L.push("## Read vs write");
  L.push("");
  L.push(
    "`mutates` is DECLARED on each capability, not inferred from its name. It is the primitive a " +
      "read-only grant would be built from. It is also the case server granularity provably " +
      "cannot express: one server can hold nine harmless reads next to a login that fires an " +
      "OTP at the owner's real phone.",
  );
  L.push("");
  L.push("| server | read | write |");
  L.push("| --- | --- | --- |");
  for (const s of r.servers) {
    if (!s.tools) continue;
    const read = s.tools.filter((t) => t.mutates === "read").map((t) => code(t.name));
    const write = s.tools.filter((t) => t.mutates === "write").map((t) => code(t.name));
    L.push(`| ${code(s.key)} | ${read.join(", ") || "—"} | ${write.join(", ") || "—"} |`);
  }
  L.push("");

  L.push("## Codex stdio fallback");
  L.push("");
  L.push(
    `One flat MCP server named ${code(FIG_TOOLS_MCP_NAME)} — the name Codex is already configured ` +
      "with, kept so its config never has to change. It is transport only: names are derived as " +
      "`<server>__<tool>`, JSON Schema is derived from the Zod shape, and `fallback` defaults to " +
      "`deny` so nothing joins this surface by omission.",
  );
  L.push("");
  L.push("| fallback name | capability |");
  L.push("| --- | --- |");
  for (const f of r.fallback) L.push(`| ${code(f.name)} | ${code(f.from)} |`);
  L.push("");

  L.push("## Scheduled skills");
  L.push("");
  L.push(
    "Every skill with a `schedule:` must declare `requiredTools:` — `[]` is legal and means " +
      '"needs nothing, and someone decided that". Entries are server keys; the tool list derives ' +
      "from the registry, so a server gaining a tool never leaves a declaration stale.",
  );
  L.push("");
  L.push("| skill | schedule | requiredTools | resolves to |");
  L.push("| --- | --- | --- | --- |");
  for (const s of r.skills) {
    const resolved = s.declared.flatMap((d) => s.resolved[d] ?? []);
    L.push(
      `| ${code(s.skill)} | ${md(s.schedule)} | ${s.declared.map(code).join(", ") || "_(none — decided)_"} | ${
        resolved.map(code).join(", ") || "—"
      } |`,
    );
  }
  L.push("");
  const bad = r.skills.filter((s) => s.findings.length);
  if (bad.length) {
    L.push("### Lint findings");
    L.push("");
    for (const s of bad) for (const f of s.findings) L.push(`- ${code(s.skill)}: ${f}`);
  } else {
    L.push("Lint clean: every scheduled skill declares, and every declared name resolves.");
  }
  L.push("");

  L.push("## Drift");
  L.push("");
  const d = r.drift;
  const clean = Object.values(d).every((v) => (v as string[]).length === 0);
  L.push(clean ? "`laneServerDrift()` is clean in all four directions, and no mcp.json entry is undeclared." : "```json\n" + JSON.stringify(d, null, 2) + "\n```");
  L.push("");
  return L.join("\n");
}

function main(): void {
  const r = build();
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(r, null, 2));
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render(r));
  console.log(`wrote ${OUT}`);
  console.log(
    `${r.counts.servers} servers · ${r.counts.capabilities} capabilities · ${r.counts.duplicates} duplicate publications · ${r.counts.fallback} on the Codex fallback`,
  );
}

main();
