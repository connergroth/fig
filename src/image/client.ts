import fs from "node:fs";
import path from "node:path";
import { restJson } from "../core/restJson";

const BASE = "https://api.openai.com/v1";

export function imageConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

function key(): string {
  const k = process.env.OPENAI_API_KEY?.trim();
  if (!k) throw new Error("Image generation isn't configured — set OPENAI_API_KEY.");
  return k;
}

export type Quality = "low" | "medium" | "high" | "auto";
export type Size = "1024x1024" | "1536x1024" | "1024x1536" | "auto";

export interface GenerateInput {
  prompt: string;
  /** Local file paths to use as input images (triggers /images/edits). */
  imagePaths?: string[];
  quality?: Quality;
  size?: Size;
}

export interface GenerateResult {
  /** Base64-encoded PNG. */
  b64: string;
  /** Mime type — always image/png from gpt-image-2. */
  mimeType: "image/png";
}

/** Generate or edit an image. Returns raw b64 PNG bytes. */
export async function generateImage(input: GenerateInput): Promise<GenerateResult> {
  return input.imagePaths?.length ? editImage(input) : textToImage(input);
}

async function textToImage(input: GenerateInput): Promise<GenerateResult> {
  const json = await restJson(`${BASE}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: input.prompt,
      size: input.size ?? "1024x1024",
      quality: input.quality ?? "medium",
      n: 1,
    }),
    errPrefix: "OpenAI text-to-image",
  });
  return extractB64(json, "text-to-image");
}

async function editImage(input: GenerateInput): Promise<GenerateResult> {
  const form = new FormData();
  form.append("model", "gpt-image-2");
  form.append("prompt", input.prompt);
  form.append("size", input.size ?? "1024x1024");
  form.append("quality", input.quality ?? "medium");
  form.append("n", "1");

  for (const p of input.imagePaths!) {
    const bytes = fs.readFileSync(p);
    const ext = path.extname(p).slice(1).toLowerCase() || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    const blob = new Blob([bytes], { type: mime });
    form.append("image[]", blob, path.basename(p));
  }

  const json = await restJson(`${BASE}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
    errPrefix: "OpenAI image-edit",
  });
  return extractB64(json, "image-edit");
}

function extractB64(json: any, ctx: string): GenerateResult {
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`OpenAI ${ctx}: no b64_json in response`);
  return { b64, mimeType: "image/png" };
}
