import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// bundle() now also consults the PERSISTENT /voice mode bit under stateDir, so these
// assertions would flip depending on whether the owner happens to have voice mode on when they
// runs the suite. Point the whole run at a temp brain BEFORE anything imports config, and
// load the modules under test dynamically so that assignment actually lands first.
// (Same trick render/tapback.test.ts and the other config-touching tests use.)
const TMP_BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "fig-media-hints-test-"));
process.env.BRAIN_DIR = TMP_BRAIN;

type Transport = import("../transport/types").Transport;
type MediaHints = typeof import("./media-hints");
type VoiceMode = typeof import("../core/voiceMode");

let audioMessageHint: MediaHints["audioMessageHint"];
let audioNoteTranscriptBlock: MediaHints["audioNoteTranscriptBlock"];
let isAudioMessagePath: MediaHints["isAudioMessagePath"];
let partitionAudioNotes: MediaHints["partitionAudioNotes"];
let videoLinkHints: MediaHints["videoLinkHints"];
let setVoiceMode: VoiceMode["setVoiceMode"];
let Conversation: typeof import("../session/session").Conversation;

/** Exactly how imsg stages an inbound attachment: <stateDir>/inbound/<guid>/att-<i><ext>. */
const staged = (guid: string, name: string): string =>
  `${os.homedir()}/GitHub/vault/.state/inbound/${guid}/${name}`;

// Two real inbound voice notes — both landed as att-0.caf.
const REAL_AUDIO_MSG = staged("A8C27993-DE1A-42A0-9742-B11D158E76A5", "att-0.caf");

function detection(): void {
  // --- native audio messages (the waveform bubble) ---------------------------
  assert.equal(isAudioMessagePath(REAL_AUDIO_MSG), true, "staged iMessage audio message (.caf)");
  assert.equal(isAudioMessagePath("/tmp/Audio Message.caf"), true, "apple's own filename");
  assert.equal(isAudioMessagePath("/tmp/att-0.AMR"), true, "sms voice message, case-insensitive");
  assert.equal(
    isAudioMessagePath(`${os.homedir()}/Library/Caches/imsg/converted-attachments/Audio-Message-a63ecf83.m4a`),
    true,
    "imsg's --convert-attachments transcode still reads as an audio message",
  );

  // --- ordinary attachments: explicitly NOT audio messages -------------------
  assert.equal(isAudioMessagePath(staged("G", "att-0.jpg")), false, "photo");
  assert.equal(isAudioMessagePath(staged("G", "att-0.pdf")), false, "pdf");
  assert.equal(isAudioMessagePath(staged("G", "att-0.mov")), false, "video");
  assert.equal(
    isAudioMessagePath("/tmp/interview-take-3.m4a"),
    false,
    "a shared audio FILE is not a voice message — sharing a song shouldn't make fig talk back",
  );
  assert.equal(isAudioMessagePath("/tmp/podcast.mp3"), false, "shared mp3");
  assert.equal(
    isAudioMessagePath("/tmp/audio message notes.txt"),
    false,
    "the name alone isn't enough — it has to actually be audio",
  );
  assert.equal(isAudioMessagePath(""), false, "empty path");

  // --- the hint itself -------------------------------------------------------
  assert.equal(audioMessageHint([]), null, "no media → no hint");
  assert.equal(audioMessageHint([staged("G", "att-0.jpg"), "/tmp/song.mp3"]), null, "ordinary media → no hint");

  const hint = audioMessageHint(["/tmp/att-0.png", REAL_AUDIO_MSG]);
  assert.ok(hint, "a voice message anywhere in the batch fires the hint");
  assert.ok(hint!.startsWith("[") && hint!.endsWith("]"), "rendered as a bracketed internal instruction");
  assert.match(hint!, /mcp__tts__speak/, "names the actual tool");
  assert.match(hint!, /alone on its own line/i, "names the native audio send path");
  assert.match(hint!, /default, not a rule/i, "stays a default — judgment preserved, not a mandate");

  console.log("✓ audio-message detection + hint");
}

function partitioning(): void {
  const photo = staged("G", "att-0.jpg");
  const { notes, others } = partitionAudioNotes([photo, REAL_AUDIO_MSG, "/tmp/song.mp3"]);
  assert.deepEqual(notes, [REAL_AUDIO_MSG], "only the native voice note counts as a note");
  assert.deepEqual(others, [photo, "/tmp/song.mp3"], "order preserved, shared audio stays an ordinary file");
  assert.deepEqual(partitionAudioNotes([]), { notes: [], others: [] });
  console.log("✓ audio-note partitioning");
}

