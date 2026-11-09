// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The name a fetched file is uploaded under: one path component Claw's upload takes as it is (no directory, no "..", no
 * leading dot, at most 100 characters). A pasted image has no name and is called image-<n> with the extension its bytes
 * say.
 */
import { imageType } from "./types.js";

/** Everything but ASCII letters, digits, ".", "_", " " and "-", a run at a time. */
const UNSAFE = /[^A-Za-z0-9._ -]+/gu;
const NAME_MAX = 100;

/** Python's `str.strip(" .")`. */
function stripSpacesAndDots(text: string): string {
  return text.replace(/^[ .]+/, "").replace(/[ .]+$/, "");
}

/** `name` made one safe path component; `bytes` and `index` (1-based) name a file that has none. */
export function safeName(name: string, bytes: Uint8Array, index: number): string {
  const last = name.replaceAll("\\", "/").split("/").pop() ?? "";
  let base = stripSpacesAndDots(last.replace(UNSAFE, "_").replaceAll("..", "_"));
  if (!base) {
    const ext = imageType(bytes);
    base = `image-${String(index)}${ext ? `.${ext}` : ""}`;
  }
  // Only ASCII is left, so a UTF-16 length is the code point count Python measures.
  if (base.length > NAME_MAX) {
    const dot = base.lastIndexOf(".");
    const ext = dot < 0 ? "" : base.slice(dot + 1);
    base = dot >= 0 && ext.length <= 9 ? `${base.slice(0, dot).slice(0, 90)}.${ext}` : base.slice(0, NAME_MAX);
  }
  return base;
}
