// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

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

/**
 * Whether the file is whole in the way its format says it must be: a PNG's chunks
 * run to IEND with good CRCs, a JPEG has a frame header and ends with EOI, a GIF
 * ends with its trailer, a WebP's RIFF size is the file's. Not a decoder, but the
 * model API refuses an image it cannot decode ("Could not process image") and
 * fails the turn, so a truncated or fake file is caught here instead.
 */
function wellFormed(b: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    let at = 8;
    let first = true;
    while (at + 12 <= b.length) {
      const len = b.readUInt32BE(at);
      const type = b.toString("latin1", at + 4, at + 8);
      if (at + 12 + len > b.length) return false;
      if (first && type !== "IHDR") return false;
      first = false;
      if ((zlib.crc32(b.subarray(at + 4, at + 8 + len)) >>> 0) !== b.readUInt32BE(at + 8 + len)) return false;
      if (type === "IEND") return true;
      at += 12 + len;
    }
    return false;
  }
  if (mimeType === "image/jpeg") {
    if (b.length < 4 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return false;
    let at = 2;
    while (at + 4 <= b.length && b[at] === 0xff) {
      const marker = b[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return true;   // SOFn
      if (marker === 0xda) return false;   // scan data before any frame header
      at += 2 + b.readUInt16BE(at + 2);
    }
    return false;
  }
  if (mimeType === "image/gif") return b.length > 13 && b[b.length - 1] === 0x3b;
  if (mimeType === "image/webp") return b.length >= 20 && b.readUInt32LE(4) + 8 === b.length;
  return false;
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
  const mimeType = sniff(bytes);
  if (!mimeType) return failed(`Error: ${shownPath} is not a PNG, JPEG, GIF or WebP image.`);
  if (!wellFormed(bytes, mimeType)) return failed(`Error: ${shownPath} is a damaged or incomplete ${mimeType.slice(6).toUpperCase()} file.`);
  return {
    content: [
      { type: "text", text: `Image ${shownPath} (${mimeType}, ${bytes.length} bytes)` },
      { type: "image", data: bytes.toString("base64"), mimeType },
    ],
  };
}
