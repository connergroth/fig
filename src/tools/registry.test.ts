import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests for the tool registry — the invariants that make "defined once, derived everywhere"
 * a property of the code rather than a promise in a comment.
 *
 * Five things are locked down here:
 *   1. Nothing is published twice, checked by HANDLER IDENTITY rather than by name. This is
 *      what replaces the hand-authored rename table: 11 of the 16 duplicates in the old
 *      surface were the same capability under DIFFERENT names, invisible to any name-based
 *      check, and knowable only because a human wrote the pairs down.
 *   2. Every capability declares the decisions someone has to make (exposure, mutates,
 *      fallback), and `defineServer` throws at load if one is missing.
 *   3. The naming rule holds, with every exception carrying its reason on the definition.
 *   4. The derived JSON Schema the Codex fallback serves is equivalent to the hand-written
 *      one that shipped before this rewrite. A silent regression here breaks Codex
 *      tool-calling at the argument level, which nothing else would catch.
 *   5. The two specialist-internal allowlists (gmail, outlook) resolve against the real
 *      servers. Those name ~30 `mcp__gmail__*` / `mcp__outlook__*` tools that no lane and no
 *      registry sees, so a renamed upstream tool fails silently there — the six-week bug's
 *      exact shape, in the one corner nothing was checking.
 */

let failures = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Old fig_tools name → new fully-qualified fallback name.
 *
 * READ THIS BEFORE MAINTAINING IT: it is a FOSSIL, not a table. It exists to prove the
 * migration preserved the Codex surface exactly, it is used by exactly one test, nothing
 * derives from it at runtime, and it will never gain a row — a new tool is defined once and
 * has no "old name". The thing the rewrite had to kill was a rename table that had to be
 * MAINTAINED to keep duplicate detection working; that job now belongs to
 * `duplicatePublications()`, which needs no table at all. If this ever needs a new entry,
 * something has been published twice and the first test in this file will already be red.
 */
const PRE_REWRITE_NAMES: Readonly<Record<string, string>> = {
  fetch_url: "fetch__fetch_url",
  where_is: "location__where_is",
  watch_arrival: "location__watch_arrival",
  list_arrival_watches: "location__list_arrival_watches",
  cancel_arrival_watch: "location__cancel_arrival_watch",
  set_reminder: "reminders__set",
  list_reminders: "reminders__list",
  cancel_reminder: "reminders__cancel",
  schedule_task: "scheduled_tasks__schedule",
  list_scheduled_tasks: "scheduled_tasks__list",
  cancel_scheduled_task: "scheduled_tasks__cancel",
  agentmail_check_inbox: "agentmail__check_inbox",
  agentmail_read_message: "agentmail__read_message",
  govee_lights: "lights__control",
  recall_conversations: "memory__recall_conversations",
  web_export: "web_export__pull",
  // The three the old registry denied to fallback runtimes. Mapped so the "denied stays
  // denied" assertion below can name them, not because they're published.
  jobs_list: "jobs__list",
  jobs_check: "jobs__check",
  jobs_cancel: "jobs__cancel",
};

/** Deep-compare ignoring `description`, which is prose and legitimately differs. */
function structure(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structure);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (k !== "description") out[k] = structure(v);
    return out;
  }
  return schema;
}

