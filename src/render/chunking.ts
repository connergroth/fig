/**
 * Message chunking + human-feeling inter-chunk cadence.
 * The constants were dialed in by feel against a real thread — don't re-derive them.
 * Floor is never sub-second.
 */

const CHUNK_DELAY_FLOOR_MS = 1200;
const CHUNK_DELAY_CAP_MS = 2800;

/**
 * Safety net: strip markdown before sending. The message surface has no renderer, so
 * `**bold**` and `[text](url)` arrive as literal characters no matter whose agent this is —
 * that makes this a fact about the transport, not a style preference. Kept conservative: it
 * won't touch URLs or normal underscores.
 *
 * Nothing here touches WORDING. Style is the prompt's job: a persona file states the rule
 * and the model follows it. Rewriting an agent's own punctuation or casing in transit is a
 * silent override of that file with nothing in the vault to explain it, so this layer only
 * ever removes syntax the surface cannot render.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "").trim()) // fenced code
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1") // *italic*
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // # headings
    .replace(/^(\s{0,3})\*\s+/gm, "$1- ") // normalize "* " bullets to "- " (keep dash lists)
    .replace(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g, "$1") // ![alt](url) image -> bare url (runs before the link rule so the leading ! never survives)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$2") // [text](url) -> bare url
    .trim();
}

/**
 * Proactive / scheduled passes (briefing, heartbeat, scheduled tasks, watches, goals,
 * research packaging, email/calendar voicing) are instructed to wrap the EXACT text
 * The owner should receive in <output>...</output>. Models like to narrate before the real
 * message ("Pruned the queue and sent. Here's their brief:") and that preamble used to ride
 * along verbatim into the thread. This pulls out ONLY the wrapped payload.
 *
 * Contract:
 * - No wrapper present  → return the text unchanged. Safe fallback: a pass that forgets
 *   to wrap still delivers exactly as before, so nothing breaks.
 * - One or more wrappers → return the LAST one's contents, trimmed. Last wins so an
 *   illustrative/aborted earlier block, or narration-then-output, can't override the
 *   final intended message (there should normally be exactly one).
 * - Unclosed <output> (model opened the tag but never closed it) → take everything after
 *   the last open tag, so the literal tag never leaks even on a malformed wrap.
 * Case-insensitive, spans newlines, tolerant of text/whitespace before and after the tags.
 * Only ever applied on proactive/scheduled delivery paths — never to live replies.
 */
export function unwrapOutput(text: string): string {
  const re = /<output>([\s\S]*?)<\/output>/gi;
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1];
  if (last !== null) return last.trim();
  const open = text.toLowerCase().lastIndexOf("<output>");
  if (open !== -1) {
    return text.slice(open + "<output>".length).replace(/<\/?output>/gi, "").trim();
  }
  return text;
}

/** True if `t` is the quiet sentinel — exactly NOTHING, or a trailing standalone NOTHING. */
export function isQuietSentinel(t: string): boolean {
  // It's told to output exactly NOTHING, but sometimes prepends reasoning and
  // leaves NOTHING on the end. Case-sensitive on the trailing form so prose ending
  // in lowercase "nothing" isn't swallowed.
  return /^NOTHING$/i.test(t.trim()) || /(^|\s)NOTHING\s*$/.test(t);
}

/**
 * If fig's entire reply is exactly this token, it's choosing to say NOTHING — the
 * harness delivers no bubble and does NOT fire the "no reply generated" warning. Lets
 * fig stay quiet on low-signal inbounds (e.g. a bare tapback on one of its own texts)
 * instead of being forced to respond.
 */
export const SILENCE_TOKEN = "[no reply]";

/**
 * A turn (or pass) stays quiet on EITHER sentinel: `[no reply]` (the live-session token)
 * or the bare `NOTHING` that the scheduler/watch/heartbeat prompts train. A background
 * result injected into the main session can surface either one depending on which
 * instruction set influenced the reply, so any caller gating on "should I stay quiet?"
 * must catch both — otherwise a stray sentinel leaks out as a literal bubble (the 18:49
 * leak). isQuietSentinel also strips a trailing standalone NOTHING after reasoning.
 */
