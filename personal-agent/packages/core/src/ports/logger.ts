// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Structured logging, injected. A message is a fixed sentence; what varies goes in `fields`.
 *
 * What a log line never carries: what a person wrote, what an agent answered, a token, a key, a response body, a file
 * name or its bytes. Counts, ids, statuses, durations and error kinds (`errorName`) are what is logged.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue = string | number | boolean | null | undefined;

export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger whose every line also carries `fields` (a module name, the conversation a task works for). */
  child(fields: LogFields): Logger;
}

/** A logger that drops everything: the default where a caller passes none. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
