// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Files the agent delivered. Brain's `deliver_file` copies a sandbox file for the user and says so on the tool's terminal
 * toolUsed event (`delivery`: id, name, size, content_type, caption, and for a small image `data_base64`). Claw serves the
 * file to the signed-in owner of the session only, so the link is the requester's whoever else sees it.
 */

import { turnEnglish } from "../locales/turn.js";
import { fixedN, pyStrip } from "../text/py-text.js";
import { clip, plain, SUMMARY_MAX } from "./clip.js";
import { isObject, type JsonObject } from "./json.js";

export const DELIVER_TOOL = "deliver_file";
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DELIVERY_NAME_MAX = 200;
/** Files shown for one turn; a turn that delivers more is told to zip them by the tool's own wording. */
export const DELIVERIES_MAX = 5;
export const INLINE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif"];
/** A message of about 28 KB is refused, so an image is shown only as a data URI that fits. */
export const INLINE_IMAGE_MAX_BYTES = 15_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface Delivery {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly caption: string;
  /** A data URI of the image itself, when it came along and is one the chat can show; '' otherwise. */
  readonly image: string;
}

/**
 * The length of what Python's `base64.b64decode(data, validate=True)` decodes `data` to; undefined where it raises (a
 * character outside the alphabet, or a length that is not whole quads).
 */
function decodedLength(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** The data URI of a small image the event carried: only a type the chat draws, at most the cap, exactly the stated size. */
function inlineImage(raw: JsonObject, size: number, contentType: string): string {
  const data = raw["data_base64"];
  if (!INLINE_IMAGE_TYPES.includes(contentType) || typeof data !== "string" || !data) return "";
  if (data.length > Math.floor((INLINE_IMAGE_MAX_BYTES + 2) / 3) * 4) return "";
  return decodedLength(data) === size ? `data:${contentType};base64,${data}` : "";
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * The file a successful `deliver_file` call delivered, from its terminal toolUsed event; undefined for anything else, and
 * for a delivery that does not say what it is (an id that is not one, no name, no size).
 */
export function deliveryOf(tool: string, status: string, data: JsonObject): Delivery | undefined {
  if (pyStrip(tool) !== DELIVER_TOOL || status !== "success") return undefined;
  const raw = data["delivery"];
  if (!isObject(raw)) return undefined;
  const { id, name, size } = raw;
  if (typeof id !== "string" || !DELIVERY_ID.test(id)) return undefined;
  if (typeof name !== "string" || !pyStrip(name) || !isSize(size)) return undefined;
  const declared = typeof raw["content_type"] === "string" ? pyStrip(raw["content_type"]).toLowerCase() : "";
  const contentType = declared || "application/octet-stream";
  return {
    id,
    name: clip(name, DELIVERY_NAME_MAX),
    size,
    contentType,
    caption: clip(raw["caption"], SUMMARY_MAX),
    image: inlineImage(raw, size, contentType),
  };
}

/**
 * The files an assistant message hands the user (Claw's `files`), as (the worker session the download is under, the file),
 * read as strictly as a turn's `deliver_file` event: a file that does not say what it is, or names no session, is left out.
 */
export function assistantDeliveries(event: JsonObject): Array<readonly [string, Delivery]> {
  const raw = event["files"];
  const out: Array<readonly [string, Delivery]> = [];
  for (const file of Array.isArray(raw) ? raw : []) {
    if (!isObject(file)) continue;
    const sessionId = file["session_id"];
    const delivery = deliveryOf(DELIVER_TOOL, "success", { delivery: file });
    if (!delivery || typeof sessionId !== "string" || !pyStrip(sessionId)) continue;
    out.push([sessionId, delivery]);
    if (out.length >= DELIVERIES_MAX) break;
  }
  return out;
}

/** A size as a file manager says it: "512 B", "1.5 KB", "12 MB". */
export function sizeText(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  let scaled = size;
  for (const unit of ["KB", "MB", "GB"]) {
    scaled /= 1024;
    if (scaled < 1024 || unit === "GB")
      return scaled < 10 ? `${fixedN(scaled, 1)} ${unit}` : `${fixedN(scaled, 0)} ${unit}`;
  }
  return "";
}

/** A group chat's line for a delivered file: its name and the link, which only the person who asked can open. */
export function deliveryLine(delivery: Delivery, url: string): string {
  const caption = delivery.caption ? ` — ${plain(delivery.caption)}` : "";
  return turnEnglish.deliveryLine(plain(delivery.name), sizeText(delivery.size), caption, url);
}
