import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeCanUseTool } from "./permissions";
import type { ApprovalPrompt } from "../specialists/approval";
import { spotLane } from "../spot/lane";
import { resetOrderCartReader, setOrderCartReader, type OrderPreview } from "../webExport/orderGate";

/** A typical pickup cart, in `order describe --json`'s shape. Stands in for the read. */
const FAKE_CART: OrderPreview = {
  cart_id: "abc123",
  fulfillment: "PICKUP",
  restaurant: { id: "9900123", name: "Chipotle", address: "12 Example Ave, Springfield, IL", logo: null },
  when: { local: "12:22pm", asap: true, estimate_minutes: { minimum: 10, maximum: 20 } },
  items: [{ name: "Burrito Bowl", quantity: 1, total: 17.3, options: ["Chicken", "White Rice"] }],
  charges: { subtotal: 17.3, fees: 0, tax: 1.34, tip: 0, total: 18.64 },
  card: { brand: "AMEX", last4: "1234" },
  validation_errors: [],
};

async function runBrowserTool(
  input: Record<string, unknown>,
  askOwner: (question: string) => Promise<boolean>,
  toolName = "mcp__browser__browser_click",
) {
  const canUseTool = makeCanUseTool(askOwner);
  return canUseTool(toolName, input, {} as any);
}

