// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { LogFields, LogLevel, LogValue } from "../ports/logger.js";
import { cpHead, squashSpaces } from "../text/py-text.js";
import { TOKEN } from "./identifiers.js";
import type { Mask } from "./issue-text.js";

/**
 * A log line as a report's scene may show it to the team (the Python worker's `feedback.safe_log_text`): the sentence,
 * then each field whose value is a number, a flag, nothing, or a short identifier-shaped token; any other value is
 * replaced by its type (`<str>`), so no message body or header can ride along. Masked, on one line, 200 characters.
 */
const LINE_CHARS = 200;

function safeValue(value: LogValue): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  return TOKEN.test(value) ? value : "<str>";
}

export function safeLogText(mask: Mask, message: string, fields: LogFields = {}): string {
  const parts = [message, ...Object.entries(fields).map(([key, value]) => `${key}=${safeValue(value)}`)];
  return cpHead(mask(squashSpaces(parts.join(" "))), LINE_CHARS);
}

const LEVEL_NAMES: Readonly<Record<LogLevel, string>> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

/** One kept line: when, how severe, which part of the worker, and its safe text. */
export interface KeptLogLine {
  /** Seconds since the epoch. */
  readonly at: number;
  readonly level: LogLevel;
  readonly logger: string;
  readonly text: string;
}

/** `<UTC time> <LEVEL> <logger> <text>`, as the scene lists it. */
export function renderLogLine(line: KeptLogLine): string {
  const stamp = `${new Date(Math.trunc(line.at) * 1000).toISOString().slice(0, 19)}Z`;
  return `${stamp} ${LEVEL_NAMES[line.level]} ${line.logger} ${line.text}`;
}
