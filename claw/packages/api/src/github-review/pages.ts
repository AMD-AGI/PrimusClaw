// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `gh_pr_get` in pages that a model reads whole.
 *
 * Brain cuts every tool result longer than its cap (`TOOL_RESULT_MAX_CHARS` in brain's agent-loop.ts, 6000 characters) to a head and a
 * tail, so a result that is longer is a result the model reads only in part: the review instructions, the middle of the diff. Here every
 * answer is built to fit under {@link PAGE_MAX_CHARS} as the model receives it (the JSON text, after redaction), and what does not fit
 * is a named section read in pages: each page says where the next one starts, and none is cut.
 */
import { diffNotSent, type RiskFile } from "./risk.js";

/** Below Brain's cut at 6000 characters, with room for what a transport adds around the text. */
export const PAGE_MAX_CHARS = 5500;

export const SECTIONS = ["overview", "instructions", "files", "diff", "conversation"] as const;
export type Section = typeof SECTIONS[number];

export function isSection(v: unknown): v is Section {
  return typeof v === "string" && (SECTIONS as readonly string[]).includes(v);
}

export interface Comment {
  kind: "conversation" | "inline";
  author: string;
  path?: string;
  line?: number | null;
  body: string;
}

function fileHeader(f: RiskFile): string {
  return `### ${f.path} (${f.status}, +${f.additions} -${f.deletions})`;
}

function filePart(f: RiskFile): string {
  const shown = f.patch === undefined ? "[no diff available: binary or too large]"
    : diffNotSent(f) ? `[Git LFS pointer: the file it stands for is not shown]\n${f.patch}` : f.patch;
  return `${fileHeader(f)}\n${shown}\n`;
}

type Redact = (t: string) => string;
const asIs: Redact = (t) => t;

/**
 * The diff of every file (or of `only`), one after the other, each under a `### path` header, each passed through `redact` whole: a
 * secret is masked before the text is cut into pages, where a secret cut in two would be matched by neither half.
 */
export function diffText(files: RiskFile[], only: string | null = null, redact: Redact = asIs): string {
  return files.filter((f) => !only || f.path === only).map((f) => redact(filePart(f))).join("");
}

/** One line per changed file: what it is, and where its part of the `diff` section starts and how long it is, so a page can be aimed at it. */
/** Where each file's part is in the whole diff ({@link diffText} with no file named), as the `files` index gives it. */
export function diffRanges(files: RiskFile[], redact: Redact = asIs): Array<{ path: string; start: number; end: number }> {
  let offset = 0;
  return files.map((f) => {
    const start = offset;
    offset += redact(filePart(f)).length;
    return { path: f.path, start, end: offset };
  });
}

export function filesText(files: RiskFile[], redact: Redact = asIs): string {
  const ranges = diffRanges(files, redact);
  return redact(files.map((f, i) => {
    const r = ranges[i] as { start: number; end: number };
    return `${f.path} (${f.status}, +${f.additions} -${f.deletions}) diff offset ${r.start}, ${r.end - r.start} chars${diffNotSent(f) ? ", no diff" : ""}\n`;
  }).join(""));
}

export function conversationText(title: string, description: string, comments: Comment[]): string {
  const lines = [`Title: ${title}`, "", "Description:", description || "(none)", "", `Comments (${comments.length}):`];
  for (const c of comments) {
    const where = c.kind === "inline" ? ` on ${c.path ?? ""}:${c.line ?? "?"}` : "";
    lines.push(`- ${c.kind}${where} by ${c.author}: ${c.body}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface Page {
  /** The answer as the model receives it. */
  text: string;
  /** Where the next page starts, or null when this one reached the end. */
  next: number | null;
}

/**
 * The longest page of `full` from `offset`, at most `want` characters, whose rendering (`render`, which builds the whole answer around
 * the slice and returns its final text) fits in `max`. A page ends at a line end when one is in its second half, so a line of a diff is
 * not split across pages unless it is longer than half a page by itself.
 */
export function fitPage(full: string, offset: number, want: number, render: (slice: string, next: number | null) => string, max = PAGE_MAX_CHARS): Page {
  const start = Math.max(0, Math.min(offset, full.length));
  let end = Math.min(full.length, start + Math.max(1, want));
  for (;;) {
    let cut = end;
    if (cut < full.length) {
      const nl = full.lastIndexOf("\n", cut - 1);
      if (nl + 1 > start + (cut - start) / 2) cut = nl + 1;
      // Never between the two halves of a surrogate pair.
      const code = full.charCodeAt(cut - 1);
      if (cut - 1 > start && code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    const next = cut < full.length ? cut : null;
    const text = render(full.slice(start, cut), next);
    if (text.length <= max || cut - start <= 1) {
      if (text.length > max) throw new Error("a page cannot be made to fit");
      return { text, next };
    }
    // Every character of the slice is at least one character of the answer, so taking the overshoot off the slice is enough or more.
    end = start + Math.max(1, cut - start - (text.length - max));
  }
}