function transcriptBlock(): void {
  assert.equal(audioNoteTranscriptBlock([]), null, "no notes → no block");

  // --- heard them -------------------------------------------------------------
  const heard = audioNoteTranscriptBlock([{ path: REAL_AUDIO_MSG, ok: true, text: "  yo can you check the rent  " }])!;
  assert.ok(heard.startsWith("[") && heard.endsWith("]"), "bracketed internal block");
  assert.match(heard, /"yo can you check the rent"/, "their words, trimmed and quoted");
  assert.ok(heard.includes(REAL_AUDIO_MSG), "keeps the source path for a re-listen");
  assert.match(heard, /locally on-device/, "says it never left the mini");

  // --- ran fine, heard nothing ----------------------------------------------
  const silent = audioNoteTranscriptBlock([{ path: REAL_AUDIO_MSG, ok: true, text: "" }])!;
  assert.match(silent, /no discernible speech/, "empty transcription is stated, not hidden");
  assert.match(silent, /don't invent content/, "and explicitly bans making something up");
  assert.doesNotMatch(silent, /FAILED/, "no-speech is not an error");

  // --- whisper died ----------------------------------------------------------
  const broken = audioNoteTranscriptBlock([{ path: REAL_AUDIO_MSG, ok: false, text: "", error: "timed out" }])!;
  assert.match(broken, /TRANSCRIPTION FAILED \(timed out\)/, "the reason is surfaced");
  assert.match(broken, /never guess at what a voice message said/, "guessing is banned on failure too");
  assert.ok(broken.includes(REAL_AUDIO_MSG), "path is there so fig can still try itself");

  // --- more than one ---------------------------------------------------------
  const two = audioNoteTranscriptBlock([
    { path: staged("A", "att-0.caf"), ok: true, text: "first" },
    { path: staged("B", "att-0.caf"), ok: true, text: "second" },
  ])!;
  assert.match(two, /2 voice messages/);
  assert.match(two, /1\. "first"/);
  assert.match(two, /2\. "second"/);

  console.log("✓ transcript block: heard / silent / failed");
}

function bundling(): void {
  const transport = { send: async () => null } as unknown as Transport;
  const convo = new Conversation(transport, "+15555550123") as any;
  const bundle = (batch: unknown[], transcripts?: unknown[]): string => convo.bundle(batch, transcripts);

  // 1. voice message + its transcript → words in the prompt, hook at the end.
  const voice = bundle(
    [{ text: "￼", media: [REAL_AUDIO_MSG] }],
    [{ path: REAL_AUDIO_MSG, ok: true, text: "check the rent portal for me" }],
  );
  assert.match(voice, /check the rent portal for me/, "the transcript IS the message fig reads");
  assert.match(voice, /native iMessage audio message/, "hook injected for an inbound audio message");
  assert.match(voice, /mcp__tts__speak/);
  assert.ok(voice.includes(REAL_AUDIO_MSG), "the source path is still in the prompt");
  assert.doesNotMatch(voice, /\[the owner attached/, "a .caf is never listed as a file to Read — Read can't open it");
  assert.doesNotMatch(voice, /￼/, "the object-replacement placeholder isn't echoed as if they typed it");
  assert.ok(
    voice.indexOf("[the owner sent this as a voice message") < voice.indexOf("[the owner sent this as a native"),
    "hook goes last, after the transcript",
  );

  // 1b. transcription failed → fig still learns a note arrived AND still defaults to voice.
  const failed = bundle(
    [{ text: "￼", media: [REAL_AUDIO_MSG] }],
    [{ path: REAL_AUDIO_MSG, ok: false, text: "", error: "mlx_whisper not found" }],
  );
  assert.match(failed, /TRANSCRIPTION FAILED \(mlx_whisper not found\)/);
  assert.match(failed, /mcp__tts__speak/, "a broken transcriber must not also kill the voice reply default");

  // 1c. no transcripts passed at all (a caller that skipped the STT lane) still degrades
  //     to "a voice note arrived and you can't read it" rather than silently dropping it.
  const untranscribed = bundle([{ text: "￼", media: [REAL_AUDIO_MSG] }]);
  assert.match(untranscribed, /TRANSCRIPTION FAILED \(not transcribed\)/);
  assert.match(untranscribed, /native iMessage audio message/);

  // 1d. mixed batch: a photo AND a voice note — both lanes render, neither eats the other.
  const mixed = bundle(
    [{ text: "look at this", media: [staged("G", "att-0.jpg"), REAL_AUDIO_MSG] }],
    [{ path: REAL_AUDIO_MSG, ok: true, text: "what do you think" }],
  );
  assert.match(mixed, /\[the owner attached 1 file\(s\).*att-0\.jpg/, "the photo still gets the Read line, alone");
  assert.match(mixed, /what do you think/, "and the note still gets transcribed");
  assert.match(mixed, /look at this/, "their typed text survives alongside both");

  // 2. ordinary attachments are untouched — no modality instruction.
  const photo = bundle([{ text: "look at this", media: [staged("G", "att-0.jpg")] }]);
  assert.match(photo, /\[the owner attached 1 file\(s\)/, "photo still gets the normal attachment line");
  assert.doesNotMatch(photo, /native iMessage audio message/, "a photo must not flip fig to voice");
  assert.doesNotMatch(photo, /mcp__tts__speak/);

  // 3. plain text turns are byte-identical to before.
  const plain = bundle([{ text: "is 2 a decent spot for a fantasy draft?", media: [] }]);
  assert.equal(plain, "is 2 a decent spot for a fantasy draft?", "no media, no hook, nothing added");

  // 4. a video link still hints, and doesn't pick up the audio hook.
  const link = bundle([{ text: "https://www.tiktok.com/@x/video/123", media: [] }]);
  assert.match(link, /tiktok link is in this message/);
  assert.doesNotMatch(link, /native iMessage audio message/);

  // 5. the hook is prompt-only: nothing here is what gets logged or sent. bundle()'s output
  //    feeds runTurn; logInbound (index.ts) writes the raw inbound text, never this string.
  assert.ok(!voice.startsWith("[the owner sent this as a native"), "the modality hook is appended, never the whole turn");

  console.log("✓ bundle() hook injection");
}

/**
 * The /voice mode half: the SAME bundle() call site, but the hook is standing rather than
 * per-message. The thing that matters here is the case the inbound-audio default can't
 * reach — a background/proactive turn with no inbound audio (no media at all) still comes
 * out spoken, because that's the entire gap the mode exists to close.
 */
function voiceModeBundling(): void {
  const transport = { send: async () => null } as unknown as Transport;
  const convo = new Conversation(transport, "+15555550123") as any;
  const bundle = (batch: unknown[], transcripts?: unknown[]): string => convo.bundle(batch, transcripts);

  try {
    setVoiceMode(true);

    // 1. a plain TYPED message now gets the standing hook — the per-message default never would.
    const typed = bundle([{ text: "how'd the build go", media: [] }]);
    assert.match(typed, /\/voice mode is ON/, "mode injects on a text-only turn");
    assert.match(typed, /mcp__tts__speak/, "names the same tool the inbound-audio hook does");
    assert.match(typed, /alone on its own line/i, "and the same native-audio send path");
    assert.match(typed, /how'd the build go/, "their actual message still leads the bundle");

    // 2. THE point of the mode: a background job result — nobody sent audio, nothing to
    //    match — is spoken anyway. This is the exact turn that fell back to text before.
    const bg = bundle([{ text: "[background job claude-code-10 finished] fix committed", media: [], background: true }]);
    assert.match(bg, /\/voice mode is ON/, "a proactive/background turn is spoken too");
    assert.match(bg, /a finished background job/, "and the hook names that case explicitly");

    // 3. the two exceptions are carried in the instruction, since only the model knows which applies.
    assert.match(typed, /screen-bound/, "exception 1: code/paths/links/lists stay text");
    assert.match(typed, /acks\./i, "exception 2: the ack tool is untouched");
    assert.match(typed, /never render an ack as audio/i);

    // 4. exactly one modality hook — the standing one REPLACES the per-message default
    //    rather than stacking a second, contradictory instruction on top of it.
    const withNote = bundle(
      [{ text: "￼", media: [REAL_AUDIO_MSG] }],
      [{ path: REAL_AUDIO_MSG, ok: true, text: "check the rent portal" }],
    );
    assert.match(withNote, /\/voice mode is ON/);
    assert.doesNotMatch(withNote, /native iMessage audio message \(the waveform bubble\)/, "no doubled hook");
    assert.match(withNote, /check the rent portal/, "the transcript is still the message fig reads");
  } finally {
    setVoiceMode(false);
  }

  // 5. toggled back off → byte-identical to life before this existed.
  const after = bundle([{ text: "how'd the build go", media: [] }]);
  assert.equal(after, "how'd the build go", "mode off adds literally nothing");

  console.log("✓ bundle() /voice mode injection");
}

function regression(): void {
  // The existing link hints must keep working exactly as they did.
  assert.deepEqual(videoLinkHints(""), []);
  assert.equal(videoLinkHints("watch https://youtu.be/abc").length, 1);
  assert.equal(videoLinkHints("no links here").length, 0);
  console.log("✓ video-link hints unchanged");
}

async function main(): Promise<void> {
  ({ audioMessageHint, audioNoteTranscriptBlock, isAudioMessagePath, partitionAudioNotes, videoLinkHints } =
    await import("./media-hints"));
  ({ setVoiceMode } = await import("../core/voiceMode"));
  ({ Conversation } = await import("../session/session"));
  try {
    detection();
    partitioning();
    transcriptBlock();
    bundling();
    voiceModeBundling();
    regression();
    console.log("✓ media-hints tests passed");
  } finally {
    fs.rmSync(TMP_BRAIN, { recursive: true, force: true });
  }
}

void main();
