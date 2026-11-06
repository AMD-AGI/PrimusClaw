// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The images a person sent with the message a run answers (`request.prompt_images`), shown to the model with the prompt.
 *
 * An assistant's router turn has no sandbox, so it cannot `read` a picture the way a worker does. The channel uploaded
 * the picture to the session's own files (`.uploads/...`); the API names it on the request, and Brain reads it from the
 * session's object-store prefix and puts it beside the prompt as an Anthropic image block -- the same block `read` puts in
 * a tool result, kept and dropped by the same history bound (`boundHistoryImages`) and the same refusal fallback.
 *
 * Only what is under the session's own `.uploads/` is read, and only the bytes decide what an image is: a file that is
 * not a whole PNG, JPEG, GIF or WebP of at most IMAGE_MAX_BYTES is named in a line, never sent, so one damaged picture
 * cannot fail the turn.
 */
import { IMAGE_MAX_BYTES, imageMediaType, imageWellFormed } from "@claw/protocol";
import pino from "pino";
import type { ToolImage } from "../clients/hands.js";
import { HISTORY_IMAGE_MAX_BASE64 } from "../llm/tool-images.js";

const logger = pino({ name: "prompt-images" });

/** At most this many images go with one prompt; the rest are named in a line. */
export const PROMPT_IMAGES_MAX = 4;
/**
 * At most this much base64 of images goes with one prompt: what the conversation keeps of images at all (`boundHistoryImages`, which
 * runs only after a tool result), so a message with several large pictures neither outgrows a checkpoint nor the request.
 */
export const PROMPT_IMAGES_MAX_BASE64 = HISTORY_IMAGE_MAX_BASE64;

/** The upload directory a prompt image must be under (as `POST /v1/sessions/:id/upload` stores it). */
const UPLOADS = ".uploads/";

/**
 * The path as a key below the session's prefix, or null when it is not one: relative, under `.uploads/`, no `..` or empty
 * segment, no backslash and no control character. What the request says is not trusted to stay inside the session.
 */
export function promptImagePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 1024 || !raw.startsWith(UPLOADS)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  const segments = raw.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments.length >= 2 ? raw : null;
}

export interface PromptImages {
  images: ToolImage[];
  /** One line for each image that is not shown, with why: the model is told rather than left to guess. */
  notes: string[];
}

/** The name of the file, for a line the model reads. */
const shown = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Read the request's prompt images under `sessionPrefix` (`users/<owner>/sessions/<id>/`). `read` returns the object's
 * bytes, `null` when it is missing, or `"too_large"` past the bound. Never throws: an image that cannot be read is a note.
 */
export async function loadPromptImages(
  paths: unknown, sessionPrefix: string,
  read: (key: string, maxBytes: number) => Promise<Buffer | null | "too_large">,
): Promise<PromptImages> {
  const out: PromptImages = { images: [], notes: [] };
  let base64 = 0;
  if (!Array.isArray(paths)) return out;
  for (const raw of paths) {
    const path = promptImagePath(raw);
    if (!path) {
      logger.warn("prompt_images.path_refused");
      continue;
    }
    if (out.images.length >= PROMPT_IMAGES_MAX) {
      out.notes.push(`[image ${shown(path)} not shown: at most ${PROMPT_IMAGES_MAX} images go with one message]`);
      continue;
    }
    let bytes: Buffer | null | "too_large";
    try {
      bytes = await read(`${sessionPrefix}${path}`, IMAGE_MAX_BYTES);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "prompt_images.read_failed");
      out.notes.push(`[image ${shown(path)} not shown: it could not be read just now]`);
      continue;
    }
    if (bytes === null) {
      out.notes.push(`[image ${shown(path)} not shown: it is no longer stored]`);
      continue;
    }
    if (bytes === "too_large") {
      out.notes.push(`[image ${shown(path)} not shown: it is larger than ${IMAGE_MAX_BYTES} bytes]`);
      continue;
    }
    const mediaType = imageMediaType(bytes);
    if (!mediaType || !imageWellFormed(bytes, mediaType)) {
      out.notes.push(`[image ${shown(path)} not shown: it is not a whole PNG, JPEG, GIF or WebP image]`);
      continue;
    }
    const data = bytes.toString("base64");
    if (base64 + data.length > PROMPT_IMAGES_MAX_BASE64) {
      out.notes.push(`[image ${shown(path)} not shown: the images of one message are shown up to ${PROMPT_IMAGES_MAX_BASE64} bytes of base64 together]`);
      continue;
    }
    base64 += data.length;
    out.images.push({ mediaType, data });
  }
  return out;
}

/** The prompt's content: the text alone when there is no image, else the text (and the notes) followed by the images. */
export function promptContent(text: string, loaded: PromptImages): string | Array<Record<string, unknown>> {
  const withNotes = loaded.notes.length ? `${text}\n\n${loaded.notes.join("\n")}` : text;
  if (!loaded.images.length) return withNotes;
  return [
    { type: "text", text: withNotes },
    ...loaded.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
  ];
}
