// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files of a message to a session the chat is attached to (a coding agent on the person's own machine). A text file
 * (a log, code, data, a document in plain text) is passed inline, after the person's words, whole while the budget lasts
 * and cut after that. Any other file (an image, a PDF) goes as a file where the session's machine takes files (the
 * connector saves it there and names its path in the prompt); where it does not, the person is told which ones did not
 * reach the session, and why.
 */
import type { FetchedFile, FileRefused, InboundFile } from "../ports/surface.js";
import type { Result } from "../result.js";

/** The most bytes of files passed inline with one prompt (a session takes a prompt of at most 64 KiB, words included). */
export const INLINE_FILE_BYTES = 40 * 1024;

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

/** The most files, and bytes of them in all, one prompt carries to a machine (the wire contract's limits). */
export const SESSION_FILES = 10;
export const SESSION_FILE_BYTES = 2 * 1024 * 1024;

/** What became of a message's files on their way to a session. */
export interface InlineFiles {
  /** The text that goes after the person's words ("" none). */
  readonly section: string;
  /** How many files it carries inline. */
  readonly passed: number;
  /** The files that go as files (the machine saves them and names them in the prompt): only where it `takesFiles`. */
  readonly files: FetchedFile[];
  /** [name the person knows it by, why it did not reach the session]. */
  readonly notPassed: [name: string, why: string][];
}

const WORDS = {
  notText: "a session takes text, and this is not a text file",
  notUtf8: "it is not UTF-8 text",
  noRoom: "the files before it filled what one message to a session takes",
  tooMany: `one message takes at most ${String(SESSION_FILES)} files to a session`,
  tooLarge: `one message takes at most ${String(SESSION_FILE_BYTES / 1024 / 1024)} MiB of files to a session`,
};

export interface InlineOptions {
  /** The most bytes of text passed inline. */
  readonly budget?: number;
  /** The session's machine takes files: a file that is not text goes as a file (fetched), not named back. */
  readonly asFiles?: boolean;
}

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

type Fetch = (file: InboundFile) => Promise<Result<FetchedFile, FileRefused>>;

/** The text of a fetched file, or why it is not text. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/** What one message's files have become so far, file by file. */
class Gathered {
  readonly blocks: string[] = [];
  readonly notPassed: [string, string][] = [];
  readonly files: FetchedFile[] = [];
  private fileBytes = 0;

  constructor(
    private left: number,
    private readonly fetch: Fetch,
  ) {}

  /** A file that is not text, to a machine that takes files: fetched, and kept within the wire's limits. */
  async asFile(file: InboundFile, name: string): Promise<void> {
    if (this.files.length >= SESSION_FILES) return void this.notPassed.push([name, WORDS.tooMany]);
    const got = await this.fetch(file);
    if (!got.ok) return void this.notPassed.push([name, got.error.reason]);
    if (this.fileBytes + got.value.bytes.length > SESSION_FILE_BYTES) {
      return void this.notPassed.push([name, WORDS.tooLarge]);
    }
    this.fileBytes += got.value.bytes.length;
    this.files.push(got.value);
  }

  /** A text file: its text, fenced, while the budget lasts (the one that reaches its end is cut and ends it). */
  async inline(file: InboundFile, name: string): Promise<void> {
    if (this.left <= 0) return void this.notPassed.push([name, WORDS.noRoom]);
    const got = await this.fetch(file);
    if (!got.ok) return void this.notPassed.push([name, got.error.reason]);
    const text = textOf(got.value.bytes);
    if (text === undefined) return void this.notPassed.push([name, WORDS.notUtf8]);
    const size = got.value.bytes.length;
    const body = headBytes(text, this.left);
    const kept = new TextEncoder().encode(body).length;
    this.left = kept < size ? 0 : this.left - kept; // (a file that was cut used the budget up)
    const cut = kept < size ? `, cut to its first ${String(kept)}` : "";
    const fence = fenceFor(body);
    this.blocks.push(`File ${oneLine(name)} (${String(size)} bytes${cut}):\n${fence}\n${body}\n${fence}`);
  }
}

/**
 * The files, fetched through `fetch` (an image or another file that is not text only when the machine takes files), as
 * the text that follows the person's words to the session and the files that go with it. `shown(file, i)` is the name
 * the person knows file i (1-based) by.
 */
export async function inlineFiles(
  files: readonly InboundFile[],
  fetch: Fetch,
  shown: (file: InboundFile, index: number) => string,
  options: InlineOptions = {},
): Promise<InlineFiles> {
  const got = new Gathered(options.budget ?? INLINE_FILE_BYTES, fetch);
  for (const [at, file] of files.entries()) {
    const name = shown(file, at + 1);
    if (passesInline(file)) await got.inline(file, name);
    else if (options.asFiles) await got.asFile(file, name);
    else got.notPassed.push([name, WORDS.notText]);
  }
  const { blocks, notPassed } = got;
  if (blocks.length === 0) return { section: "", passed: 0, files: got.files, notPassed };
  const lead = blocks.length === 1 ? "The file sent with this message:" : "The files sent with this message:";
  return { section: [lead, ...blocks].join("\n\n"), passed: blocks.length, files: got.files, notPassed };
}