export function isSilence(t: string): boolean {
  return t.trim().toLowerCase() === SILENCE_TOKEN || isQuietSentinel(t);
}

/**
 * True if `text` is quiet EITHER bare (`isQuietSentinel`) OR wrapped inside a well-formed
 * <output> block (e.g. `<output>NOTHING</output>`). Proactive/scheduled prompts tell the
 * model to emit a bare NOTHING with NO tags when it has nothing to report, but nothing
 * stops it from wrapping the sentinel out of habit anyway — and `isValidProactiveOutput`
 * treats ANY wrapped block as valid without inspecting its contents. A caller that checks
 * `isQuietSentinel` on the raw (still-wrapped) text misses that case: the raw text isn't
 * bare NOTHING, so the check passes it through as a "real" message, `unwrapOutput` then
 * peels the wrapper back off to bare NOTHING, and it reaches the user verbatim with
 * nothing left downstream to catch it (the 22:56 leak — a browse-job confirm-prompt
 * reaction landed in the same window as a scheduled pass that wrapped its own quiet
 * sentinel this way). Use this instead of `isQuietSentinel` alone anywhere the pass being
 * checked is allowed to wrap its output.
 */
export function isQuietOutput(text: string): boolean {
  return isQuietSentinel(text) || (hasWrappedOutput(text) && isQuietSentinel(unwrapOutput(text)));
}

/** Does the text contain a well-formed, CLOSED <output>...</output> block? */
export function hasWrappedOutput(text: string): boolean {
  return /<output>[\s\S]*?<\/output>/i.test(text);
}

/**
 * Per-caller contract describing which UNWRAPPED outputs are legitimate for a proactive
 * pass (everything else — bare prose with no <output> wrapper — is the narration leak we
 * reject). `allowQuiet` admits the NOTHING sentinel; `bareTokens` admits a lone control
 * token (RESOLVED / DONE / CONTINUE) that watches/goals emit when there's no message.
 * `mustContain` (optional) additionally requires that a WRAPPED payload — the actual
 * delivered text, unwrapped + stripped the same way deliver() does — include every listed
 * substring (case-insensitive). This catches the "wrapper is well-formed but the CONTENT
 * is wrong" leak: e.g. the newspaper pass emitting `<output>done. paper's filed, tl;dr
 * sent</output>` — a status line with NO paper link — which the bare wrapper check would
 * happily pass. The quiet-sentinel path is exempt (a genuine no-news NOTHING day stays
 * valid regardless of mustContain).
 */
export interface ProactiveContract {
  allowQuiet: boolean;
  bareTokens: readonly string[];
  mustContain?: readonly string[];
}

/** Named contracts, one per proactive chokepoint. Pure data so scheduler + worker share them. */
export const OUTPUT_CONTRACT = {
  /** Skills / one-off tasks: a wrapped message, or the quiet NOTHING sentinel. */
  quiet: { allowQuiet: true, bareTokens: [] },
  /**
   * The daily newspaper skill: like `quiet` (a no-news day still legitimately emits
   * NOTHING), but any NON-quiet message MUST carry the paper link — the tl;dr with no
   * `open-page.cc/paper` link is the "done, sent" status-line leak — a bare "done" delivered
   * instead of the paper. A missing link fails validation and re-prompts.
   */
  newspaper: { allowQuiet: true, bareTokens: [], mustContain: ["open-page.cc/paper"] },
  /** Watches: wrapped message (optionally + trailing RESOLVED), NOTHING, or a bare RESOLVED. */
  watch: { allowQuiet: true, bareTokens: ["RESOLVED"] },
  /** Goals: wrapped message (+ trailing CONTINUE/DONE), or a bare CONTINUE/DONE — never NOTHING. */
  goal: { allowQuiet: false, bareTokens: ["CONTINUE", "DONE"] },
  /** Research packaging / voicing: a wrapped message only. */
  wrapped: { allowQuiet: false, bareTokens: [] },
} satisfies Record<string, ProactiveContract>;

