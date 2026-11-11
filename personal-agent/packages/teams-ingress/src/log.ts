// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Log records, as the Python Function's `logging` calls produced them: a logger name, a level and a message, plus the
 * error for a call that logged one (`exc_info`). The Function routes them to the invocation they belong to, or to the
 * console outside one (src/functions.ts); tests collect them, as pytest's caplog does.
 */
import type { Logger as CoreLogger, LogFields } from "@primusclaw/personal-agent";

export type Level = "debug" | "info" | "warning" | "error";

export interface LogRecord {
  logger: string;
  level: Level;
  message: string;
  /** The error a Python `logger.exception(...)` or `exc_info=True` call would have attached. */
  error?: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, error?: unknown): void;
  info(message: string, error?: unknown): void;
  warning(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export function logger(sink: LogSink, name: string): Logger {
  const at =
    (level: Level) =>
    (message: string, error?: unknown): void => {
      sink(error === undefined ? { logger: name, level, message } : { logger: name, level, message, error });
    };
  return { debug: at("debug"), info: at("info"), warning: at("warning"), error: at("error") };
}

/** Core's Logger (message and fields) over a sink: the fields follow the message as JSON. */
export function coreLogger(sink: LogSink, name: string): CoreLogger {
  const at = logger(sink, name);
  const text = (message: string, fields?: LogFields): string =>
    fields === undefined ? message : `${message} ${JSON.stringify(fields)}`;
  const core: CoreLogger = {
    debug: (message, fields) => {
      at.debug(text(message, fields));
    },
    info: (message, fields) => {
      at.info(text(message, fields));
    },
    warn: (message, fields) => {
      at.warning(text(message, fields));
    },
    error: (message, fields) => {
      at.error(text(message, fields));
    },
    child: () => core,
  };
  return core;
}
