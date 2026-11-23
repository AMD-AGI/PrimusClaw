// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files of a message to a session the chat is attached to (a coding agent on the person's own machine). A session
 * takes a prompt as text only, so a text file (a log, code, data, a document in plain text) is passed inline, after the
 * person's words, whole while the budget lasts and cut after that; a file that is not text cannot reach the session this
 * way and the person is told which ones did not, and why.
 */
import type { FetchedFile, FileRefused, InboundFile } from "../ports/surface.js";
import type { Result } from "../result.js";

/** The most bytes of files passed inline with one prompt (a session takes a prompt of at most 64 KiB, words included). */
export const INLINE_FILE_BYTES = 40 * 1024;

/** The most bytes of one prompt to a session: Claw takes at most 64 KiB; the rest is room for what frames it. */
export const SESSION_PROMPT_BYTES = 63 * 1024;

/** What is said where forwarded or quoted text was cut to fit one prompt. */
export const QUOTE_CUT =
  "\n… [cut: the rest of the forwarded and quoted messages did not fit in one message to the session]";

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The forwarded and quoted messages (`quote`) cut so that they and the person's words (`sent`) fit one prompt to a
 * session: the words are the person's and go whole; what others wrote is cut at its end, and says so.
 */
export function fitQuote(quote: string, sent: string): string {
  const room = SESSION_PROMPT_BYTES - (sent ? bytesOf(sent) + 2 : 0);
  if (bytesOf(quote) <= room) return quote;
  const head = room - bytesOf(QUOTE_CUT);
  return head > 0 ? headBytes(quote, head).trimEnd() + QUOTE_CUT : "";
}

/** The bytes of files that may follow `words` in one prompt to a session (at most `INLINE_FILE_BYTES`). */
export function roomAfter(words: string): number {
  return Math.max(0, Math.min(INLINE_FILE_BYTES, SESSION_PROMPT_BYTES - (words ? bytesOf(words) + 2 : 0)));
}

/** The file types passed inline: those whose bytes are text. */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  ...["txt", "text", "md", "markdown", "rst", "adoc", "tex", "log", "out", "err", "csv", "tsv", "json", "jsonl"],
  ...["ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "xml", "html", "htm", "css", "scss"],
  ...["sass", "less", "sql", "ipynb", "diff", "patch", "graphql", "gql", "py", "pyi", "js", "mjs", "cjs", "ts"],
  ...["tsx", "jsx", "vue", "svelte", "go", "rs", "java", "kt", "kts", "scala", "groovy", "c", "cc", "cpp", "cxx"],
  ...["h", "hh", "hpp", "cu", "cuh", "cs", "fs", "vb", "rb", "php", "pl", "lua", "r", "jl", "swift", "m", "mm"],
  ...["dart", "ex", "exs", "erl", "hs", "ml", "clj", "sh", "bash", "zsh", "fish", "mk", "cmake", "gradle", "proto"],
  ...["tf", "hcl"],
]);

const EXTENSION = /\.([A-Za-z0-9]{1,20})$/u;

/** The type a file is judged by: the one the channel gave, else the extension of its name ("" none). */
export function typeOf(file: Pick<InboundFile, "name" | "type">): string {
  if (file.type) return file.type.toLowerCase();
  return EXTENSION.exec(file.name)?.[1]?.toLowerCase() ?? "";
}

/** Whether a file is one passed inline: a text type (an image never is). */
export function passesInline(file: Pick<InboundFile, "name" | "type">): boolean {
  return TEXT_TYPES.has(typeOf(file));
}

/** What became of a message's files on their way to a session. */
export interface InlineFiles {
  /** The text that goes after the person's words ("" none). */
  readonly section: string;
  /** How many files it carries. */
  readonly passed: number;
  /** [name the person knows it by, why it did not reach the session]. */
  readonly notPassed: [name: string, why: string][];
}

export interface InlineWords {
  readonly notText: string;
  readonly notUtf8: string;
  readonly noRoom: string;
}

const WORDS: InlineWords = {
  notText: "a session takes text, and this is not a text file",
  notUtf8: "it is not UTF-8 text",
  noRoom: "the files before it filled what one message to a session takes",
};

/** The longest run of a fence character in `text`, so the file's own fences cannot close the one around it. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** `name` with each control character a space: a file's name cannot make a line of its own in the prompt. */
function oneLine(name: string): string {
  return Array.from(name, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? " " : ch;
  }).join("");
}

/** At most `bytes` bytes of UTF-8 `text`, never half a character. */
function headBytes(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, bytes)).replace(/�$/u, "");
}

/**
 * The files, fetched through `fetch` (only those passed inline are fetched), as the text that follows the person's
 * words to the session. `shown(file, i)` is the name the person knows file i (1-based) by.
 */
export async function inlineFiles(
  files: readonly InboundFile[],
  fetch: (file: InboundFile) => Promise<Result<FetchedFile, FileRefused>>,
  shown: (file: InboundFile, index: number) => string,
  budget = INLINE_FILE_BYTES,
): Promise<InlineFiles> {
  const blocks: string[] = [];
  const notPassed: [string, string][] = [];
  // (the budget is of the whole section: its lead, and each file's heading, fences and the blank line before it)
  let left = budget - bytesOf("The files sent with this message:");
  for (const [at, file] of files.entries()) {
    const name = shown(file, at + 1);
    if (!passesInline(file)) {
      notPassed.push([name, WORDS.notText]);
      continue;
    }
    if (left <= 0) {
      notPassed.push([name, WORDS.noRoom]);
      continue;
    }
    const got = await fetch(file);
    if (!got.ok) {
      notPassed.push([name, got.error.reason]);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(got.value.bytes);
    } catch {
      notPassed.push([name, WORDS.notUtf8]);
      continue;
    }
    if (text.includes("\u0000")) {
      notPassed.push([name, WORDS.notUtf8]);
      continue;
    }
    const size = got.value.bytes.length;
    const fence = fenceFor(text); // (the whole text's: at least as long as any part's needs)
    const line = oneLine(name);
    const frame = bytesOf(
      `\n\nFile ${line} (${String(size)} bytes, cut to its first ${String(size)}):\n${fence}\n\n${fence}`,
    );
    if (left - frame <= 0) {
      notPassed.push([name, WORDS.noRoom]);
      left = 0;
      continue;
    }
    const body = headBytes(text, left - frame);
    const kept = bytesOf(body);
    left = kept < size ? 0 : left - frame - kept; // (a file that was cut used the budget up)
    const cut = kept < size ? `, cut to its first ${String(kept)}` : "";
    blocks.push(`File ${line} (${String(size)} bytes${cut}):\n${fence}\n${body}\n${fence}`);
  }
  if (blocks.length === 0) return { section: "", passed: 0, notPassed };
  const lead = blocks.length === 1 ? "The file sent with this message:" : "The files sent with this message:";
  return { section: [lead, ...blocks].join("\n\n"), passed: blocks.length, notPassed };
}
