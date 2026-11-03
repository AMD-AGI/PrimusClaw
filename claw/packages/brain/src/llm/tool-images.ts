// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Message } from "@claw/protocol";
import type { ToolImage } from "../clients/hands.js";

/**
 * Images a tool answered with (`read` of a picture), on their way into the
 * conversation as Anthropic image blocks inside the `tool_result`.
 */

/**
 * How much image data, base64, the conversation keeps. The history travels in
 * every checkpoint, which has a 16 MiB ceiling, and an image is base64 that gzip
 * cannot shrink, so the newest images are kept up to this and older ones become
 * a line saying the file can be read again. One image `read` passes (Hands'
 * IMAGE_MAX_BYTES, 4.7 MB as base64) always fits.
 */
export const HISTORY_IMAGE_MAX_BASE64 = 6 * 1024 * 1024;

export const IMAGE_DROPPED_TEXT =
  "[image no longer shown: only the latest images stay in the conversation; read the file again to see it]";

/** A `tool_result`'s content: the text alone, or the text followed by the images. */
export function toolResultContent(text: string, images: ToolImage[] | undefined): string | Array<Record<string, unknown>> {
  if (!images?.length) return text;
  return [
    { type: "text", text },
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
  ];
}

function imageSize(block: Record<string, unknown>): number {
  const source = block.source as { data?: unknown } | undefined;
  return typeof source?.data === "string" ? source.data.length : 0;
}

/**
 * Keep the newest images within HISTORY_IMAGE_MAX_BASE64 and replace the rest,
 * newest first, with IMAGE_DROPPED_TEXT. Images in a tool result and in a user
 * message are counted alike. Changes `messages` in place; returns how many
 * images were dropped.
 */
export function boundHistoryImages(
  messages: Message[], maxBase64 = HISTORY_IMAGE_MAX_BASE64, replacement = IMAGE_DROPPED_TEXT,
): number {
  let kept = 0;
  let dropped = 0;
  const visit = (blocks: Array<Record<string, unknown>>): void => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block?.type === "tool_result" && Array.isArray(block.content)) {
        visit(block.content as Array<Record<string, unknown>>);
      } else if (block?.type === "image") {
        const size = imageSize(block);
        if (kept + size <= maxBase64) {
          kept += size;
        } else {
          blocks[i] = { type: "text", text: replacement };
          dropped++;
        }
      }
    }
  };
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m].content;
    if (Array.isArray(content)) visit(content);
  }
  return dropped;
}

/** A `tool_result`'s content as text, an image named by a placeholder (`note`). */
export function toolResultText(content: unknown, note = "[image]"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((b: Record<string, unknown>) => (b?.type === "text" ? String(b.text ?? "") : b?.type === "image" ? note : JSON.stringify(b)))
    .join("\n");
}

export const IMAGE_REFUSED_TEXT =
  "[image not shown: the model could not process it; the file may be damaged or not really an image]";

/**
 * Does this error say the model refused an image in the request? An image that
 * passed Hands' checks can still be one the API will not decode, and it stays in
 * the history that is replayed every turn, so the refusal would repeat until the
 * run ends. Matched on the wording the API answers with (measured through the
 * live proxy: "Could not process image").
 */
export function looksLikeImageRejection(err: unknown): boolean {
  let text: string;
  try {
    const e = err as Record<string, unknown> | null;
    text = [
      (e?.message as string) ?? "",
      typeof e?.error === "object" ? JSON.stringify(e.error) : String(e?.error ?? ""),
    ].join(" ");
  } catch {
    text = String(err);
  }
  return /could not process image|image (?:is )?(?:invalid|not valid|corrupt)|invalid image/i.test(text);
}
