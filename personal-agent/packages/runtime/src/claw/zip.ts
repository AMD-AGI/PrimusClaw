// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { inflateRawSync } from "node:zlib";

/** One file of a zip archive, as its central directory lists it. */
export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /** The uncompressed size the archive declares. */
  readonly size: number;
  /** The file's bytes (read on demand: a file is only inflated when it is wanted). */
  read(): Uint8Array;
}

/** Not a zip archive this reader understands (Python's `zipfile.is_zipfile` false, or a damaged archive). */
export class NotAZip extends Error {
  override readonly name = "NotAZip";
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The end-of-central-directory record: at the end, after at most a 64 KiB comment. */
function findEnd(view: DataView): number {
  const last = view.byteLength - 22;
  for (let at = last; at >= 0 && at >= last - 0xffff; at--) {
    if (view.getUint32(at, true) === EOCD) return at;
  }
  throw new NotAZip("no end of central directory");
}

/** The files a zip archive lists, stored or deflated (the two methods a rule download uses). */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22) throw new NotAZip("too short");
  const end = findEnd(view);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CENTRAL) throw new NotAZip("bad central directory");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      size,
      read: () => readLocal(bytes, view, local, method, compressed, size),
    });
    at += 46 + skip;
  }
  return entries;
}

/**
 * One file's bytes, exactly as large as the archive declares: a file that inflates to more is refused before more than
 * that is produced (the declared size is what a caller's limit was checked against), and one that is shorter as well.
 */
function readLocal(
  bytes: Uint8Array,
  view: DataView,
  at: number,
  method: number,
  compressed: number,
  size: number,
): Uint8Array {
  if (at + 30 > bytes.byteLength || view.getUint32(at, true) !== LOCAL) throw new NotAZip("bad local header");
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + compressed);
  let out: Uint8Array;
  if (method === 0) out = data;
  else if (method === 8) out = inflateAtMost(data, size);
  else throw new NotAZip(`compression method ${String(method)}`);
  if (out.byteLength !== size) throw new NotAZip("a file that is not the size the archive declares");
  return out;
}

function inflateAtMost(data: Uint8Array, size: number): Uint8Array {
  try {
    return new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }));
  } catch {
    throw new NotAZip("a file that inflates past its declared size, or not at all");
  }
}
