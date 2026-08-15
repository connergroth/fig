import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SendOptions, Transport } from "../transport/types";
import type { ApprovalPrompt } from "./approval";
import {
  approvalVisualFor,
  captureApprovalScreenshot,
  makeCanUseToolWithApprovalShots,
  pickPageTarget,
  type ApprovalVisual,
  type CdpTarget,
} from "./approvalScreenshot";

/**
 * The 🔐-with-a-screenshot path.
 *
 * What's actually being pinned: when a browser/desktop job blocks on an approval, the SYSTEM
 * attaches a picture of what they're approving — deterministically, without asking the model, and
 * without ever letting a failed capture affect the approval itself.
 *
 * Two halves, both covered here:
 *   1. the bridge — which tools get a shot, which don't, and what happens when capture fails
 *   2. the delivery — the bytes genuinely reach the transport attached to the prompt bubble
 */

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

type Ask = { question: string; prompt?: ApprovalPrompt };

/** A canUseTool wired to recording stubs, so a run tells us both what was asked and what was captured. */
function harness(opts: { answer?: boolean; capture?: (k: ApprovalVisual) => Promise<string | null> } = {}) {
  const asks: Ask[] = [];
  const captures: ApprovalVisual[] = [];
  const capture = async (kind: ApprovalVisual): Promise<string | null> => {
    captures.push(kind);
    return opts.capture ? opts.capture(kind) : "/tmp/fake-approval-shot.png";
  };
  const canUseTool = makeCanUseToolWithApprovalShots(async (question, prompt) => {
    asks.push({ question, prompt });
    return opts.answer ?? true;
  }, capture);
  return { asks, captures, canUseTool };
}

/** An upload from an unvetted path — a deterministic 🔐 in decideBrowser with no LLM in the way. */
const UPLOAD = ["mcp__browser__browser_file_upload", { paths: [path.join(os.homedir(), "Downloads", "whatever.pdf")] }] as const;
/** A peekaboo prompt that asks without touching the classifier. */
const PEEKABOO = ["mcp__peekaboo__permissions", { action: "grant screen recording" }] as const;

