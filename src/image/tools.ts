import { z } from "zod";

import { defineServer, toSdkServer } from "../tools/define";
import { generateImage, imageConfigured } from "./client";
import { sendCarouselToOwner, sendFileToOwner, sendImageToOwner } from "./sink";
const NOT_CONFIGURED = "Image generation isn't set up — set OPENAI_API_KEY.";

export const imageServerDef = defineServer({
  key: "image",
  kind: "direct",
  purpose: "generate an image, or push a file/photo deck straight to the owner as a real iMessage attachment",
  exposure: "both",
  capabilities: [
    {
      name: "generate",
      purpose: "generate or edit an image with gpt-image-2 and send it to the owner as an attachment",
      mutates: "write",
      description:
        "Generate or edit an image using gpt-image-2, then send it directly to the owner as an iMessage attachment. For plain generation, just provide a prompt. To edit an image or use one as a reference, pass the local file path(s) from the attachment context. Returns a short confirmation once sent.",
      input: {
        prompt: z.string().describe("What to generate or how to edit the input image(s)."),
        image_paths: z
          .array(z.string())
          .optional()
          .describe(
            "Local file paths of attached images to use as input (for editing or reference). Pass paths from the [the owner attached ...] context. Omit for text-to-image.",
          ),
        quality: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("low ~$0.006, medium ~$0.05 (default), high ~$0.21"),
        size: z
          .enum(["1024x1024", "1536x1024", "1024x1536"])
          .optional()
          .describe("Default 1024x1024. Use 1536x1024 for landscape, 1024x1536 for portrait."),
      },
      handler: async (args) => {
        if (!imageConfigured()) return NOT_CONFIGURED;
        try {
          const result = await generateImage({
            prompt: args.prompt,
            imagePaths: args.image_paths,
            quality: (args.quality as any) ?? "medium",
            size: (args.size as any) ?? "1024x1024",
          });
          const filename = `image-${Date.now()}.png`;
          await sendImageToOwner(result.b64, result.mimeType, filename);
          return "Image sent.";
        } catch (e) {
          return `generate failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
    {
      name: "send_file",
      purpose: "send a file or image already on disk straight to the owner as a real iMessage attachment",
      mutates: "write",
      description:
        "Send a file that already exists on disk straight to the owner as a REAL iMessage attachment — the actual bytes land in their thread, never a link and never a path they'd have to go open. Images (png/jpg/heic — including a browser screenshot) arrive as a real inline photo they can just look at; documents (PDF, doc, spreadsheet, csv, txt, zip) arrive as a tappable file. Use it whenever the visual IS the answer and describing it in words would lose the information. This only sends something that already exists; it does not create or render anything. Returns a confirmation once sent.",
      input: {
        path: z.string().describe("Absolute local path of the file to send."),
        filename: z
          .string()
          .optional()
          .describe("Optional display name for the attachment (defaults to the file's basename)."),
      },
      handler: async (args) => {
        try {
          const sent = await sendFileToOwner(args.path, args.filename);
          return `Sent ${sent}.`;
        } catch (e) {
          return `send_file failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
    {
      name: "send_carousel",
      purpose: "send 2-10 images from disk to the owner as a back-to-back photo deck",
      mutates: "write",
      description:
        "Send 2-10 images from disk to the owner as a photo deck — real iMessage photos, not links or paths. Use it when the answer is a COMPARISON they have to see side by side (three seat maps, two checkout totals, a before/after). imsg attaches only one file per message, so the images go as attachment-only sends fired back-to-back with nothing between — Messages groups the consecutive photos in the thread (not a true single-message bundle). An optional caption is sent as a text immediately after the deck. Returns a confirmation with the count once all are sent.",
      input: {
        paths: z
          .array(z.string())
          .min(2)
          .max(10)
          .describe("Absolute local paths of the images to send, in order (2-10)."),
        caption: z.string().optional().describe("Optional text sent immediately after the images."),
      },
      handler: async (args) => {
        try {
          const count = await sendCarouselToOwner(args.paths, args.caption);
          return `Sent ${count} images as back-to-back attachment sends (imsg can't bundle multiple files into one message — Messages groups them in the thread).`;
        } catch (e) {
          return `send_carousel failed: ${e instanceof Error ? e.message : e}`;
        }
      },
    },
  ],
});

export const imageServer = toSdkServer(imageServerDef);