/**
 * Is `text` a lone control-token line — the token by itself (optionally on a trailing
 * line) with NO user-facing prose around it? Mirrors runWatch/runGoal's trailing-token
 * regexes, but ADDITIONALLY requires that removing the token leaves nothing: prose + a
 * bare token (no <output> wrapper) is exactly the leak case and must stay INVALID.
 */
function isBareToken(text: string, token: string): boolean {
  if (!new RegExp(`(^|\\s)${token}\\s*$`).test(text)) return false;
  return text.replace(new RegExp(`\\s*${token}\\s*$`), "").trim() === "";
}

/**
 * Validate a proactive/scheduled pass's final text against its contract. VALID iff it
 * either carries a well-formed <output>...</output> block (the normal case) OR is a
 * recognized sentinel/token the contract allows to appear unwrapped. Bare prose with no
 * wrapper — the "Pruned the queue and sent. Here's their brief:" leak — is INVALID.
 * Empty text is treated as valid here (the caller handles it as quiet/failed upstream;
 * it is not a leak).
 */
export function isValidProactiveOutput(text: string, contract: ProactiveContract): boolean {
  const t = text.trim();
  if (!t) return true;
  if (hasWrappedOutput(t)) {
    // Wrapper is well-formed, but a `mustContain` contract additionally requires the
    // DELIVERED payload carry every mandatory token (e.g. the newspaper's paper link).
    // Check against the same unwrapped+stripped text deliver() actually ships, so the
    // gate matches what reaches the owner — a "done, paper sent" status line with no link
    // fails here and gets re-prompted instead of delivered.
    if (contract.mustContain && contract.mustContain.length > 0) {
      const delivered = stripMarkdown(unwrapOutput(t)).toLowerCase();
      return contract.mustContain.every((sub) => delivered.includes(sub.toLowerCase()));
    }
    return true;
  }
  if (contract.allowQuiet && isQuietSentinel(t)) return true;
  return contract.bareTokens.some((tok) => isBareToken(t, tok));
}

/**
 * The correction handed back to the model when its output failed `isValidProactiveOutput`.
 * Tells it to re-emit ONLY the wrapped message, listing the unwrapped forms its contract
 * still permits (NOTHING / a bare control token) so a legitimately-quiet pass can comply.
 */
export function proactiveCorrection(contract: ProactiveContract): string {
  const alts: string[] = [];
  if (contract.allowQuiet) alts.push("if there is genuinely nothing to send them, output exactly NOTHING with no tags");
  for (const tok of contract.bareTokens) {
    alts.push(`if the only thing to emit is the ${tok} control token, output exactly ${tok} on its own line with no tags`);
  }
  const mustContain = contract.mustContain ?? [];
  return [
    "Your previous output was not wrapped correctly and would have leaked your narration into the thread.",
    "Re-emit ONLY the message the owner should receive, wrapped in <output></output> tags, with NOTHING outside the tags.",
    "Do not use any tools or redo the work — just reformat what you already produced.",
    ...(mustContain.length
      ? [
          `The message the owner actually receives (the text inside <output></output>) MUST contain, verbatim, ${mustContain
            .map((s) => `"${s}"`)
            .join(" and ")} — e.g. the actual open-page paper link.`,
          "If your previous output was missing it (a bare 'done'/'sent' status line with no link is the exact failure here), you must INCLUDE it — reconstruct the real link, do not just reformat what you had.",
        ]
      : []),
    ...(alts.length ? [`Alternatively, ${alts.join("; or ")}.`] : []),
  ].join(" ");
}

/**
 * Our own short-link domains (open-email.cc/<id>, open-page.cc/doc/<slug>) are
 * deliberately NOT lifted into their own bubble — a lone-URL bubble is exactly what
 * makes iMessage render a big rich preview CARD (and fetch/scrape the target). The owner
 * wants these to stay inline tappable links (e.g. `✉️ open-email.cc/…`,
 * `📄 open-page.cc/…`), so we keep them buried in their text bubble. This holds
 * whether or not a scheme is present. Every other URL still gets its own bubble to
 * stay tappable + unburied.
 */
const EMAIL_SHORT_LINK_RE = /^https?:\/\/(?:www\.)?(?:open-email|open-page)\.cc(?:\/\S*)?$/i;

