// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";

/** What `read` answers for an image: the picture, for a model that can see it. */
type ImageResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * The largest image passed on, in bytes before encoding. The model API refuses an
 * image over 5 MB as base64, which is 4/3 of this, and an image travels in the
 * run's checkpoint until it is dropped from the history, so the bound is kept
 * below the limit rather than at it.
 */
export const IMAGE_MAX_BYTES = 3_500_000;

/** The media type the bytes say, not the name: a `.png` that is really a JPEG is sent as a JPEG. */
function sniff(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && (head.toString("latin1", 0, 6) === "GIF87a" || head.toString("latin1", 0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function failed(text: string): ImageResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * `read` of a file named as an image: the image as an MCP image block, with one
 * line naming it. Null for any other file, which `read` reads as text.
 */
export function readImage(safePath: string, shownPath: string): ImageResult | null {
  if (!IMAGE_EXTENSIONS.has(path.extname(safePath).toLowerCase())) return null;
  let bytes: Buffer;
  try {
    const size = fs.statSync(safePath).size;
    if (size > IMAGE_MAX_BYTES) {
      return failed(
        `Error: ${shownPath} is ${size} bytes; an image is shown only up to ${IMAGE_MAX_BYTES} bytes. `
        + "Make a smaller copy (scale it down or save it as JPEG) and read that.",
      );
    }
    bytes = fs.readFileSync(safePath);
  } catch (e: any) {
    return failed(`Error reading ${shownPath}: ${e.message}`);
  }
  const mimeType = sniff(bytes);
  if (!mimeType) return failed(`Error: ${shownPath} is not a PNG, JPEG, GIF or WebP image.`);
  return {
    content: [
      { type: "text", text: `Image ${shownPath} (${mimeType}, ${bytes.length} bytes)` },
      { type: "image", data: bytes.toString("base64"), mimeType },
    ],
  };
}
