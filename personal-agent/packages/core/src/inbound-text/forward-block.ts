// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The messages a person forwarded, as text for the model: a line that says the person forwarded them, then each one
 * with who wrote it and when, its text after "> " so nothing it says can pass for a line of its own (as a quote's is).
 * A forward is the person handing over what others said for the model to work on, so it gets a budget of its own,
 * larger than the quotes' (several messages at once, each whole where it can be). In a group the names and the texts
 * are masked as a quote's are.
 */
import { silentLogger, type Logger } from "../ports/logger.js";
import type { InboundForward } from "../ports/surface.js";
import { cpHead, cpLength, cpSlice, pyRstrip, pySplitlines, pyStrip } from "../text/py-text.js";
import { NAME_CHARS } from "./quote-block.js";
import { noRedact, type Redact } from "./redact.js";
import { whenOf } from "./when.js";

/** The most forwarded text, over all the messages of one forward, that is sent on (code points). */
export const FORWARD_CHARS = 24000;
/** The most forwarded messages that are shown. */
export const FORWARD_COUNT = 20;

export interface ForwardBlockOptions {
  /** A group conversation: names and texts are masked. */
  readonly group?: boolean;
  readonly redact?: Redact;
  readonly logger?: Logger;
}

const AT_TAG = /<\/?[Aa][Tt]>/g;

function headOf(forward: InboundForward, at: number, of: number, group: boolean, redact: Redact): string {
  const name = cpHead(group ? redact(forward.author) : forward.author, NAME_CHARS);
  const when = whenOf(forward.sentAt);
  const place = of > 1 ? ` ${String(at)} of ${String(of)}` : "";
  return `Forwarded message${place}${name ? ` from ${name}` : ""}${when ? ` (${when})` : ""}:`;
}

function bodyOf(forward: InboundForward, group: boolean, redact: Redact, budget: number): string {
  let text = forward.text.replace(AT_TAG, "");
  text = group ? redact(text) : text;
  text = pySplitlines(pyStrip(text))
    .map((line) => pyRstrip(line))
    .join("\n");
  if (!text) return "[the text of the forwarded message is not available]";
  return cpLength(text) > budget ? pyRstrip(cpSlice(text, 0, budget)) + "… [cut]" : text;
}

/** The forwarded messages as text for the model, "" when there are none. */
export function forwardBlock(forwards: readonly InboundForward[], options: ForwardBlockOptions = {}): string {
  if (forwards.length === 0) return "";
  const group = options.group ?? false;
  const redact = options.redact ?? noRedact;
  const sources = [...new Set(forwards.map((f) => f.source))].sort().join("+");
  (options.logger ?? silentLogger).info("the message forwards messages", { count: forwards.length, sources });
  const shown = forwards.slice(0, FORWARD_COUNT);
  let budget = FORWARD_CHARS;
  const blocks: string[] = [];
  for (const [at, forward] of shown.entries()) {
    if (budget <= 0) break;
    const text = bodyOf(forward, group, redact, budget);
    budget -= cpLength(text);
    const lines = text.split("\n").map((line) => pyRstrip(`> ${line}`));
    blocks.push(`${headOf(forward, at + 1, forwards.length, group, redact)}\n${lines.join("\n")}`);
  }
  const hidden = forwards.length - blocks.length;
  if (hidden > 0) blocks.push(`(${String(hidden)} more forwarded message${hidden === 1 ? "" : "s"} not shown)`);
  const lead =
    forwards.length === 1
      ? "The person forwarded you this message, written by someone else:"
      : `The person forwarded you these ${String(forwards.length)} messages, written by others:`;
  return [lead, ...blocks].join("\n\n");
}