/**
 * An open-url.cc preview wrapper (from linkPreview.mintLinkPreview) is the OPPOSITE of the
 * email short link: we WANT it lifted onto its own bubble so iMessage scrapes it and renders
 * the baked OpenGraph card. It's minted scheme-LESS ("open-url.cc/<id>"), so the plain
 * bare-http rule below misses it — recognize it explicitly (with or without a scheme).
 */
const LINK_PREVIEW_SHORT_LINK_RE = /^(?:https?:\/\/)?(?:www\.)?open-url\.cc\/\S+$/i;

/**
 * A line that is nothing but a URL gets its own bubble — so it stays tappable and
 * isn't buried in a paragraph. This fires even when the model used a single newline
 * (URL on its own line) instead of a blank-line paragraph break. Two exceptions flip the
 * default: an open-email.cc / open-page.cc short link is kept inline (see EMAIL_SHORT_LINK_RE)
 * so it renders as a plain link, not a card; and a scheme-less open-url.cc preview wrapper is
 * lifted even though it lacks a scheme (see LINK_PREVIEW_SHORT_LINK_RE) so its card renders.
 */
function splitBareUrls(block: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  const flushBuf = () => {
    const t = buf.join("\n").trim();
    if (t) out.push(t);
    buf = [];
  };
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    const bareHttp = /^https?:\/\/\S+$/.test(trimmed) && !EMAIL_SHORT_LINK_RE.test(trimmed);
    if (bareHttp || LINK_PREVIEW_SHORT_LINK_RE.test(trimmed)) {
      flushBuf();
      out.push(trimmed);
    } else {
      buf.push(line);
    }
  }
  flushBuf();
  return out;
}

/**
 * Is this chunk nothing but a direct image URL? If so, delivery sends it as an
 * actual inline image (MMS/iMessage attachment) instead of a tappable link. Gated
 * on a real image extension so ordinary links (maps, articles, obsidian://) stay
 * text — the query string is tolerated since CDNs append `?w=...&token=...`.
 */
const IMAGE_EXT = "(?:jpe?g|png|gif|webp|heic|heif|bmp|tiff?)";
const IMAGE_URL_RE = new RegExp(`^https?:\\/\\/\\S+\\.${IMAGE_EXT}(?:\\?\\S*)?$`, "i");
export function isImageUrl(text: string): boolean {
  return IMAGE_URL_RE.test(text.trim());
}

/**
 * Pull image URLs out of a bubble even when the model wrote them INLINE in a
 * sentence ("here's the spot: https://….jpg gorgeous right?") rather than alone on
 * their own line. Each image URL becomes its own chunk (which delivery then sends as
 * a real attachment), with the surrounding prose kept as text chunks around it. A
 * bare-line image URL already survives splitBareUrls; this catches the embedded case.
 */
const IMAGE_URL_GLOBAL = new RegExp(`https?:\\/\\/\\S+\\.${IMAGE_EXT}(?:\\?\\S*)?`, "gi");
function splitOutImageUrls(block: string): string[] {
  IMAGE_URL_GLOBAL.lastIndex = 0;
  if (!IMAGE_URL_GLOBAL.test(block)) return [block];
  IMAGE_URL_GLOBAL.lastIndex = 0;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_URL_GLOBAL.exec(block)) !== null) {
    const before = block.slice(last, m.index).trim();
    if (before) out.push(before);
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  const after = block.slice(last).trim();
  if (after) out.push(after);
  return out.length ? out : [block];
}

/**
 * Pull a `[[poll:…]]` token onto its own chunk even when it was written INLINE — at the
 * end of a paragraph, mid-sentence, or without a preceding `[[split]]`. Delivery only
 * fires a native poll when a chunk is JUST the token (parsePoll), so an inline token used
 * to ship to the thread as literal `[[poll: … | … ]]` text: the balloon silently became
 * garbage in a bubble. Chunking is the right home for the carve-out because BOTH send
 * lanes funnel through it — the reactive one (buildChunks) and the proactive/scheduled one
 * (pacedSend), which has no token pass of its own.
 *
 * Only well-formed tokens are lifted (question + ≥2 options, i.e. what parsePoll accepts);
 * a malformed one is left embedded in its prose exactly as before, so nothing changes shape
 * on a typo. Surrounding prose stays as its own chunk on each side.
 */
