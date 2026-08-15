import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { log, warn } from "../core/log";
import { proactiveOwnerTarget } from "../core/owner";
import { logOutbound } from "../session/transcript";
import type { Transport } from "../transport";

let transport: Transport | null = null;
let owner = "";
// Kept fresh from each inbound message so imsg can route the attachment by chat guid
// (sending to a chat guid is more reliable than by phone number alone).
let ownerChatGuid: string | undefined;

export function setImageSink(t: Transport, ownerNumber: string): void {
  transport = t;
  owner = ownerNumber;
}

/** Update the owner's current chat guid from the most recent inbound message. */
export function updateImageSinkChatGuid(chatGuid: string | undefined): void {
  ownerChatGuid = chatGuid;
}

/** Send a generated image directly to the owner as a real iMessage attachment. */
export async function sendImageToOwner(b64: string, mime: string, filename: string): Promise<void> {
  if (!transport) {
    warn("image sink: transport not set — dropping image");
    return;
  }
  await transport.send(proactiveOwnerTarget() || owner, "", {
    mediaBase64: b64,
    mediaMime: mime,
    mediaFilename: filename,
    chatGuid: ownerChatGuid,
  });
  logOutbound(`[image: ${filename}]`);
}

// Best-effort MIME by extension for arbitrary files (docs, pdfs, archives, etc.).
// iMessage only needs a sane content-type; octet-stream is a safe fallback.
const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".tex": "text/x-tex",
  ".rtf": "application/rtf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

const MAX_FILE_BYTES = 95 * 1024 * 1024; // iMessage attachment ceiling, with margin

/**
 * Build the SendOptions attachment fields for a local file, or null if it can't be sent
 * as one (missing, not a file, empty, oversized, unreadable). No-throw so the delivery
 * layer can attempt an attach and cleanly fall back to sending the path as text. Mirrors
 * sendFileToOwner's checks but returns the opts instead of firing the send, so it works
 * for any recipient — used to auto-attach a bare file-path bubble in a normal reply.
 * Expands a leading `~` to the home dir (path.resolve won't).
 */
export function fileAttachmentOpts(
  localPath: string,
): { mediaBase64: string; mediaMime: string; mediaFilename: string } | null {
  try {
    const abs = path.resolve(localPath.trim().replace(/^~(?=\/)/, os.homedir()));
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
    const ext = path.extname(abs).toLowerCase();
    const mime = EXT_MIME[ext] || "application/octet-stream";
    const filename = path.basename(abs).replace(/[/\\]/g, "_");
    const b64 = fs.readFileSync(abs).toString("base64");
    return { mediaBase64: b64, mediaMime: mime, mediaFilename: filename };
  } catch {
    return null;
  }
}

/**
 * Send an arbitrary file from disk to the owner as a real iMessage attachment.
 * Reads the bytes, infers a MIME type, and pushes through the same /send-file path
 * the image sink uses. Throws on a missing/oversized file so the tool can report it.
 */
export async function sendFileToOwner(localPath: string, displayName?: string): Promise<string> {
  if (!transport) throw new Error("transport not set — can't send file");
  const abs = path.resolve(localPath);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`not a file: ${abs}`);
  if (stat.size === 0) throw new Error(`file is empty: ${abs}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`file is ${(stat.size / 1024 / 1024).toFixed(1)}MB — over the ~95MB iMessage limit`);
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = EXT_MIME[ext] || "application/octet-stream";
  const filename = (displayName?.trim() || path.basename(abs)).replace(/[/\\]/g, "_");
  const b64 = fs.readFileSync(abs).toString("base64");
  log(`send_file FIRED → ${filename} (${stat.size}B, b64len=${b64.length}, chat=${ownerChatGuid ?? "phone-only"})`);
  await transport.send(proactiveOwnerTarget() || owner, "", {
    mediaBase64: b64,
    mediaMime: mime,
    mediaFilename: filename,
    chatGuid: ownerChatGuid,
  });
  log(`send_file POST returned (no throw) → ${filename}`);
  logOutbound(`[file: ${filename}]`);
  return filename;
}

// Extensions send_carousel accepts — a photo deck should be photos, not docs.
const CAROUSEL_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]);

/**
 * Send a set of images to the owner as a photo deck. imsg (0.11.1) attaches only
 * ONE file per send — repeated --file flags are last-wins on every send command,
 * and send-multipart's file parts are unimplemented — so true single-message
 * bundling isn't possible. Closest equivalent: attachment-only sends fired
 * back-to-back with no text between, which Messages groups into an adjacent photo
 * run in the thread. Validates every path up front so a bad one never leaves a
 * half-sent deck. Returns the number of images sent.
 */
export async function sendCarouselToOwner(paths: string[], caption?: string): Promise<number> {
  if (!transport) throw new Error("transport not set — can't send carousel");
  if (paths.length < 2 || paths.length > 10) {
    throw new Error(`carousel needs 2-10 images, got ${paths.length}`);
  }
  const resolved = paths.map((p) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
    if (!fs.statSync(abs).isFile()) throw new Error(`not a file: ${abs}`);
    const ext = path.extname(abs).toLowerCase();
    if (!CAROUSEL_IMAGE_EXTS.has(ext)) {
      throw new Error(`not an image (${ext || "no extension"}): ${abs}`);
    }
    return abs;
  });
  for (const abs of resolved) await sendFileToOwner(abs);
  const tail = caption?.trim();
  if (tail) {
    await transport.send(proactiveOwnerTarget() || owner, tail, { chatGuid: ownerChatGuid });
    logOutbound(tail);
  }
  return resolved.length;
}
