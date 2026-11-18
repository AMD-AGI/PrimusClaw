// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What makes a file an image a model may be shown.
 *
 * Two readers: Hands' `read` of a picture in the sandbox, and Brain showing the
 * images a person sent with a message (`prompt_images`). One definition, because
 * the model API refuses an image it cannot decode and fails the turn: a second
 * copy of these checks that drifted would let through what the other refuses.
 */
import zlib from "node:zlib";

/**
 * The largest image passed on, in bytes before encoding. The model API refuses an
 * image over 5 MB as base64, which is 4/3 of this, and an image travels in the
 * run's checkpoint until it is dropped from the history, so the bound is kept
 * below the limit rather than at it.
 */
export const IMAGE_MAX_BYTES = 3_500_000;

/** The names a model is shown as images (by their bytes, not by the name: see `imageMediaType`). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** The media type the bytes say, not the name: a `.png` that is really a JPEG is sent as a JPEG. Null for anything else. */
export function imageMediaType(head: Uint8Array): string | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
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
export function imageWellFormed(bytes: Uint8Array, mimeType: string): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
