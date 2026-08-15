// Inbound media hints. Code can detect certain inbound shapes deterministically (a
// video-platform URL, a native iMessage audio message), so instead of building a whole
// extraction layer we conditionally render a one-line instruction telling fig how to
// handle that shape. Each hint only fires when its trigger is actually present;
// everything else (articles, files, images) is untouched and goes through the normal
// tool ladder / native Read. Hints are model-visible only — bundle() feeds them to the
// prompt, never to the transcript or a bubble.

interface PlatformHint {
  test: RegExp;
  hint: string;
}

const PLATFORMS: PlatformHint[] = [
  {
    // youtube.com/watch, /shorts, /live, youtu.be
    test: /(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i,
    hint:
      "[a youtube link is in this message. fetch_url reads youtube transcripts directly — use it on the link to get the content before responding about it.]",
  },
  {
    // instagram reels/posts/tv
    test: /instagram\.com\/(?:reels?|p|tv)\//i,
    hint:
      "[an instagram link is in this message. it's login-walled — the fetch ladder and WebFetch can't read it. pull it with yt-dlp using browser cookies: `yt-dlp --cookies-from-browser chrome --write-auto-subs --skip-download --print description '<url>'` for captions+description, or drop '--skip-download' to grab the clip. if yt-dlp is auth-blocked, hand the raw link to the browse tool (logged-in chrome). read what you pull before answering.]",
  },
  {
    // tiktok.com, vm.tiktok.com, www.tiktok.com/@user/video/...
    test: /(?:vm\.)?tiktok\.com\//i,
    hint:
      "[a tiktok link is in this message. it's login-walled — the fetch ladder and WebFetch can't read it. pull it with yt-dlp using browser cookies: `yt-dlp --cookies-from-browser chrome --write-auto-subs --skip-download --print description '<url>'` for captions+description, or drop '--skip-download' to grab the clip. if yt-dlp is auth-blocked, hand the raw link to the browse tool (logged-in chrome). read what you pull before answering.]",
  },
];

// Returns at most one instruction per matched platform (deduped), in stable order.
// Empty array when the text contains no video-platform links.
export function videoLinkHints(text: string): string[] {
  if (!text) return [];
  return PLATFORMS.filter((p) => p.test.test(text)).map((p) => p.hint);
}

// --- Native iMessage audio messages -----------------------------------------
//
// The waveform bubble (hold-to-record in Messages) is NOT the same thing as sharing an
// audio FILE, and the difference is legible on disk. Apple records an audio message into
// a CoreAudio `.caf` (`Audio Message.caf`, uti com.apple.coreaudio-format) over iMessage,
// or `.amr` over SMS — containers nothing else in this pipeline produces. imsg's
// `--convert-attachments` cache also names its transcode `Audio-Message-<hash>.m4a`, so
// the name is checked too in case staging ever moves to the converted file. A shared
// .mp3/.m4a/.wav keeps its own name and is deliberately NOT treated as a voice message.
const AUDIO_MESSAGE_CONTAINERS = new Set([".caf", ".amr"]);
const AUDIO_EXTS = new Set([".caf", ".amr", ".m4a", ".mp4", ".aac", ".wav", ".mp3", ".opus"]);
const AUDIO_MESSAGE_NAME = /audio[-_ ]?message/i;

function extOf(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** True for a file that is a NATIVE iMessage audio message, not just any audio file. */
export function isAudioMessagePath(p: string): boolean {
  if (!p) return false;
  const base = (p.split(/[\\/]/).pop() ?? p).trim();
  if (!base) return false;
  const ext = extOf(base);
  if (AUDIO_MESSAGE_CONTAINERS.has(ext)) return true;
  // Converted/renamed audio messages: the name has to say so AND it has to be audio.
  return AUDIO_MESSAGE_NAME.test(base) && AUDIO_EXTS.has(ext);
}

/**
 * The owner sent a voice message → default the reply to one too, so the modality matches
 * instead of them talking and getting a wall of text back. Deliberately a DEFAULT and not
 * a mandate: plenty of answers (a link, a path, code, a 🔐) are worse spoken, and fig
 * keeps that judgment. Null when no native audio message is in the batch — an ordinary
 * attachment changes nothing about how fig replies.
 */
export function audioMessageHint(mediaPaths: readonly string[]): string | null {
  if (!mediaPaths?.some(isAudioMessagePath)) return null;
  return (
    "[the owner sent this as a native iMessage audio message (the waveform bubble), so match them: " +
    "DEFAULT this reply to a voice message. render it with mcp__tts__speak (local kokoro — free, " +
    "offline, no per-use cost) and put the returned path ALONE on its own line, which is what makes " +
    "it arrive as a real audio bubble instead of a file. write it to be HEARD: spoken sentences, no " +
    "markdown, no bullet lists, no raw urls or paths read aloud. this is a default, not a rule — if " +
    "the answer is something they need ON SCREEN (a link, a file path, code, a list they have to scan) or " +
    "it's a 🔐 approval, send that as text; the natural move there is a short spoken reply plus the " +
    "screen-bound part as its own text bubble. if it can't be voiced, just answer normally.]"
  );
}

/** Split a batch's media into the voice notes and everything else, order preserved. */
export function partitionAudioNotes(mediaPaths: readonly string[]): { notes: string[]; others: string[] } {
  const notes: string[] = [];
  const others: string[] = [];
  for (const p of mediaPaths ?? []) (isAudioMessagePath(p) ? notes : others).push(p);
  return { notes, others };
}

/** One transcribed (or un-transcribable) voice note, as the STT lane returns it. */
export interface AudioNoteTranscript {
  path: string;
  /** True when whisper ran; `text` may still be empty if it heard no speech. */
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * The voice note's WORDS, rendered for the prompt.
 *
 * This is the half that makes a voice note a real message instead of an unreadable
 * file path: the transcript goes into the model-visible turn, so fig answers what
 * The owner SAID. Three honest states, because a wrong one is worse than a missing one:
 *
 *   heard it   → the transcript, quoted, with the source path for a re-listen
 *   heard none → say so; do not invent content for a bubble that had no speech
 *   failed     → say the words are UNAVAILABLE and that guessing isn't allowed
 *
 * Null when the batch has no voice notes at all. Never contains the reply-modality
 * instruction — that's `audioMessageHint`, which fires in all three states.
 */
export function audioNoteTranscriptBlock(notes: readonly AudioNoteTranscript[]): string | null {
  if (!notes?.length) return null;
  const many = notes.length > 1;
  const lines = notes.map((n, i) => {
    const label = many ? `${i + 1}. ` : "";
    if (!n.ok) {
      return (
        `${label}TRANSCRIPTION FAILED (${n.error || "unknown error"}) — you do NOT have their words. ` +
        `the file is at ${n.path}. tell them it didn't come through and ask them to resend or type it; ` +
        `never guess at what a voice message said.`
      );
    }
    if (!n.text.trim()) {
      return (
        `${label}no discernible speech in it (silence, noise, or a pocket-tap) — file at ${n.path}. ` +
        `say you got the note but couldn't hear anything in it; don't invent content.`
      );
    }
    return `${label}"${n.text.trim()}" (source: ${n.path})`;
  });
  const head = many
    ? `[the owner sent ${notes.length} voice messages, transcribed locally on-device (whisper, nothing left the mini). their words:`
    : `[the owner sent this as a voice message, transcribed locally on-device (whisper, nothing left the mini). what they said:`;
  return `${head}\n${lines.join("\n")}\n` +
    `treat the transcript as their message and answer it directly. it's machine-transcribed, so a garbled ` +
    `name or number may be a mishearing — ask instead of guessing when it actually matters.]`;
}