function splitOutPollTokens(block: string): string[] {
  POLL_TOKEN.lastIndex = 0;
  if (!POLL_TOKEN.test(block)) return [block];
  POLL_TOKEN.lastIndex = 0;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = POLL_TOKEN.exec(block)) !== null) {
    if (!parsePoll(m[0])) continue; // malformed → leave it inline, untouched
    const before = block.slice(last, m.index).trim();
    if (before) out.push(before);
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  const after = block.slice(last).trim();
  if (after) out.push(after);
  return out.length ? out : [block];
}

/**
 * A local filesystem path to a media/doc file, alone on its own line, is pulled into its
 * own chunk so delivery can attach the REAL file (read bytes + infer MIME) instead of
 * sending the path as literal text — the file-path analogue of a bare image URL becoming
 * an inline image. Guards keep false positives low: it must be a whole-line path that
 * clearly looks like one (absolute `/…`, home `~/…`, or explicit `./`/`../`), ending in a
 * known media/doc extension. A path mentioned mid-sentence, or a bare `foo.png` with no
 * path prefix, stays text. Existence is NOT checked here (chunking is pure string logic);
 * delivery fs-checks and falls back to sending the path as text if the file isn't there.
 */
const FILE_EXT =
  "(?:jpe?g|png|gif|webp|heic|heif|bmp|tiff?|pdf|txt|md|csv|json|docx?|xlsx?|pptx?|zip|tex|rtf|mp4|mov|m4v|mp3|m4a|wav)";
const FILE_PATH_RE = new RegExp(`^(?:~|\\.{1,2})?\\/\\S+\\.${FILE_EXT}$`, "i");
export function isLocalFilePath(text: string): boolean {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return false; // a URL — handled by the image-URL path, not this
  return FILE_PATH_RE.test(t);
}

/** A bare-line local file path gets its own bubble (delivery attaches it). Mirrors splitBareUrls. */
function splitBareFilePaths(block: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  const flushBuf = () => {
    const t = buf.join("\n").trim();
    if (t) out.push(t);
    buf = [];
  };
  for (const line of block.split("\n")) {
    if (isLocalFilePath(line)) {
      flushBuf();
      out.push(line.trim());
    } else {
      buf.push(line);
    }
  }
  flushBuf();
  return out;
}

/**
 * Split a reply into iMessage bubbles.
 *
 * "token" mode (fig, the default): bubbles are separated by a [[split]] delimiter —
 * blank lines are ordinary formatting WITHIN a bubble (breathing room), they no longer
 * split. Degrades safely: no token → one bubble; doubled/leading/trailing/inline tokens
 * are absorbed by the trim+filter sanitize, so a malformed token can never leak or emit
 * an empty bubble.
 *
 * "blank" mode (spot): the legacy behavior — blank line = new paced bubble. spot's
 * persona (own repo, prompt.ts) still teaches blank-line splitting; it opts in
 * explicitly so fig's delimiter migration doesn't change spot's texting shape.
 */
const SPLIT_TOKEN = /\[\[\s*split\s*\]\]/gi;
export function splitIntoChunks(text: string, mode: "token" | "blank" = "token"): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const blocks = (mode === "blank" ? trimmed.split(/\n\s*\n/) : trimmed.split(SPLIT_TOKEN))
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks
    .flatMap(splitOutPollTokens) // an inline [[poll:…]] token is lifted into its own bubble
    .flatMap(splitBareUrls) // a bare-URL line gets its own bubble
    .flatMap(splitOutImageUrls) // an inline image URL is lifted into its own bubble
    .flatMap(splitBareFilePaths); // a bare-line local file path gets its own bubble (attached at delivery)
}

/**
 * Inter-chunk delay (ms) that mimics human texting cadence: a jittered
 * "think/type" baseline plus length-scaled reading room, clamped to [1.2s, 2.8s].
 */