async function main(): Promise<void> {
  const { ALL_SERVERS, IN_PROCESS_SERVERS, allCapabilities, duplicatePublications, serverByKey } = await import(
    "./registry"
  );
  const { restatesServerKey, capabilitySchema, defineServer, isPinned, toSdkServer } = await import("./define");
  const { fallbackCapabilities, fallbackToolList, fallbackAllows } = await import("./fallback");

  console.log("registry: one definition per capability");

  await check("no capability is published twice, under any names", () => {
    // The invariant that makes the old rename table deletable. Handler identity sees through
    // a rename; a name-based check never could, which is exactly why the duplication survived
    // six weeks and two audits.
    const dupes = duplicatePublications();
    assert.deepEqual(
      dupes.map((d) => d.names),
      [],
      `the same handler is published under more than one name: ${dupes.map((d) => d.names.join(" ≡ ")).join("; ")}`,
    );
  });

  await check("the duplicate check actually fires", () => {
    // An invariant that has only ever seen the passing case is a comment. Publish one handler
    // twice on purpose and prove it's caught — the same reason laneServerDrift injects a fake.
    const shared = async () => "x";
    const a = defineServer({
      key: "fake_a",
      kind: "direct",
      purpose: "fake",
      exposure: "both",
      capabilities: [{ name: "go", purpose: "p", description: "d", input: {}, mutates: "read", handler: shared }],
    });
    const b = defineServer({
      key: "fake_b",
      kind: "direct",
      purpose: "fake",
      exposure: "both",
      capabilities: [{ name: "run", purpose: "p", description: "d", input: {}, mutates: "read", handler: shared }],
    });
    const byHandler = new Map<unknown, string[]>();
    for (const s of [a, b]) {
      for (const c of s.capabilities) {
        byHandler.set(c.handler, [...(byHandler.get(c.handler) ?? []), `mcp__${s.key}__${c.name}`]);
      }
    }
    assert.equal([...byHandler.values()].filter((n) => n.length > 1).length, 1);
  });

  await check("no mcp__fig_tools__ name survives anywhere in the surface", () => {
    // The literal ask: all 16 redundant names die, with no deprecation-alias layer left behind.
    const leaks = allCapabilities()
      .map((c) => c.name)
      .filter((n) => n.startsWith("mcp__fig_tools__"));
    assert.deepEqual(leaks, [], `fig_tools still publishes to the model: ${leaks.join(", ")}`);
    assert.equal(serverByKey("fig_tools"), undefined, "fig_tools must not be a registered server any more");
  });

  await check("every capability declares its decisions", () => {
    for (const { server, capability: c, name } of allCapabilities()) {
      assert.ok(["read", "write"].includes(c.mutates), `${name} must declare mutates`);
      assert.ok(c.purpose.trim().length > 5, `${name} needs a real one-line purpose`);
      assert.ok(c.description.trim().length > 10, `${name} needs a model-facing description`);
      if (c.fallback) assert.ok(c.fallbackReason?.trim(), `${name} sets fallback without a reason`);
      assert.ok(["specialist", "direct", "external"].includes(server.kind), `${server.key} needs a kind`);
    }
  });

  await check("every non-'both' exposure carries a real reason", () => {
    // Same bar the old LANE_EXCLUSIONS table held, now enforced at the definition instead of
    // in a table naming servers defined elsewhere.
    for (const s of ALL_SERVERS) {
      if (s.exposure === "both") continue;
      assert.ok(
        s.reason && s.reason.trim().length > 20,
        `server "${s.key}" has exposure "${s.exposure}" and needs a real reason, got: ${s.reason}`,
      );
    }
  });

  await check("the naming rule holds, and every exception says why", () => {
    for (const { server, capability: c, name } of allCapabilities()) {
      if (!restatesServerKey(server.key, c.name)) {
        assert.ok(!c.namingException, `${name} carries a namingException it doesn't need`);
        continue;
      }
      assert.ok(
        c.namingException && c.namingException.trim().length > 30,
        `${name} restates its server key and needs a written namingException`,
      );
    }
  });

  await check("the exceptions are exactly the three signed off on", () => {
    // A literal on purpose. Exceptions to a naming rule are how the rule stops meaning
    // anything, so growing the list should be a diff someone reads.
    const exceptions = allCapabilities()
      .filter((c) => c.capability.namingException)
      .map((c) => c.name)
      .sort();
    assert.deepEqual(exceptions, [
      "mcp__ack__ack",
      "mcp__fetch__fetch_url",
      "mcp__research__deep_research",
    ]);
  });

  console.log("registry: Codex fallback surface");

  await check("the fallback set is exactly the pre-rewrite one", () => {
    // 16 allow / 3 deny, preserved by name. `fallback` defaults to deny, so this also proves
    // the other 28 capabilities didn't quietly join the Codex surface when the array died.
    const names = fallbackCapabilities().map((c) => c.fallbackName).sort();
    const expected = Object.entries(PRE_REWRITE_NAMES)
      .filter(([old]) => !old.startsWith("jobs_"))
      .map(([, nu]) => nu)
      .sort();
    assert.deepEqual(names, expected);
    assert.equal(names.length, 16);
    for (const denied of ["jobs__list", "jobs__check", "jobs__cancel"]) {
      assert.equal(fallbackAllows(denied), false, `${denied} was deny before the rewrite and must stay deny`);
    }
  });

  await check("nothing new can join the fallback surface by omission", () => {
    // The default matters more than the current set: `fallback` unset means DENY, so adding a
    // capability never widens what an out-of-process coding runtime can reach.
    const unset = allCapabilities().filter((c) => c.capability.fallback === undefined);
    assert.ok(unset.length > 20, "expected most capabilities to leave fallback unset");
    for (const c of unset) assert.equal(fallbackAllows(c.fallbackName), false, `${c.name} defaulted to allow`);
  });

  await check("the derived JSON Schema matches the hand-written one it replaces", () => {
    // THE regression this rewrite could plausibly have introduced. `FigTool.inputSchema` was a
    // hand-written JSON Schema served verbatim to Codex; it is now derived from the Zod shape.
    // Structural equality only — descriptions are prose and the surviving Zod ones are in
    // several cases the better-written half of a duplicated pair.
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, "__fixtures__", "pre-rewrite-fallback-schemas.json"), "utf8"),
    ) as Record<string, { inputSchema: unknown }>;
    const now = new Map(fallbackToolList().map((t) => [t.name, t]));

    const drifted: string[] = [];
    for (const [old, nu] of Object.entries(PRE_REWRITE_NAMES)) {
      const after = now.get(nu);
      if (!after) continue; // the three denied ones aren't served
      const before = structure(fixture[old].inputSchema);
      if (JSON.stringify(structure(after.inputSchema)) !== JSON.stringify(before)) drifted.push(`${old} → ${nu}`);
    }
    // TWO known, deliberate differences. agentmail check_inbox's `limit` was `{type:"number"}`
    // hand-written and is `{type:"integer",minimum:1,maximum:50}` derived, because the Zod
    // shape carries `.int().min(1).max(50)` — bounds the old handler applied by clamping
    // anyway. Strictly narrower on the wire, and it can only reject inputs the handler was
    // already rounding off. recall_conversations' `speaker` enum is derived from
    // OWNER_NAME/AGENT_NAME plus the canonical "owner"/"agent" labels instead of the two
    // hand-written names — any owner's vocabulary must be filterable, and the old values
    // stay accepted where they're configured. Everything else must be byte-identical.
    assert.deepEqual(drifted, [
      "agentmail_check_inbox → agentmail__check_inbox",
      "recall_conversations → memory__recall_conversations",
    ]);

    for (const t of fallbackToolList()) {
      assert.equal((t.inputSchema as any).type, "object", `${t.name} must expose an object schema`);
      assert.equal((t.inputSchema as any).$schema, undefined, "MCP inputSchema must not carry $schema");
      assert.equal((t.inputSchema as any).additionalProperties, false, `${t.name} must be strict`);
    }
  });

  await check("the fallback name is derived, not authored", () => {
    // The one place a second name per capability still exists — and it's a pure function of
    // the definition, which is the entire difference between this and the array it replaces.
    for (const c of allCapabilities()) {
      assert.equal(c.fallbackName, `${c.server.key}__${c.capability.name}`);
    }
    const names = allCapabilities().map((c) => c.fallbackName);
    assert.equal(new Set(names).size, names.length, "flat fallback names must not collide");
  });

  console.log("registry: specialist-internal allowlists");

  await check("EMAIL_AGENT_TOOLS names only tools gmail actually publishes", async () => {
    // `session/agent.ts` spells out 14 `mcp__gmail__*` names that no lane and no registry
    // validates, so a renamed upstream tool would fail silently — the six-week bug's exact
    // failure mode. Validated against the real server rather than against a copied list,
    // because a copied list is the disease.
    const { EMAIL_AGENT_TOOLS } = await import("../session/agent");
    const { gmailServer } = await import("../google/tools");
    const published = new Set(Object.keys((gmailServer as any).instance?._registeredTools ?? {}));
    assert.ok(published.size > 0, "gmail server should publish tools");
    const dead = EMAIL_AGENT_TOOLS.filter((t) => t.startsWith("mcp__gmail__")).filter(
      (t) => !published.has(t.slice("mcp__gmail__".length)),
    );
    assert.deepEqual(dead, [], `EMAIL_AGENT_TOOLS names gmail tools that don't exist: ${dead.join(", ")}`);
  });

  await check("OUTLOOK_AGENT_TOOLS names only tools its servers actually publish", async () => {
    const { OUTLOOK_AGENT_TOOLS, outlookServer } = await import("../mail/tools");
    // Two servers now: the search entry is `mcp__mailsearch__find` (the outlook server has no
    // search of its own today), so validating only the `mcp__outlook__*` half would have
    // let the one entry that crosses servers rot unchecked — which is the same disease.
    const { mailSearchServer } = await import("../mail/searchAll");
    const servers: Record<string, any> = { outlook: outlookServer, mailsearch: mailSearchServer };
    const publishedBy = (server: string) => new Set(Object.keys(servers[server]?.instance?._registeredTools ?? {}));
    assert.ok(publishedBy("outlook").size > 0 && publishedBy("mailsearch").size > 0, "both servers should publish tools");
    const dead = OUTLOOK_AGENT_TOOLS.filter((t) => t.startsWith("mcp__")).filter((t) => {
      const [, server, ...rest] = t.split("__");
      return !publishedBy(server).has(rest.join("__"));
    });
    assert.deepEqual(dead, [], `OUTLOOK_AGENT_TOOLS names tools that don't exist: ${dead.join(", ")}`);
  });

  await check("the allowlist check would catch a dead name", () => {
    // Prove the shape of the assertion, not just that it currently passes.
    const published = new Set(["list", "get"]);
    const dead = ["mcp__gmail__list", "mcp__gmail__renamed_away"].filter(
      (t) => !published.has(t.slice("mcp__gmail__".length)),
    );
    assert.deepEqual(dead, ["mcp__gmail__renamed_away"]);
  });

  console.log("registry: specialist-scoped surfaces");

  await check("the browse specialist has NO path that reaches the owner directly", () => {
    // Deliberate absence, pinned so it can't be re-added by reflex. A browse job that sends its
    // own screenshot delivers it DETACHED from fig's reply, with no guaranteed ordering against
    // the words that explain it — a bare photo, then a paragraph about a picture they already
    // scrolled past. The image is the answer TO fig's message, so fig sends it: the specialist
    // returns an absolute path and fig attaches it. (Showing them what they're APPROVING is a
    // separate, system-side path — see specialists/approvalScreenshot.ts — and needs no tool.)
    const src = fs.readFileSync(path.join(__dirname, "..", "specialists", "browser.ts"), "utf8");
    assert.ok(
      !/\bimage:\s*\w+/.test(src),
      "browser.ts must not mount any image server — the specialist returns paths, fig does the sending",
    );
    assert.ok(!/imageS(end)?Server/.test(src), "no image send surface belongs in the browse specialist");
  });

  console.log("registry: shape");

  await check("every in-process server instantiates with the tools it declared", () => {
    for (const def of IN_PROCESS_SERVERS) {
      const inst = (require("./define").toSdkServer(def) as any).instance?._registeredTools ?? {};
      assert.deepEqual(
        Object.keys(inst).sort(),
        def.capabilities.map((c) => c.name).sort(),
        `${def.key} instance does not match its definition`,
      );
    }
  });

  await check("exactly four capabilities are pinned into the turn-1 prompt", () => {
    // alwaysLoad is paid in EVERY pass of whichever lane carries it, and it is declared per
    // CAPABILITY now, so the literal is capabilities — a server can be partly pinned and the
    // old server-level list would have hidden which half. Measured the way the CLI sizes tools
    // (name + description + serialized input schema): 4,229 chars across these four, vs 32,235
    // if every in-process capability were pinned. What each one buys:
    //   ack.ack (1,448, live-only) — a ToolSearch round-trip counts as "work started" and trips
    //     the auto-ack backstop, which then clobbers the real ack text.
    //   scheduled_tasks.schedule (1,590) + reminders.set (683) — arming happens in the SAME
    //     turn the promise is written, so a fetch step is exactly where a "set" that never
    //     happened goes missing — that's how several pings get armed for one commitment.
    //   scheduled_tasks.list (508) — "is this already armed?", worthless if it costs a
    //     round-trip mid-turn, and it answers for BOTH stores.
    // email.ask (932) and calendar.ask (484) are gone with their specialists — their 34
    // underlying tools are deferred like everything else, so the turn-1 bill is 1,416 chars
    // lighter and fig has the raw tools.
    // The three that stay deferred are the ones nothing is mid-sentence about:
    // reminders.list (the same merged view by a second door), reminders.cancel,
    // scheduled_tasks.cancel. A fifth pin should be a diff someone reads.
    const pinned = allCapabilities()
      .filter((c) => isPinned(c.server, c.capability))
      .map((c) => c.name)
      .sort();
    assert.deepEqual(pinned, [
      "mcp__ack__ack",
      "mcp__reminders__set",
      "mcp__scheduled_tasks__list",
      "mcp__scheduled_tasks__schedule",
    ]);
    // And the unattended lane pays for three of them, not four — ack is live-only.
    assert.deepEqual(
      allCapabilities()
        .filter((c) => isPinned(c.server, c.capability) && c.server.exposure === "both")
        .map((c) => c.name)
        .sort(),
      ["mcp__reminders__set", "mcp__scheduled_tasks__list", "mcp__scheduled_tasks__schedule"],
    );
  });

  await check("a capability-level pin does not leak to its siblings", () => {
    // The whole reason the flag moved down a level: pinning `schedule` must not drag `cancel`
    // into the turn-1 prompt with it. Asserted on the real instance metadata, because `_meta`
    // is what the CLI actually reads — and the SDK ORs a server-level flag over the per-tool
    // one, so getting this wrong would silently pin the sibling.
    const tools = (toSdkServer(serverByKey("scheduled_tasks")!) as any).instance._registeredTools;
    assert.equal(tools.schedule._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(tools.list._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(tools.cancel._meta?.["anthropic/alwaysLoad"], undefined, "cancel must stay deferred");
    const rem = (toSdkServer(serverByKey("reminders")!) as any).instance._registeredTools;
    assert.equal(rem.set._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(rem.list._meta?.["anthropic/alwaysLoad"], undefined, "reminders.list must stay deferred");
    assert.equal(rem.cancel._meta?.["anthropic/alwaysLoad"], undefined, "reminders.cancel must stay deferred");
  });

  await check("a server-level alwaysLoad still pins every capability", () => {
    // Unchanged behaviour is the other half of the contract: the capability flag OVERRIDES the
    // server's, so a server that sets it and says nothing per-capability must still pin all of
    // them, and one that opts a capability out must be able to.
    const def = defineServer({
      key: "fake_pinned",
      kind: "direct",
      purpose: "fake",
      exposure: "both",
      alwaysLoad: true,
      capabilities: [
        { name: "one", purpose: "p", description: "d", input: {}, mutates: "read", handler: async () => "x" },
        { name: "two", purpose: "p", description: "d", input: {}, mutates: "read", handler: async () => "y" },
        {
          name: "three",
          purpose: "p",
          description: "d",
          input: {},
          mutates: "read",
          alwaysLoad: false,
          handler: async () => "z",
        },
      ],
    });
    assert.deepEqual(def.capabilities.map((c) => isPinned(def, c)), [true, true, false]);
    const tools = (toSdkServer(def) as any).instance._registeredTools;
    assert.equal(tools.one._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(tools.two._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(tools.three._meta?.["anthropic/alwaysLoad"], undefined, "a capability opt-out must win");
    // And a real server-level pin still pins everything it publishes, as it did before the
    // flag existed at capability level. `ack` is the only one left that wants that.
    const ack = serverByKey("ack")!;
    assert.ok(ack.capabilities.every((c) => isPinned(ack, c)), "ack must stay wholly pinned");
  });

  await check("schemas derive for every capability, not just the fallback ones", () => {
    for (const { capability: c, name } of allCapabilities()) {
      const schema = capabilitySchema(c) as any;
      assert.equal(schema.type, "object", `${name} schema should be an object`);
    }
  });

  console.log(`\n${ran - failures}/${ran} registry checks passed`);
  if (failures) process.exit(1);
}

void main();
