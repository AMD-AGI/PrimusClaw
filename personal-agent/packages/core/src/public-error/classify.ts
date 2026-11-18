// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a text the worker did not write carries internal detail, and where in a failed turn's answer the error that
 * ended it starts. Pure functions; `PublicErrorLog` (public-error-log.ts) is what withholds and logs.
 */
import { cpHead, cpLength, pyRstrip, pySplitlines, pyStrip } from "../text/py-text.js";
import { ADDRESS, BRAIN_ERROR, FAILURE_WORDS, FENCE, INTERNAL, PUBLIC_LINK, SERVICE_ERROR } from "./patterns.js";

/** How much of a text is looked at (the patterns stay cheap on a hostile text); a longer text is withheld. */
export const SCAN_MAX = 4000;

/** True when `text` has the shape of internal detail: an address, a host or service name, a path, a stack trace, an exception class, raw JSON. */
export function looksInternal(text: unknown): boolean {
  return typeof text === "string" && (cpLength(text) > SCAN_MAX || INTERNAL.test(text));
}

/** True when `text` is the error a model call or a service failed with, as Brain writes it (an HTTP status first), or a stack trace. */
export function looksLikeServiceError(text: unknown): boolean {
  return typeof text === "string" && SERVICE_ERROR.test(text);
}

function failureAtAddress(text: string): boolean {
  const head = cpHead(text, SCAN_MAX).replace(PUBLIC_LINK, " ");
  return ADDRESS.test(head) && FAILURE_WORDS.test(head);
}

/**
 * True when `text` is a service error, or names an address or a stack trace and says something failed: an error, not the
 * model's own words about one.
 */
export function looksLikeFailure(text: unknown): boolean {
  return typeof text === "string" && (looksLikeServiceError(text) || failureAtAddress(text));
}

interface Paragraph {
  readonly start: number;
  readonly text: string;
  readonly fenced: boolean;
}

/** `text`'s paragraphs (split at blank lines outside code fences): where each starts, its text, whether it holds a fence. */
function paragraphsOf(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  let start: number | null = null;
  let lines: string[] = [];
  let fenced = false;
  let inFence = false;
  let pos = 0;
  for (const line of pySplitlines(text, true)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      fenced = true;
    }
    if (pyStrip(line) === "" && !inFence) {
      if (start !== null) out.push({ start, text: lines.join(""), fenced });
      start = null;
      lines = [];
      fenced = false;
    } else {
      start ??= pos;
      lines.push(line);
    }
    pos += line.length;
  }
  if (start !== null) out.push({ start, text: lines.join(""), fenced });
  return out;
}

/** A failed turn's last text, split into the model's own words and the error that ended it (for the log only). */
export interface ErrorTail {
  readonly kept: string;
  readonly tail: string;
}

/**
 * From the first paragraph that is Brain's error on, or else the last paragraph when it names an address and says
 * something failed, the text is the error. A paragraph with a code fence is the model's and is never cut.
 */
export function splitErrorTail(text: unknown): ErrorTail {
  if (typeof text !== "string" || pyStrip(text) === "") return { kept: "", tail: "" };
  const paragraphs = paragraphsOf(text);
  let cut = paragraphs.find((p) => !p.fenced && BRAIN_ERROR.test(p.text))?.start;
  const last = paragraphs.at(-1);
  if (cut === undefined && last !== undefined && !last.fenced && failureAtAddress(last.text)) cut = last.start;
  if (cut === undefined) return { kept: text, tail: "" };
  return { kept: pyRstrip(text.slice(0, cut)), tail: pyStrip(text.slice(cut)) };
}
