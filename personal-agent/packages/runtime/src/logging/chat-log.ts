// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's last log lines, tagged with the chat they were written for (the Python worker's `feedback.LogBuffer`
 * and `LOG_SCOPE`): a report's scene shows the reporter's chat's last lines. The router runs each inbound event in the
 * request scope; every line logged while it is handled (also by what it starts) is kept with that request's user and
 * conversation, rebuilt from its sentence and its safe fields only (`safeLogText`). A line logged outside any request
 * is not kept, as Python's `LogBuffer.emit` keeps none while `LOG_SCOPE` is None.
 */
import {
  renderLogLine,
  safeLogText,
  type KeptLogLine,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogTail,
  type Mask,
  type RequestScope,
} from "@primusclaw/personal-agent";

const CAPACITY = 2000;
const TAIL = 30;

interface Tagged extends KeptLogLine {
  readonly userId: string;
  readonly conversationId: string;
}

export class ChatLog implements LogTail {
  private readonly lines: Tagged[] = [];

  constructor(
    /** Whose message the current task is handling (the router enters it once per inbound event). */
    private readonly scope: RequestScope,
    private readonly mask: Mask,
    /** Seconds since the epoch. */
    private readonly now: () => number,
    private readonly capacity = CAPACITY,
  ) {}

  /** `inner`, also keeping each line logged in a chat's scope; `logger` names the part of the worker. */
  logger(inner: Logger, logger: string): Logger {
    const keep = (level: LogLevel, message: string, fields?: LogFields): void => {
      const request = this.scope.current();
      if (request === undefined) return;
      const { userId, conversationId } = request;
      try {
        this.lines.push({
          userId,
          conversationId,
          at: this.now(),
          level,
          logger,
          text: safeLogText(this.mask, message, fields),
        });
        if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
      } catch {
        // a logger never throws into the code that logged; the line is only not kept
      }
    };
    return {
      debug: (message, fields) => {
        inner.debug(message, fields);
      },
      info: (message, fields) => {
        inner.info(message, fields);
        keep("info", message, fields);
      },
      warn: (message, fields) => {
        inner.warn(message, fields);
        keep("warn", message, fields);
      },
      error: (message, fields) => {
        inner.error(message, fields);
        keep("error", message, fields);
      },
      child: (fields) => this.logger(inner.child(fields), logger),
    };
  }

  /** The last lines kept for one chat, oldest first, as the scene shows them. */
  tail(userId: string, conversationId: string, count = TAIL): readonly string[] {
    return this.lines
      .filter((l) => l.userId === userId && l.conversationId === conversationId)
      .slice(-count)
      .map(renderLogLine);
  }
}