/** Run an action and report whether it prompted, plus the question text. */
async function asked(
  input: Record<string, unknown>,
  toolName = "mcp__browser__browser_click",
): Promise<{ asks: number; question: string }> {
  let asks = 0;
  let question = "";
  await runBrowserTool(
    input,
    async (q) => {
      asks++;
      question = q;
      return true;
    },
    toolName,
  );
  return { asks, question };
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

async function main(): Promise<void> {
  // --- the stop list: one-way doors always ask ------------------------------

  await check("the order button asks", async () => {
    for (const element of [
      'button "Place your order"',
      'button "Confirm and pay"',
      'button "Complete purchase"',
      'button "Pay now"',
      'button "Subscribe"',
    ]) {
      const { asks } = await asked({ element, ref: "e1" });
      assert.equal(asks, 1, `expected a prompt for ${element}`);
    }
  });

  await check("buy now is free — it opens the review page, it doesn't buy", async () => {
    for (const element of [
      'button "Buy Now"',
      'button "Buy now"',
      'button "Buy it now"',
      'button "Buy Now button in buybox"',
    ]) {
      const { asks } = await asked({ element, ref: "e1a" });
      assert.equal(asks, 0, `expected no prompt for ${element}`);
    }
  });

  await check("one-click ordering still asks — no review page behind it", async () => {
    for (const element of [
      'button "Buy now with 1-Click"',
      'button "Buy now with 1 Click"',
      'button "Order with one-click"',
    ]) {
      const { asks } = await asked({ element, ref: "e1b" });
      assert.equal(asks, 1, `expected a prompt for ${element}`);
    }
  });

  await check("the review page's real button still asks after buy now", async () => {
    const { asks } = await asked({ element: 'button "Place your order"', ref: "e1c" });
    assert.equal(asks, 1);
  });

  await check("a dropdown can't speak outward — select_option skips that door", async () => {
    for (const input of [
      { element: 'combobox "Are you a post-offer candidate?"', values: ["Post-offer"] },
      { element: 'combobox "Country"', values: ["Postal Republic"] },
      { element: 'combobox "How did you hear about us?"', values: ["Tweet"] },
    ]) {
      const { asks } = await asked({ ...input, ref: "e1d" }, "mcp__browser__browser_select_option");
      assert.equal(asks, 0, `expected no prompt for ${input.element}`);
    }
  });

  await check("select_option is NOT narrowed for money or destruction", async () => {
    for (const input of [
      { element: 'combobox "Action"', values: ["Delete account"] },
      { element: 'combobox "Confirm"', values: ["Place your order"] },
    ]) {
      const { asks } = await asked({ ...input, ref: "e1e" }, "mcp__browser__browser_select_option");
      assert.equal(asks, 1, `expected a prompt for ${JSON.stringify(input.values)}`);
    }
  });

  await check("clicking a button labelled 'Post' still asks — narrowing is per-control", async () => {
    const { asks } = await asked({ element: 'button "Post"', ref: "e1f" });
    assert.equal(asks, 1);
  });

  await check("destructive actions ask", async () => {
    for (const element of [
      'button "Delete account"',
      'button "Deactivate"',
      'button "Close account"',
      'button "Transfer funds"',
      'button "Cancel subscription"',
    ]) {
      const { asks } = await asked({ element, ref: "e2" });
      assert.equal(asks, 1, `expected a prompt for ${element}`);
    }
  });

  await check("the prompt shows the raw button text, not a paraphrase", async () => {
    const { question } = await asked({ element: 'button "Place your order"', ref: "e3" });
    assert.equal(question, 'Confirm browser action: "button "Place your order""?');
  });

  // --- the regression: a single small order costing seven 👍 -------------

  await check("pre-commit checkout steps do NOT ask", async () => {
    for (const element of [
      'checkbox "Whitening Strips" in checkout', // unticking an item used to ask, three times over
      'link "Proceed to checkout"',
      'button "Change delivery address"',
      'button "Use a different payment method"',
      'radio "Standard shipping"',
      'button "Add to cart"',
      'textbox "Search Amazon"',
    ]) {
      const { asks } = await asked({ element, ref: "e4" });
      assert.equal(asks, 0, `expected NO prompt for ${element}`);
    }
  });

  await check("ordinary browsing anywhere is free, including sites you're signed into", async () => {
    let asks = 0;
    const canUseTool = makeCanUseTool(async () => {
      asks++;
      return false;
    });
    await canUseTool("mcp__browser__browser_navigate", { url: "https://www.chase.com/" }, {} as any);
    const result = await canUseTool(
      "mcp__browser__browser_click",
      { element: 'link "Statements"', ref: "e5" },
      {} as any,
    );
    assert.equal(result.behavior, "allow");
    assert.equal(asks, 0);
  });

  await check("but a one-way action on that same site still asks", async () => {
    let asks = 0;
    const canUseTool = makeCanUseTool(async () => {
      asks++;
      return false;
    });
    await canUseTool("mcp__browser__browser_navigate", { url: "https://www.chase.com/" }, {} as any);
    const result = await canUseTool(
      "mcp__browser__browser_click",
      { element: 'button "Transfer"', ref: "e6" },
      {} as any,
    );
    assert.equal(asks, 1);
    assert.equal(result.behavior, "deny");
  });

  // --- the login-code regression: "Send email" on an OTP page ------------
  // The send/post entry exists because posting as the owner is one-way. Mailing THEM a
  // 6-digit code is not: it costs nothing and reverses itself in ten minutes. Prompting on
  // it fires mid-login, goes unanswered, and blocks the sign-in it was part of.

  await check("auth / OTP / login-code buttons do NOT ask", async () => {
    for (const element of [
      'button "Send email"', // ← the literal button label, verbatim
      '"Send email" button on GrubHub login-code page',
      'button "Send login code"',
      'button "Resend code"',
      'button "Send code to my email"',
      'button "Continue with email"',
      'button "Sign in"',
      'button "Send magic link"',
    ]) {
      const { asks } = await asked({ element, ref: "e9" });
      assert.equal(asks, 0, `expected NO prompt for ${element}`);
    }
  });

  await check("genuine publishing still asks — the narrowing must not become a hole", async () => {
    for (const element of [
      'button "Post"',
      'button "Publish"',
      'button "Tweet"',
      'button "Post comment"',
      'button "Send message"',
      'button "Send DM"',
      'button "Send invite"',
    ]) {
      const { asks } = await asked({ element, ref: "e10" });
      assert.equal(asks, 1, `expected a prompt for ${element}`);
    }
  });

  // --- the job-application regression: "post-" is a prefix, not the verb ------
  // Employment questionnaires are full of hyphenated "post-": post-government employment,
  // post-offer, post-secondary. Each one fired a 🔐 on an inert dropdown, which is how a
  // stop list trains the owner to 👍 without reading.

  await check("hyphenated post- prefixes do NOT ask", async () => {
    for (const element of [
      'combobox "Post-Government Employment Restrictions"',
      'option "Yes" (post-government attestation)',
      'radio "post-offer background check acknowledgement"',
      'select "highest post-secondary degree"',
      'checkbox "post-graduate study"',
    ]) {
      const { asks } = await asked({ element, ref: "e12" });
      assert.equal(asks, 0, `expected NO prompt for ${element}`);
    }
  });

  await check("an auth-looking page can never wave through money or destruction", async () => {
    // The carve-out is scoped to the speaks-outward half only. If it ever leaks into
    // the money/destroy half, a checkout page that says "verify" buys things silently.
    for (const element of [
      'button "Place your order" (verify your purchase)',
      'button "Delete account" — confirm your identity to continue',
      'button "Confirm and pay" after two-factor verification',
    ]) {
      const { asks } = await asked({ element, ref: "e11" });
      assert.equal(asks, 1, `expected a prompt for ${element}`);
    }
  });

  await check("the credential gate is untouched by the narrowing — a password field still asks", async () => {
    for (const input of [
      { element: 'input "Password"', text: "hunter2", ref: "e12" },
      { element: 'input "Verification code"', text: "788140", ref: "e12" },
      { element: 'input "Card number"', text: "4111111111111111", ref: "e12" },
    ]) {
      const { asks } = await asked(input, "mcp__browser__browser_type");
      assert.equal(asks, 1, `expected a prompt for ${input.element}`);
    }
  });

  await check("KNOWN: a CLICK whose label names a credential still asks (credential gate, not the stop list)", async () => {
    // Documenting current behaviour, not endorsing it. CREDENTIAL_FIELD's own docstring
    // says "the agent should never ENTER these" — but it matches the element label, so a
    // click on a link that merely mentions a passcode also prompts even though nothing is
    // typed. Left alone deliberately: it's a different gate from the send/post rule this
    // change narrows, and loosening the credential gate wasn't asked for. If it turns into
    // real 🔐 noise, the fix is to scope CREDENTIAL_FIELD to tools that carry a value.
    const { asks } = await asked({ element: 'button "Email me a one-time passcode"', ref: "e13" });
    assert.equal(asks, 1);
  });

  // --- credentials + reddit carve-out --------------------------------------

  await check("credential field asks", async () => {
    const { asks } = await asked(
      { element: 'input "Verification code"', text: "123456", ref: "e7" },
      "mcp__browser__browser_type",
    );
    assert.equal(asks, 1);
  });

  await check("an outreach reddit comment auto-allows, a reddit DM still asks", async () => {
    for (const [element, expected] of [
      ['button "Comment"', 0],
      ['button "Reply"', 0],
      ['button "Send message"', 1],
      ['button "Delete comment"', 1],
    ] as [string, number][]) {
      let asks = 0;
      const canUseTool = makeCanUseTool(async () => {
        asks++;
        return true;
      });
      await canUseTool("mcp__browser__browser_navigate", { url: "https://www.reddit.com/r/loseit" }, {} as any);
      await canUseTool("mcp__browser__browser_click", { element, ref: "e8" }, {} as any);
      assert.equal(asks, expected, `reddit: ${element}`);
    }
  });

  // --- uploads / SSRF (unchanged) ------------------------------------------

  await check("upload of our own file (safe root) auto-allows without asking", async () => {
    const home = process.env.HOME || "";
    const { asks } = await asked(
      { paths: [`${home}/scratch/spot-carousel/2026-07-10/out/slide-01.png`] },
      "mcp__browser__browser_file_upload",
    );
    assert.equal(asks, 0);
  });

  await check("browser_drop of our own file (safe root) auto-allows", async () => {
    const home = process.env.HOME || "";
    // Personal-lane roots (the spot repo) only exist when the gitignored lane is
    // loaded, so exercise one when present and fall back to a public root when not —
    // this test must hold on a checkout without src/personal/.
    const root = spotLane.safeUploadRoots()[0] ?? `${home}/scratch`;
    const { asks } = await asked(
      { element: "Upload dropzone", file: `${root}/marketing/out/slide-02.png` },
      "mcp__browser__browser_drop",
    );
    assert.equal(asks, 0);
  });

  await check("upload of an external/unknown path still asks", async () => {
    const { asks, question } = await asked(
      { paths: [path.join(os.homedir(), "Documents", "passport.pdf")] },
      "mcp__browser__browser_file_upload",
    );
    assert.equal(asks, 1);
    assert.equal(question, "Let the browser upload a file to this page?");
  });

  await check("upload with a ../ traversal escaping the safe root still asks", async () => {
    const home = process.env.HOME || "";
    const { asks } = await asked(
      { paths: [`${home}/scratch/../.ssh/id_rsa`] },
      "mcp__browser__browser_file_upload",
    );
    assert.equal(asks, 1);
  });

  await check("browser_run_code_unsafe auto-allows without asking", async () => {
    const { asks } = await asked({ code: "return document.title" }, "mcp__browser__browser_run_code_unsafe");
    assert.equal(asks, 0);
  });

  await check("browser_network_request auto-allows a public https target", async () => {
    const { asks } = await asked(
      { url: "https://api.example.com/v1/items", method: "GET" },
      "mcp__browser__browser_network_request",
    );
    assert.equal(asks, 0);
  });

  await check("browser_network_request hard-denies a private/internal target", async () => {
    let asks = 0;
    for (const url of ["http://127.0.0.1:8080/admin", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"]) {
      const result = await runBrowserTool(
        { url },
        async () => {
          asks++;
          return true; // even a yes must not rescue it
        },
        "mcp__browser__browser_network_request",
      );
      assert.equal(result.behavior, "deny", `expected deny for ${url}`);
    }
    assert.equal(asks, 0);
  });

  // --- guardrail wiring: these assert the boundary is aimed at REAL paths. It was
  // aimed at nonexistent ones for weeks (config.repoRoot resolved one dir too deep),
  // which reads as protection while protecting nothing. Path bugs, not logic bugs.

  await check("editing the real permissions.ts / config.ts ASKS, never silently allows", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const targets = [
      path.join(repoRoot, "src", "runtimes", "permissions.ts"),
      path.join(repoRoot, "src", "core", "config.ts"),
      path.join(repoRoot, "config", "credential-handles.json"),
    ];
    for (const file_path of targets) {
      assert.ok(fs.existsSync(file_path), `test targets a path that doesn't exist: ${file_path}`);

      // The owner says no -> denied.
      let asks = 0;
      let refused = makeCanUseTool(async () => {
        asks++;
        return false;
      });
      let result = await refused(
        "Edit",
        { file_path, old_string: "OLD_LINE", new_string: "NEW_LINE" },
        {} as any,
      );
      assert.equal(result.behavior, "deny", `expected deny after refusal on ${file_path}`);
      assert.equal(asks, 1, `expected exactly one prompt for ${file_path}`);

      // The owner says yes -> allowed. The edit is their call, not the agent's.
      const approved = makeCanUseTool(async () => true);
      result = await approved(
        "Edit",
        { file_path, old_string: "OLD_LINE", new_string: "NEW_LINE" },
        {} as any,
      );
      assert.equal(result.behavior, "allow", `expected allow after approval on ${file_path}`);
    }
  });

  await check("the guardrail prompt shows the actual diff, not just the filename", async () => {
    const file_path = path.resolve(__dirname, "..", "..", "src", "runtimes", "permissions.ts");
    let question = "";
    const canUseTool = makeCanUseTool(async (q: string) => {
      question = q;
      return false;
    });
    await canUseTool(
      "Edit",
      { file_path, old_string: "SENTINEL_OLD", new_string: "SENTINEL_NEW" },
      {} as any,
    );
    // Approving a change you can't see is a rubber stamp — that's the whole reason
    // this asks instead of denying, so the diff has to actually be in the prompt.
    assert.ok(question.includes("- SENTINEL_OLD"), `prompt missing the removed line: ${question}`);
    assert.ok(question.includes("+ SENTINEL_NEW"), `prompt missing the added line: ${question}`);
    assert.ok(question.includes("permissions.ts"), `prompt missing the filename: ${question}`);
  });

  await check("a bash mutation of a guardrail file is still hard-denied (opaque, can't be shown)", async () => {
    let asks = 0;
    const canUseTool = makeCanUseTool(async () => {
      asks++;
      return true; // an approval must not rescue it
    });
    const result = await canUseTool(
      "Bash",
      { command: "sed -i '' 's/a/b/' src/runtimes/permissions.ts" },
      {} as any,
    );
    assert.equal(result.behavior, "deny");
    assert.equal(asks, 0);
  });

  await check("reading a guardrail file from bash is never a write", async () => {
    const canUseTool = makeCanUseTool(async () => true);
    // Every one of these was denied in real use by a pattern that saw a guardrail filename
    // plus a `>` somewhere on the line. All pure reads.
    const reads = [
      "wc -l src/runtimes/permissions.ts 2>/dev/null",
      "grep -n GUARDRAIL_FILES src/core/config.ts 2>&1",
      "grep -n X src/core/config.ts; awk 'NR>=600' notes.txt",
      "sed -n '600,614p' src/runtimes/permissions.ts",
      "cat src/runtimes/permissions.ts | head -40",
    ];
    for (const command of reads) {
      const ok = await canUseTool("Bash", { command }, {} as any);
      assert.equal(ok.behavior, "allow", `expected allow: ${command}`);
    }

    const writes = [
      "echo x > src/runtimes/permissions.ts",
      "echo x >> src/core/config.ts",
      "cp /tmp/new.ts src/runtimes/permissions.ts",
      "grep -n X readme.md; echo x > src/core/config.ts",
    ];
    for (const command of writes) {
      const denied = await canUseTool("Bash", { command }, {} as any);
      assert.equal(denied.behavior, "deny", `expected deny: ${command}`);
    }
  });

  // --- the ordering-CLI money gate (the "FIFTH bug": the Bash lane was ungated) -------------
  //
  // These run the REAL gate, with only the server read swapped out — no CLI subprocess, no
  // Chrome, no network. What's under test is that money cannot leave without a 👍 and that a
  // read-only verb still costs nothing.

  setOrderCartReader(async () => FAKE_CART);

  await check("`order place` asks before it spends, and allows on a 👍", async () => {
    let asks = 0;
    let question = "";
    let attachedPreview = false;
    const canUseTool = makeCanUseTool(async (q: string, prompt?: ApprovalPrompt) => {
      asks++;
      question = q;
      attachedPreview = typeof prompt?.image === "function";
      return true;
    });
    const res = await canUseTool(
      "Bash",
      { command: "cd ~/GitHub/web-export && node src/cli.mjs order place --source=grubhub --cart=abc123" },
      {} as any,
    );
    assert.equal(asks, 1, "the money door must prompt exactly once");
    assert.equal(res.behavior, "allow");
    // The two facts that have to be on a lock screen.
    assert.ok(question.includes("Chipotle"), question);
    assert.ok(question.includes("$18.64"), question);
    // And the rendered card must be attached as a deferred build, so it can carry the 🔐's id.
    assert.ok(attachedPreview, "the money 🔐 should carry a preview card builder");
  });

  await check("a 👎 on `order place` DENIES — nothing is charged", async () => {
    let asks = 0;
    const canUseTool = makeCanUseTool(async () => {
      asks++;
      return false;
    });
    const res = await canUseTool("Bash", { command: "node src/cli.mjs order place --cart=abc123" }, {} as any);
    assert.equal(asks, 1);
    assert.equal(res.behavior, "deny");
    assert.ok(/NOT placed/i.test((res as { message?: string }).message || ""), JSON.stringify(res));
  });

  await check("a TIMEOUT fails closed — an unanswered 🔐 resolves false and the order dies", async () => {
    // This is exactly what session.ts's approval timer does after APPROVAL_TIMEOUT_MS: resolve
    // the promise with false. The gate must treat that as "don't spend", never as "proceed".
    const canUseTool = makeCanUseTool(async () => false);
    const res = await canUseTool("Bash", { command: "node src/cli.mjs order place --cart=abc123" }, {} as any);
    assert.equal(res.behavior, "deny");
  });

  await check("an UNATTENDED lane can never place an order (no approver → deny)", async () => {
    // scheduler.ts / triage / news all build the gate with `denyApprovals`.
    const canUseTool = makeCanUseTool(async () => false);
    const res = await canUseTool(
      "Bash",
      { command: "npm run order -- place --source=grubhub --cart=abc123" },
      {} as any,
    );
    assert.equal(res.behavior, "deny");
  });

  await check("a gate that THROWS while building the prompt denies instead of falling through", async () => {
    const canUseTool = makeCanUseTool(async () => {
      throw new Error("transport is down");
    });
    const res = await canUseTool("Bash", { command: "node src/cli.mjs order place --cart=abc123" }, {} as any);
    assert.equal(res.behavior, "deny", "a broken approval path must not become an allow");
    assert.ok(/did NOT place/i.test((res as { message?: string }).message || ""), JSON.stringify(res));
  });

  await check("an unreadable cart fails closed before any approval can authorize it", async () => {
    setOrderCartReader(async () => null);
    let question = "";
    const canUseTool = makeCanUseTool(async (q: string) => {
      question = q;
      return true;
    });
    const res = await canUseTool("Bash", { command: "node src/cli.mjs order place --cart=abc123" }, {} as any);
    assert.equal(res.behavior, "deny");
    assert.equal(question, "", "a blind order must not even offer an approvable prompt");
    assert.ok(/did NOT place/i.test((res as { message?: string }).message || ""), JSON.stringify(res));
    setOrderCartReader(async () => FAKE_CART);
  });

  await check("the read-only order verbs are NOT gated — no prompt, straight allow", async () => {
    let asks = 0;
    const canUseTool = makeCanUseTool(async () => {
      asks++;
      return true;
    });
    for (const command of [
      "node src/cli.mjs order cart --source=grubhub --store=9900123 --item=@specs/chipotle-9900123-bowl.json",
      "node src/cli.mjs order describe --source=grubhub --cart=abc123 --json",
      "node src/cli.mjs order menu --source=grubhub --store=9900123 --item=2084073826",
      'grep -rn "order place" ~/GitHub/web-export',
      "cd ~/GitHub/web-export && npm test",
    ]) {
      const res = await canUseTool("Bash", { command }, {} as any);
      assert.equal(res.behavior, "allow", `expected allow: ${command}`);
    }
    assert.equal(asks, 0, "a read-only order verb must never prompt");
  });

  resetOrderCartReader();

  console.log(`\npermissions tests passed: ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
