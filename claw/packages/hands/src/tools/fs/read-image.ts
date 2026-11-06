// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { IMAGE_EXTENSIONS, IMAGE_MAX_BYTES, imageMediaType, imageWellFormed } from "@claw/protocol";

/** What `read` answers for an image: the picture, for a model that can see it. */
type ImageResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

/** The largest image passed on (the one definition is `@claw/protocol` images.ts, shared with Brain's prompt images). */
export { IMAGE_MAX_BYTES };

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
  let fd: number | undefined;
  try {
    // One open file for the size and the read, so the size checked is the size of what is read.
    fd = fs.openSync(safePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size > IMAGE_MAX_BYTES) {
      return failed(
        `Error: ${shownPath} is ${size} bytes; an image is shown only up to ${IMAGE_MAX_BYTES} bytes. `
        + "Make a smaller copy (scale it down or save it as JPEG) and read that.",
      );
    }
    bytes = fs.readFileSync(fd);
  } catch (e: any) {
    return failed(`Error reading ${shownPath}: ${e.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (bytes.length > IMAGE_MAX_BYTES) return failed(`Error: ${shownPath} grew past ${IMAGE_MAX_BYTES} bytes while it was read.`);
  const mimeType = imageMediaType(bytes);
  if (!mimeType) return failed(`Error: ${shownPath} is not a PNG, JPEG, GIF or WebP image.`);
  if (!imageWellFormed(bytes, mimeType)) return failed(`Error: ${shownPath} is a damaged or incomplete ${mimeType.slice(6).toUpperCase()} file.`);
  return {
    content: [
      { type: "text", text: `Image ${shownPath} (${mimeType}, ${bytes.length} bytes)` },
      { type: "image", data: bytes.toString("base64"), mimeType },
    ],
  };
}
