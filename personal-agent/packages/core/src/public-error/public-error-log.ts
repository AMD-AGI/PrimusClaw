// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Logger } from "../ports/logger.js";
import type { Random } from "../ports/random.js";
import { redactText } from "../redact/index.js";
import { cpHead, cpLength, squashSpaces } from "../text/py-text.js";
import { looksInternal, looksLikeServiceError } from "./classify.js";
import { USERINFO } from "./patterns.js";
import type { PublicErrors, WithheldIds } from "./public-errors.js";

/** How much of the withheld text the log line keeps (after credential shapes are masked). */
export const DETAIL_LOG_MAX = 500;

/** A short id that ties what the person was told to the log line with the detail: 8 random hex characters. */
export function newRef(random: Random): string {
  return random.hexId().slice(0, 8);
}

/** `str(detail or "")`: the text of what was handed over (an error's message). */
function textOf(detail: unknown): string {
  if (detail === undefined || detail === null || detail === false || detail === 0 || detail === "") return "";
  if (typeof detail === "string") return detail;
  if (detail instanceof Error) return detail.message;
  if (typeof detail === "number" || typeof detail === "boolean" || typeof detail === "bigint") return String(detail);
  // (JSON.stringify gives undefined for a function or a symbol, whatever its declared type says)
  const json = JSON.stringify(detail) as string | undefined;
  return json ?? typeof detail;
}

/** The PublicErrors of a worker: withheld text goes to `logger` under a reference from `random`. */
export class PublicErrorLog implements PublicErrors {
  constructor(
    private readonly logger: Logger,
    private readonly random: Random,
  ) {}

  withhold(where: string, detail: unknown = "", ids: WithheldIds = {}): string {
    const ref = newRef(this.random);
    let text = redactText(squashSpaces(textOf(detail)).replace(USERINFO, "$1[hidden]@")).text;
    if (cpLength(text) > DETAIL_LOG_MAX) text = cpHead(text, DETAIL_LOG_MAX) + "…";
    // One log line each: an id from outside (a session id in an event) cannot start a forged line.
    const shown = Object.entries(ids)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([name, value]) => [name, typeof value === "string" ? value.replace(/[\n\r]/g, " ") : value] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.logger.warn("user-facing error", { ref, where, ...Object.fromEntries(shown), detail: text });
    return ref;
  }

  publicReason(reason: unknown, where: string, ids: WithheldIds = {}): string {
    const text = textOf(reason);
    if (text.trim() === "") return "";
    if (looksInternal(text) || looksLikeServiceError(text))
      return `an internal error (ref ${this.withhold(where, text, ids)})`;
    return text;
  }
}
