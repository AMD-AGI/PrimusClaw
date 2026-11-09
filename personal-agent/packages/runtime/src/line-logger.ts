// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { redactLogLine, type LogFields, type Logger, type LogLevel, type LogValue } from "@primusclaw/personal-agent";

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LineLoggerOptions {
  /** Lines below this level are dropped. */
  readonly level: LogLevel;
  /** Where a finished line goes (the process's stderr in production). */
  readonly write: (line: string) => void;
  /** The wall clock, for the timestamp. */
  readonly now: () => number;
}

/** One value as it appears after `key=`: bare when it is a simple token, JSON-quoted otherwise. */
function formatValue(value: LogValue): string {
  if (value === undefined) return "-";
  if (typeof value === "string" && /^[\w.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * A message as one line: its line breaks escaped (`\r` and `\n` written as those two characters), so that a message
 * carrying text from outside (a card's verb, an error field of an answer) cannot forge a log line of its own (CWE-117).
 */
function oneLine(message: string): string {
  return message.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([key, value]) => ` ${key}=${formatValue(value)}`)
    .join("");
}

/**
 * A logger that writes one line per call: `<ISO time> <LEVEL> <message> key=value ...`. The fields of `child` loggers
 * come first, in the order they were bound. The whole line goes through `redactLogLine`: a net under the rule that a
 * line carries ids, statuses and kinds of error only (credential shapes and credential-named URL parameters masked).
 */
export function lineLogger(options: LineLoggerOptions, bound: LogFields = {}): Logger {
  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (ORDER[level] < ORDER[options.level]) return;
    const time = new Date(options.now()).toISOString();
    options.write(
      redactLogLine(`${time} ${level.toUpperCase()} ${oneLine(message)}${formatFields({ ...bound, ...fields })}`),
    );
  };
  return {
    debug: (message, fields) => {
      emit("debug", message, fields);
    },
    info: (message, fields) => {
      emit("info", message, fields);
    },
    warn: (message, fields) => {
      emit("warn", message, fields);
    },
    error: (message, fields) => {
      emit("error", message, fields);
    },
    child: (fields) => lineLogger(options, { ...bound, ...fields }),
  };
}