export function naturalChunkDelayMs(chunkText: string): number {
  const baseMs = 1100 + Math.random() * 500; // 1100–1600
  const lengthMs = Math.min(chunkText.trim().length * 14, 1200);
  const total = baseMs + lengthMs;
  return Math.max(CHUNK_DELAY_FLOOR_MS, Math.min(CHUNK_DELAY_CAP_MS, total));
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Emoji → tapback mapping. On channels that support reactions (imsg), a
 * reply that is JUST a mapped emoji becomes a tapback on the user's last message
 * instead of a text bubble.
 */
// iMessage only has SIX native reaction types (like/love/laugh/dislike/emphasize/
// question) — it can't send arbitrary-emoji tapbacks. So we map a wider set
// of emojis fig might naturally reach for onto those six. Anything NOT in this map
// falls through to a normal text bubble (see tapbackForEmoji). Keep this in sync with
// the tapback list in the system prompt (agent.ts).
export const EMOJI_TO_TAPBACK: Record<string, string> = {
  // like
  "👍": "like",
  "✅": "like",
  "🙏": "like",
  // love
  "❤️": "love",
  "🔥": "love",
  "🥰": "love",
  "😍": "love",
  // laugh
  "😂": "laugh",
  "🤣": "laugh",
  // dislike
  "👎": "dislike",
  // emphasize
  "‼️": "emphasize",
  "💯": "emphasize",
  "⁉️": "emphasize",
  // question
  "❓": "question",
  "❔": "question",
  "🤔": "question",
};

/** If `text` is exactly one tapback emoji, return its reaction name; else null. */
export function tapbackForEmoji(text: string): string | null {
  return EMOJI_TO_TAPBACK[text.trim()] ?? null;
}

/**
 * Friendly effect name → Apple iMessage expressive-send id, passed through to
 * the IMCore bridge by imsg as the send `effect_id`. The exact id set depends on
 * the macOS version — tune here if one doesn't land. Screen effects fill
 * the recipient's screen; bubble effects animate just the bubble.
 */
export const EFFECTS: Record<string, string> = {
  // screen effects
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  lasers: "com.apple.messages.effect.CKLasersEffect",
  balloons: "com.apple.messages.effect.CKHappyBirthdayEffect",
  love: "com.apple.messages.effect.CKHeartEffect",
  hearts: "com.apple.messages.effect.CKHeartEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
  echo: "com.apple.messages.effect.CKEchoEffect",
  celebration: "com.apple.messages.effect.CKSparklesEffect",
  // bubble effects
  slam: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
};

/**
 * Pull an inline `((effectname))` directive out of a message: returns the effect
 * id (if the name is known) and the text with the marker removed. The agent drops
 * `((confetti))` anywhere in a bubble to send it with that effect.
 */
export function extractEffect(text: string): { text: string; effectId?: string } {
  let effectId: string | undefined;
  const stripped = text.replace(/\(\(\s*([a-zA-Z]+)\s*\)\)/g, (m, name: string) => {
    const id = EFFECTS[name.toLowerCase()];
    if (id) {
      effectId = id; // last valid marker wins
      return "";
    }
    return m; // unknown name — leave it alone
  });
  // No marker → return the text untouched (never collapse a normal bubble's newlines).
  if (!effectId) return { text };
  // Marker removed → tidy only the spaces it left behind, never newlines.
  return { text: stripped.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim(), effectId };
}

/** Matches a whole-bubble native-poll token: `[[poll: question | opt | opt | …]]`. */
export const POLL_TOKEN = /\[\[poll:([^\]]*)\]\]/gi;

/**
 * Parse a chunk that is JUST a `[[poll: question | opt | opt]]` token into its question +
 * options. Returns null if the chunk isn't a lone poll token or has < 2 options. The token
 * is pipe-delimited: first field is the question, the rest are options (need ≥ 2). Emitted
 * on its own line so it lands as its own bubble; delivery fires a native Messages poll
 * balloon instead of a text bubble.
 */
export function parsePoll(text: string): { question: string; options: string[] } | null {
  const m = text.trim().match(/^\[\[poll:([^\]]*)\]\]$/i);
  if (!m) return null;
  const parts = m[1].split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null; // question + at least 2 options
  const [question, ...options] = parts;
  return { question, options };
}
