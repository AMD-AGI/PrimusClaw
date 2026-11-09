// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A logger that keeps every line, for tests of what is logged (and of what never is). */
import type { LogFields, Logger, LogLevel } from "@primusclaw/personal-agent";

export interface Line {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export class RecordingLogger implements Logger {
  constructor(
    readonly lines: Line[] = [],
    private readonly base: LogFields = {},
  ) {}

  private add(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields: { ...this.base, ...fields } });
  }

  debug(message: string, fields?: LogFields): void {
    this.add("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.add("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.add("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.add("error", message, fields);
  }
  child(fields: LogFields): Logger {
    return new RecordingLogger(this.lines, { ...this.base, ...fields });
  }

  /** Every line as one string (message and fields), for "this text appears nowhere" checks. */
  dump(): string {
    return this.lines.map((l) => `${l.level} ${l.message} ${JSON.stringify(l.fields)}`).join("\n");
  }
}
