// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files an assistant message hands the person (Claw's `files`: a work item's worker delivered them with Brain's
 * `deliver_file`), read as strictly as a turn's delivery is (teams_agent/render.py Delivery, delivery_of, assistant_deliveries).
 * Claw serves a file to the signed-in owner of its session only, so its link is the requester's whoever else sees it.
 */
import { z } from "zod";

import { clip } from "../text/plain.js";
import { pyStr, pyStrip } from "../text/py-text.js";

export const DELIVER_TOOL = "deliver_file";
export const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DELIVERY_NAME_MAX = 200;
export const CAPTION_MAX = 280;
/** Files shown for one turn; a turn that delivers more is told to zip them by the tool's own wording. */
export const DELIVERIES_MAX = 5;
export const INLINE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif"];
/**
 * Teams refuses a message of about 28 KB and cannot fetch an image behind a sign-in, so an image is shown only as a data URI
 * that fits: base64 makes it a third larger, and the card around it needs the rest.
 */
export const INLINE_IMAGE_MAX_BYTES = 15_000;

/** One delivered file. `image` is a data URI of the image itself, when it came along and is one Teams can show (else ""). */
export interface Delivery {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly caption: string;
  readonly image: string;
}

const rawDelivery = z.looseObject({
  id: z.string().regex(DELIVERY_ID),
  name: z.string().refine((name) => pyStrip(name) !== ""),
  size: z.number().int().nonnegative(),
  content_type: z.unknown().optional(),
  caption: z.unknown().optional(),
  data_base64: z.unknown().optional(),
});

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The decoded length of strict base64 (`b64decode(validate=True)`), or undefined when it is not that. */
function decodedLength(data: string): number | undefined {
  if (!BASE64.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** The data URI of a small image the event carried: a type Teams draws, at most the cap, exactly the stated size; "" otherwise. */
function inlineImage(data: unknown, size: number, contentType: string): string {
  if (!INLINE_IMAGE_TYPES.includes(contentType) || typeof data !== "string" || !data) return "";
  if (data.length > Math.floor((INLINE_IMAGE_MAX_BYTES + 2) / 3) * 4) return ""; // (never decoded past the cap)
  return decodedLength(data) === size ? `data:${contentType};base64,${data}` : "";
}

/**
 * The file a successful `deliver_file` call delivered, from its terminal toolUsed event; null for anything else, and for a
 * delivery that does not say what it is (an id that is not one, no name, no size).
 */
export function deliveryOf(tool: string, status: string, data: Readonly<Record<string, unknown>>): Delivery | null {
  if (pyStrip(tool) !== DELIVER_TOOL || status !== "success") return null;
  const raw = data["delivery"];
  const parsed = rawDelivery.safeParse(raw);
  if (!parsed.success || typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { id, name, size } = parsed.data;
  const given = typeof parsed.data.content_type === "string" ? pyStrip(parsed.data.content_type).toLowerCase() : "";
  const contentType = given || "application/octet-stream";
  return {
    id,
    name: clip(name, DELIVERY_NAME_MAX),
    size,
    contentType,
    caption: clip(pyStr(parsed.data.caption), CAPTION_MAX),
    image: inlineImage(parsed.data.data_base64, size, contentType),
  };
}

/** One file an assistant message hands the person, under the worker session the download is under. */
export interface SessionDelivery {
  readonly sessionId: string;
  readonly delivery: Delivery;
}

/**
 * The files an assistant message hands the person (Claw's `files`), read as strictly as a turn's `deliver_file` event: a file
 * that does not say what it is, or names no session, is left out. At most DELIVERIES_MAX.
 */
export function assistantDeliveries(event: Readonly<Record<string, unknown>>): SessionDelivery[] {
  const raw = event["files"];
  const out: SessionDelivery[] = [];
  for (const file of Array.isArray(raw) ? (raw as unknown[]) : []) {
    if (typeof file !== "object" || file === null || Array.isArray(file)) continue;
    const sessionId = (file as Record<string, unknown>)["session_id"];
    const delivery = deliveryOf(DELIVER_TOOL, "success", { delivery: file });
    if (delivery === null || typeof sessionId !== "string" || !pyStrip(sessionId)) continue;
    out.push({ sessionId, delivery });
    if (out.length >= DELIVERIES_MAX) break;
  }
  return out;
}
