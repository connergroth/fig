import crypto from "node:crypto";
import type { Page } from "playwright";

import { ensureBrowserChrome } from "../browser/chrome";
import { warn } from "../core/log";

export type ProbeResult = { signal: string; human: string } | { error: string };
export type Probe = () => Promise<ProbeResult>;

const PROBE_TIMEOUT_MS = 30_000;

function hashParts(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/playwright isn't installed/i.test(msg)) return "PLAYWRIGHT_MISSING";
  if (/timeout/i.test(msg)) return "TIMEOUT";
  return msg.replace(/\s+/g, " ").slice(0, 220);
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function closeQuietly(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return;
  try {
    await Promise.race([
      page.close({ runBeforeUnload: false }),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } catch (e) {
    warn(`detector probe page close failed: ${cleanError(e)}`);
  }
}

async function browserProbe(label: string, fn: (page: Page) => Promise<ProbeResult>): Promise<ProbeResult> {
  let page: Page | undefined;
  try {
    const ctx = await ensureBrowserChrome();
    page = await ctx.newPage();
    page.setDefaultTimeout(PROBE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PROBE_TIMEOUT_MS);
    return await withTimeout(fn(page), label);
  } catch (e) {
    return { error: cleanError(e) };
  } finally {
    await closeQuietly(page);
  }
}

type ReadState = {
  authFailed: boolean;
  count: number;
  ids: string[];
};

async function redditUnread(): Promise<ProbeResult> {
  return browserProbe("reddit-unread", async (page) => {
    let lastAuthFailed = false;
    for (const url of ["https://www.reddit.com/message/unread/", "https://old.reddit.com/message/unread/"]) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      const state = await page.evaluate<ReadState>(() => {
        const g = globalThis as any;
        const document = g.document;
        const location = g.location;
        const text = document.body?.innerText?.toLowerCase() ?? "";
        const path = location.pathname.toLowerCase();
        const authFailed =
          path.includes("/login") ||
          path.includes("/account/login") ||
          (!!document.querySelector('input[type="password"], input[name="passwd"]') &&
            /log in|login|sign in/.test(text));
        if (authFailed) return { authFailed: true, count: 0, ids: [] };

        const nodes = new Set<any>();
        for (const selector of [
          ".message.unread",
          ".thing.unread",
          ".message",
          "[data-testid*='message' i]",
          "[aria-label*='unread' i]",
          "article",
          "shreddit-post",
        ]) {
          document.querySelectorAll(selector).forEach((el: any) => nodes.add(el));
        }

        const ids: string[] = [];
        for (const el of nodes) {
          const klass = typeof el.className === "string" ? el.className.toLowerCase() : "";
          const aria = el.getAttribute("aria-label")?.toLowerCase() ?? "";
          const looksUnreadPageItem =
            location.pathname.includes("/message/unread") &&
            (el.matches(".message, .thing, article, shreddit-post, [data-testid*='message' i]") ||
              klass.includes("unread") ||
              aria.includes("unread"));
          if (!looksUnreadPageItem && !klass.includes("unread") && !aria.includes("unread")) continue;

          const link =
            el.querySelector('a[href*="/message/messages/"]') ??
            el.querySelector('a[href*="/comments/"]') ??
            el.querySelector("a[href]");
          const rawId =
            el.getAttribute("data-fullname") ||
            el.getAttribute("data-message-id") ||
            el.id ||
            link?.href ||
            el.textContent?.replace(/\s+/g, " ").trim().slice(0, 160);
          if (rawId) ids.push(rawId);
        }

        const emptyInbox = /there doesn't seem to be anything here|there are no messages|no unread/i.test(text);
        const uniqueIds = [...new Set(ids)].sort();
        return { authFailed: false, count: emptyInbox ? 0 : uniqueIds.length, ids: emptyInbox ? [] : uniqueIds };
      });
      lastAuthFailed = state.authFailed;
      if (!state.authFailed) {
        const signal = `reddit-unread:${state.count}:${hashParts(state.ids)}`;
        const human = `${state.count} unread reddit ${state.count === 1 ? "item" : "items"} detected`;
        return { signal, human };
      }
    }
    return { error: lastAuthFailed ? "AUTH_FAILED" : "READ_FAILED" };
  });
}

async function linkedinUnread(): Promise<ProbeResult> {
  return browserProbe("linkedin-unread", async (page) => {
    await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    const state = await page.evaluate<ReadState>(() => {
      const g = globalThis as any;
      const document = g.document;
      const location = g.location;
      const text = document.body?.innerText?.toLowerCase() ?? "";
      const path = location.pathname.toLowerCase();
      const authFailed =
        path.includes("/login") ||
        path.includes("/checkpoint") ||
        path.includes("/uas/login") ||
        (!!document.querySelector('input[type="password"]') && /sign in|login|checkpoint/.test(text));
      if (authFailed) return { authFailed: true, count: 0, ids: [] };

      const ids: string[] = [];
      const unreadNodes = new Set<any>();
      for (const selector of [
        ".msg-conversation-listitem--unread",
        "[class*='conversation'][class*='unread']",
        "[class*='msg'][class*='unread']",
        "[aria-label*='unread' i]",
        "[data-test-icon='unread-message-icon']",
      ]) {
        document.querySelectorAll(selector).forEach((el: any) => {
          const conversation = el.closest("li, article, [data-view-name], [data-entity-urn]") ?? el;
          unreadNodes.add(conversation);
        });
      }

      for (const el of unreadNodes) {
        const link =
          el.querySelector('a[href*="/messaging/thread/"]') ??
          el.querySelector('a[href*="/messaging/"]');
        const rawId =
          el.getAttribute("data-entity-urn") ||
          el.getAttribute("data-urn") ||
          el.id ||
          link?.href ||
          el.textContent?.replace(/\s+/g, " ").trim().slice(0, 180);
        if (rawId) ids.push(rawId);
      }

      const badgeText = [
        ...Array.from(document.querySelectorAll("[class*='notification-badge'], [class*='unread-count'], [aria-label*='unread' i]")),
      ]
        .map((el: any) => `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""}`)
        .join(" ");
      const badgeCount = [...badgeText.matchAll(/\b(\d{1,3})\b/g)]
        .map((m) => Number(m[1]))
        .filter((n) => Number.isFinite(n) && n > 0)
        .at(0);

      const uniqueIds = [...new Set(ids)].sort();
      return { authFailed: false, count: badgeCount ?? uniqueIds.length, ids: uniqueIds };
    });
    if (state.authFailed) return { error: "AUTH_FAILED" };
    const signal = `linkedin-unread:${state.count}:${hashParts(state.ids)}`;
    const human = `${state.count} unread linkedin ${state.count === 1 ? "conversation" : "conversations"} detected`;
    return { signal, human };
  });
}

export const PROBES: Record<string, Probe> = {
  "reddit-unread": redditUnread,
  "linkedin-unread": linkedinUnread,
};