async function main(): Promise<void> {
  console.log("approval screenshots: scope");

  await check("a browser 🔐 carries a screenshot of the browser", async () => {
    const h = harness();
    const res = await h.canUseTool(UPLOAD[0], { ...UPLOAD[1] }, {} as any);
    assert.equal(res.behavior, "allow");
    assert.deepEqual(h.captures, ["browser"]);
    assert.equal(h.asks.length, 1);
    assert.match(h.asks[0].question, /upload a file/i);
    assert.equal(h.asks[0].prompt?.imagePath, "/tmp/fake-approval-shot.png");
  });

  await check("a peekaboo 🔐 captures the whole desktop, not a browser window", async () => {
    // Desktop automation isn't confined to one window, so the kind has to differ — that's the
    // difference between `screencapture -R <chrome rect>` and a full display grab.
    const h = harness();
    await h.canUseTool(PEEKABOO[0], { ...PEEKABOO[1] }, {} as any);
    assert.deepEqual(h.captures, ["desktop"]);
    assert.equal(h.asks[0].prompt?.imagePath, "/tmp/fake-approval-shot.png");
  });

  await check("an email-send 🔐 gets NO screenshot", async () => {
    // The scope is deliberately narrow. A picture of the desktop tells them nothing about who
    // the mail is going to, and every shot is a small leak of whatever else is on screen.
    const h = harness();
    const res = await h.canUseTool(
      "mcp__gmail__send",
      { to: "dave@example.com", subject: "coffee thursday" },
      {} as any,
    );
    assert.equal(res.behavior, "allow");
    assert.deepEqual(h.captures, []);
    assert.equal(h.asks.length, 1);
    assert.match(h.asks[0].question, /Send email to dave@example\.com/);
    assert.equal(h.asks[0].prompt, undefined);
  });

  await check("scoping reads the TOOL, never the question text", async () => {
    // The question is prose and gets reworded; the tool name is the operation. Scoping on the
    // sentence is the string-vs-operation drift this codebase keeps paying for.
    assert.equal(approvalVisualFor("mcp__browser__browser_click"), "browser");
    assert.equal(approvalVisualFor("mcp__peekaboo__click"), "desktop");
    assert.equal(approvalVisualFor("mcp__browse__use"), null); // the DELEGATION tool, not a browser action
    assert.equal(approvalVisualFor("mcp__gmail__send"), null);
    assert.equal(approvalVisualFor("Bash"), null);
    assert.equal(approvalVisualFor("mcp__calendar__delete_event"), null);
  });

  await check("an allowed browser action captures nothing", async () => {
    // No 🔐, no screenshot. The capture hangs off the approval, not off the tool call, so
    // ordinary browsing never shells out to screencapture.
    const h = harness();
    const res = await h.canUseTool("mcp__browser__browser_navigate", { url: "https://example.com" }, {} as any);
    assert.equal(res.behavior, "allow");
    assert.deepEqual(h.captures, []);
    assert.deepEqual(h.asks, []);
  });

  console.log("approval screenshots: failure never blocks an approval");

  await check("capture returning null still sends the 🔐, as text", async () => {
    const h = harness({ capture: async () => null });
    const res = await h.canUseTool(UPLOAD[0], { ...UPLOAD[1] }, {} as any);
    assert.equal(h.asks.length, 1);
    assert.equal(h.asks[0].prompt, undefined);
    assert.equal(res.behavior, "allow", "a missing screenshot must not change the decision");
  });

  await check("capture THROWING still sends the 🔐, as text", async () => {
    const h = harness({
      capture: async () => {
        throw new Error("no Screen Recording permission");
      },
    });
    const res = await h.canUseTool(UPLOAD[0], { ...UPLOAD[1] }, {} as any);
    assert.equal(h.asks.length, 1);
    assert.equal(h.asks[0].prompt, undefined);
    assert.equal(res.behavior, "allow");
  });

  await check("a denial is still a denial when the shot succeeded", async () => {
    const h = harness({ answer: false });
    const res = await h.canUseTool(UPLOAD[0], { ...UPLOAD[1] }, {} as any);
    assert.equal(res.behavior, "deny");
  });

  await check("the real capture never throws, whatever the machine says", async () => {
    // Run the actual implementation. On a box with Screen Recording granted this returns a
    // path; in CI/sandbox screencapture fails with "could not create image from display" — and
    // the contract is identical either way: a path or null, never an exception.
    const shot = await captureApprovalScreenshot("desktop");
    assert.ok(shot === null || typeof shot === "string");
    if (shot) {
      assert.ok(path.isAbsolute(shot), "a returned shot path must be absolute");
      assert.ok(fs.statSync(shot).size > 0, "an empty file must be reported as no shot at all");
    }
  });

  console.log("approval screenshots: the CDP fallback (screencapture needs a TCC grant we can't give)");

  await check("the fallback photographs the tab they're LOOKING at", async () => {
    // Chrome lists page targets most-recently-used first. Picking the wrong one means showing them
    // a picture of a different page than the one they're approving, which is worse than no picture.
    const targets: CdpTarget[] = [
      { type: "page", url: "https://amazon.com/checkout", webSocketDebuggerUrl: "ws://front" },
      { type: "page", url: "https://reddit.com", webSocketDebuggerUrl: "ws://behind" },
    ];
    assert.equal(pickPageTarget(targets)?.webSocketDebuggerUrl, "ws://front");
  });

  await check("service workers, iframes and devtools are not the page", async () => {
    // /json/list is full of non-page targets — an amazon checkout alone had a service_worker and
    // an ad iframe alongside it. A screenshot request to any of them just hangs until the timeout.
    const targets: CdpTarget[] = [
      { type: "service_worker", url: "https://amazon.com/sw.js", webSocketDebuggerUrl: "ws://sw" },
      { type: "iframe", url: "https://s.amazon-adsystem.com/iu3", webSocketDebuggerUrl: "ws://ad" },
      { type: "page", url: "devtools://devtools/bundled/x.html", webSocketDebuggerUrl: "ws://devtools" },
      { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
      { type: "page", url: "https://amazon.com/checkout", webSocketDebuggerUrl: "ws://real" },
    ];
    assert.equal(pickPageTarget(targets)?.webSocketDebuggerUrl, "ws://real");
  });

  await check("about:blank wins only when it's the only tab", async () => {
    const only: CdpTarget[] = [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" }];
    assert.equal(pickPageTarget(only)?.webSocketDebuggerUrl, "ws://blank");
    assert.equal(pickPageTarget([]), null);
    assert.equal(pickPageTarget([{ type: "page", url: "https://x.com" }]), null, "no socket, no shot");
  });

  await check("given the run's own tab, it selects THAT one — or nothing", async () => {
    // The MRU guess is only defensible when there's nothing better. When the caller knows which
    // tab the 🔐 is about, "most recently used" is how the owner ends up approving a picture of
    // another job's page, so a `want` that isn't there returns null rather than the front tab.
    const targets: CdpTarget[] = [
      { id: "T-front", type: "page", url: "https://oracle.com/careers", webSocketDebuggerUrl: "ws://front" },
      { id: "T-mine", type: "page", url: "https://amazon.com/checkout", webSocketDebuggerUrl: "ws://mine" },
    ];
    assert.equal(pickPageTarget(targets, "T-mine")?.webSocketDebuggerUrl, "ws://mine", "by targetId");
    assert.equal(pickPageTarget(targets, "https://amazon.com/checkout")?.webSocketDebuggerUrl, "ws://mine", "by url");
    assert.equal(pickPageTarget(targets, "https://gone.example/x"), null, "a missing tab is null, never the MRU one");
    assert.equal(pickPageTarget(targets)?.webSocketDebuggerUrl, "ws://front", "no want → the old MRU behaviour");
  });

  console.log("approval screenshots: the bound job tab");

  await check("a browse job's 🔐 photographs ITS tab, not the frontmost window", async () => {
    // The regression: on 2026-08-13 the owner was shown one site while approving an action on
    // another, because `screencapture` grabs whatever Chrome window is in front and two jobs
    // were driving the same Chrome. Playwright talks to the exact Page, so it can't drift.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    let shotOf = "";
    const jobTab = {
      isClosed: () => false,
      url: () => "https://amazon.com/checkout",
      screenshot: async ({ path: p }: { path: string }) => {
        shotOf = "https://amazon.com/checkout";
        fs.writeFileSync(p, png);
      },
    };
    const shot = await captureApprovalScreenshot("browser", jobTab as any);
    assert.ok(shot, "the bound tab must produce a picture");
    assert.equal(shotOf, "https://amazon.com/checkout");
    assert.equal(fs.readFileSync(shot).toString("base64"), png.toString("base64"), "those bytes, not the window's");
  });

  await check("a bound tab that's CLOSED sends the 🔐 as text rather than a stranger's page", async () => {
    // Every OS fallback here photographs the front window. A job that HAD a tab is exactly the
    // case where the front window is probably another job's, so no picture is the honest answer.
    const closed = { isClosed: () => true, url: () => "https://amazon.com/checkout", screenshot: async () => {} };
    assert.equal(await captureApprovalScreenshot("browser", closed as any), null);
  });

  await check("a bound tab still on about:blank sends text, not a white rectangle", async () => {
    // The binding can miss: the run drives a tab this handle never followed, leaving it parked on
    // about:blank. Photographing that "works" — non-zero bytes, logged as a hit — and the owner
    // approves against a blank image that reads as an empty page rather than a mis-aimed camera.
    let shot = false;
    const blank = {
      isClosed: () => false,
      url: () => "about:blank",
      screenshot: async () => {
        shot = true;
      },
    };
    assert.equal(await captureApprovalScreenshot("browser", blank as any), null);
    assert.equal(shot, false, "it must not even take the picture");
  });

  await check("the bound tab is threaded from the wrapper into the capture", async () => {
    const jobTab = { isClosed: () => false, url: () => "https://job.example/apply" };
    const seen: (unknown | null)[] = [];
    const canUseTool = makeCanUseToolWithApprovalShots(
      async () => true,
      async (_kind, page) => {
        seen.push(page);
        return null;
      },
      () => jobTab as any,
    );
    await canUseTool(UPLOAD[0], { ...UPLOAD[1] }, {} as any);
    assert.deepEqual(seen, [jobTab], "the 🔐 is captured against the run's own page");
  });

  await check("a lane with no browse job behind it still captures exactly as before", async () => {
    const seen: (unknown | null)[] = [];
    const canUseTool = makeCanUseToolWithApprovalShots(
      async () => true,
      async (_kind, page) => {
        seen.push(page);
        return null;
      },
    );
    await canUseTool(PEEKABOO[0], { ...PEEKABOO[1] }, {} as any);
    assert.deepEqual(seen, [null], "no bound page → the desktop/window path, unchanged");
  });

  await check("a browser 🔐 gets real pixels on a machine with Chrome up", async () => {
    // The regression this exists for: a live purchase approved with NO picture, because
    // screencapture fails "could not create image from display" on every single 🔐 and failing is
    // silent by design. On a box with no Screen Recording grant, a green result here is the CDP
    // path genuinely carrying the feature.
    const res = await fetch("http://127.0.0.1:9333/json/version", { signal: AbortSignal.timeout(1500) }).catch(
      () => null,
    );
    if (!res?.ok) {
      console.log("    (skipped: no debug Chrome on this machine)");
      return;
    }
    const shot = await captureApprovalScreenshot("browser");
    assert.ok(shot, "with Chrome up, a browser 🔐 must never be blind");
    const bytes = fs.readFileSync(shot);
    assert.ok(bytes.length > 0);
    assert.equal(bytes.subarray(0, 4).toString("hex"), "89504e47", "must be a real PNG, not an error string");
  });

  await check("concurrent tool calls don't cross-wire their screenshots", async () => {
    // The scope is AsyncLocalStorage, not a module-level `let`, precisely so a browser call in
    // flight can't attach its screenshot to a parallel email approval.
    const seen: Ask[] = [];
    const captures: ApprovalVisual[] = [];
    const canUseTool = makeCanUseToolWithApprovalShots(
      async (question, prompt) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push({ question, prompt });
        return true;
      },
      async (kind) => {
        captures.push(kind);
        await new Promise((r) => setTimeout(r, 5));
        return `/tmp/${kind}.png`;
      },
    );
    await Promise.all([
      canUseTool(UPLOAD[0], { ...UPLOAD[1] }, {} as any),
      canUseTool("mcp__gmail__send", { to: "a@b.c", subject: "x" }, {} as any),
      canUseTool(PEEKABOO[0], { ...PEEKABOO[1] }, {} as any),
    ]);
    assert.equal(seen.length, 3);
    const upload = seen.find((s) => /upload a file/i.test(s.question));
    const email = seen.find((s) => /Send email/.test(s.question));
    const desktop = seen.find((s) => /Peekaboo permissions/.test(s.question));
    assert.equal(upload?.prompt?.imagePath, "/tmp/browser.png");
    assert.equal(desktop?.prompt?.imagePath, "/tmp/desktop.png");
    assert.equal(email?.prompt, undefined, "the email 🔐 must not pick up a neighbour's screenshot");
    assert.deepEqual(captures.sort(), ["browser", "desktop"]);
  });

  console.log("approval screenshots: delivery");

  // Everything above proves the PATH is chosen; these prove the BYTES land. Without this the
  // whole feature could be green and still send them a text-only prompt.
  const { Conversation } = await import("../session/session");

  function fakeTransport(sends: { text: string; opts?: SendOptions }[], failAttachment = false): Transport {
    return {
      poll: async () => [],
      send: async (_to, text, opts) => {
        if (failAttachment && opts?.mediaBase64) throw new Error("relay rejected the attachment");
        sends.push({ text, opts });
        return "guid-1";
      },
    };
  }

  await check("the screenshot bytes reach the transport, attached to the 🔐", async () => {
    const shot = path.join(os.tmpdir(), `approval-shot-test-${process.pid}.png`);
    // A real 1x1 PNG — fileAttachmentOpts reads the file off disk and base64s it, so a
    // made-up path would silently degrade to text and this test would pass for the wrong reason.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(shot, png);
    try {
      const sends: { text: string; opts?: SendOptions }[] = [];
      const convo = new Conversation(fakeTransport(sends), "+15555550123");
      const decision = (convo as any).askOwner("Act on chase.com (a site you're signed into)?", {
        imagePath: shot,
      }) as Promise<boolean>;
      // The prompt is sent before the promise parks on their tapback.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sends.length, 1, "image + question go out as ONE send (imsg splits the bubbles itself)");
      // `#xyz ·` is the per-prompt tag (session/approvalPrompt.ts). It LEADS the body so a
      // truncated tapback quote still carries it; the question follows, unchanged.
      assert.match(sends[0].text, /^🔐 #[0-9a-z]{3} · Act on chase\.com/);
      assert.match(sends[0].text, /👍 this to approve/);
      assert.equal(sends[0].opts?.mediaBase64, png.toString("base64"), "the actual bytes, not a path or a link");
      assert.equal(sends[0].opts?.mediaMime, "image/png");
      convo.resolveApproval(true);
      assert.equal(await decision, true);
    } finally {
      fs.rmSync(shot, { force: true });
    }
  });

  await check("a 🔐 with no screenshot is byte-identical to before", async () => {
    const sends: { text: string; opts?: SendOptions }[] = [];
    const convo = new Conversation(fakeTransport(sends), "+15555550123");
    const decision = (convo as any).askOwner("Send email to dave@example.com: \"coffee\"?") as Promise<boolean>;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].opts, undefined);
    convo.resolveApproval(false);
    assert.equal(await decision, false);
  });

  await check("a bad screenshot path degrades to the plain prompt", async () => {
    const sends: { text: string; opts?: SendOptions }[] = [];
    const convo = new Conversation(fakeTransport(sends), "+15555550123");
    const decision = (convo as any).askOwner("Confirm browser action: \"Place your order\"?", {
      imagePath: "/nope/does/not/exist.png",
    }) as Promise<boolean>;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].opts, undefined, "a missing file must not stop the question going out");
    convo.resolveApproval(true);
    assert.equal(await decision, true);
  });

  await check("an attachment send that FAILS retries text-only instead of auto-denying", async () => {
    // The regression that would actually hurt: a screenshot turning a 👍 they'd have given into a
    // silent deny, because the send threw and askOwner's catch treats that as undeliverable.
    const shot = path.join(os.tmpdir(), `approval-shot-fail-${process.pid}.png`);
    fs.writeFileSync(
      shot,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    try {
      const sends: { text: string; opts?: SendOptions }[] = [];
      const convo = new Conversation(fakeTransport(sends, true), "+15555550123");
      const decision = (convo as any).askOwner("Let the browser upload a file to this page?", {
        imagePath: shot,
      }) as Promise<boolean>;
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sends.length, 1, "the text-only retry still went out");
      assert.equal(sends[0].opts, undefined);
      assert.match(sends[0].text, /🔐 #[0-9a-z]{3} · Let the browser upload/);
      convo.resolveApproval(true);
      assert.equal(await decision, true, "a failed attachment must never become a silent deny");
    } finally {
      fs.rmSync(shot, { force: true });
    }
  });

  console.log("approval screenshots: wiring");

  await check("the browse specialist is the lane that wraps", async () => {
    // The wrapper is only correct where browser/peekaboo are actually mounted, and browser.ts is
    // the only place that mounts either. Read the wiring rather than trusting the export — a
    // plain makeCanUseTool here would leave every browser 🔐 blind again, silently.
    const src = fs.readFileSync(path.join(__dirname, "browser.ts"), "utf8");
    assert.match(src, /canUseTool:\s*makeCanUseToolWithApprovalShots\(approver,[^)]*jobPageRef\)/);
    assert.ok(
      !/canUseTool:\s*makeCanUseTool\(/.test(src),
      "browser.ts must not fall back to the unwrapped permission callback",
    );
    // The run's tab has to reach the other out-of-band surfaces too, or the 🔐 shows the right
    // page while staging and the credential injector are still guessing at a different one.
    assert.match(src, /credentials:\s*makeCredentialsServer\(jobPageRef\)/);
    assert.match(src, /handoff:\s*makeHandoffServer\(jobPageRef\)/);
  });

  console.log(`\n${passed} checks passed`);
}

void main()
  .then(() => {
    // Exit EXPLICITLY, unlike every other test file in here, and only because of the
    // live-Chrome check: captureViaCdp opens real handles to Chrome's debug port — an
    // undici keep-alive socket for /json/list plus the CDP WebSocket, whose `close()` is a
    // graceful handshake — and both can outlive the assertions. Two live sockets keep node's
    // event loop alive, so on a machine with Chrome up this file printed all 19 checks and
    // then hung forever, which silently wedged `npm test` for the entire chain behind it
    // (the suite could never report green — it just never finished). Nothing is left to
    // await once the checks pass, so say so instead of waiting on sockets we don't own.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
