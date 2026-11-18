// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which files a message may bring: the allowlist of sent-file types, a sent file's type (Teams' `fileType`, else the
 * extension of its name), why a file is refused for its type, and what a pasted image's bytes say it is.
 *
 * A pasted image is never judged by a type it claims: its bytes are checked once fetched (`imageType`), and only PNG,
 * JPEG, GIF and WebP are taken.
 */
import { pyStrip, type InboundFile } from "@primusclaw/personal-agent";

/**
 * What a file sent in a chat may be: text, logs, data, code, documents, images, audio, video and the common archives of
 * them. Not on it: programs and installers (exe, msi, dll, apk, jar, ...), Windows scripts and shortcuts (bat, cmd,
 * ps1, vbs, lnk, ...), disk images, Office files with macros (docm, xlsm, ...), and anything without a type.
 */
export const ALLOWED_FILE_TYPES: ReadonlySet<string> = new Set([
  // text, logs and data
  ...["txt", "text", "md", "markdown", "rst", "adoc", "tex", "log", "out", "err", "csv", "tsv", "json", "jsonl"],
  ...["ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "xml", "html", "htm", "css", "scss"],
  ...["sass", "less", "sql", "ipynb", "diff", "patch", "graphql", "gql", "parquet", "arrow", "feather", "npy"],
  ...["npz", "h5", "hdf5"],
  // source code
  ...["py", "pyi", "js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "svelte", "go", "rs", "java", "kt", "kts", "scala"],
  ...["groovy", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "cu", "cuh", "cs", "fs", "vb", "rb", "php", "pl", "lua"],
  ...["r", "jl", "swift", "m", "mm", "dart", "ex", "exs", "erl", "hs", "ml", "clj", "sh", "bash", "zsh", "fish"],
  ...["mk", "cmake", "gradle", "proto", "tf", "hcl"],
  // documents
  ...["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "epub"],
  // images, audio and video
  ...["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg", "ico"],
  ...["mp3", "wav", "m4a", "ogg", "flac", "mp4", "mov", "webm", "mkv"],
  // archives
  ...["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z"],
]);

/** What a pasted image's bytes must be (`imageType`). */
export const PASTED_IMAGE_TYPES: readonly string[] = ["png", "jpg", "gif", "webp"];

const SNIFF: readonly (readonly [readonly number[], string])[] = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "png"],
  [[0xff, 0xd8, 0xff], "jpg"],
  [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], "gif"], // GIF87a
  [[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "gif"], // GIF89a
];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
  return bytes.length >= at + magic.length && magic.every((byte, i) => bytes[at + i] === byte);
}

/** The image type the bytes say ("png", "jpg", "gif", "webp"), or "" when they are none of those. */
export function imageType(bytes: Uint8Array): string {
  const found = SNIFF.find(([magic]) => startsWith(bytes, magic));
  if (found !== undefined) return found[1];
  return startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8) ? "webp" : "";
}

/** Whether a file is an image pasted into the message (fetched with the bot's token), not a sent file. */
export function isPasted(file: InboundFile): boolean {
  return file.handle["kind"] === "pasted";
}

const ASCII_ALNUM = /^[A-Za-z0-9]+$/;

/** A sent file's type: Teams' `fileType`, else the extension of its name ("" none). A pasted image is typed by its bytes. */
export function fileType(file: InboundFile): string {
  if (file.type) return file.type;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) return "";
  const stem = file.name.slice(0, dot);
  const ext = file.name.slice(dot + 1);
  return pyStrip(stem) && ASCII_ALNUM.test(ext) ? ext.toLowerCase() : "";
}

/** Why a file is not taken for its type ("" when it is): the user is told this, then the types that are. */
export function refusedType(file: InboundFile): string {
  if (isPasted(file)) return ""; // a pasted image: its bytes are checked once fetched (`imageType`)
  const kind = fileType(file);
  if (ALLOWED_FILE_TYPES.has(kind)) return "";
  const head = kind ? `files of type .${kind} are not taken` : "a file without a type is not taken";
  return `${head}; text, logs, data, code, documents, images, audio, video and archives are`;
}
