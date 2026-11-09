// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's last log lines, tagged with the chat they were written for (the Python worker's `feedback.LogBuffer`
 * and `LOG_SCOPE`): a report's scene shows the reporter's chat's last lines. The router runs each inbound event in
 * `withChat(...)`; every line logged while it is handled (also by what it starts) is kept with that chat, rebuilt from
 * its sentence and its safe fields only (`safeLogText`). A line logged outside any chat is not kept.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import {
  renderLogLine,
  safeLogText,
  type KeptLogLine,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogTail,
  type Mask,
} from "@primusclaw/personal-agent";

/** Whose message the current task is handling. */
export interface ChatScope {
  readonly userId: string;
  readonly conversationId: string;
}

const CAPACITY = 2000;
const TAIL = 30;

interface Tagged extends KeptLogLine {
  readonly userId: string;
  readonly conversationId: string;
}

export class ChatLog implements LogTail {
  private readonly scope = new AsyncLocalStorage<ChatScope>();
  private readonly lines: Tagged[] = [];

  constructor(
    private readonly mask: Mask,
    /** Seconds since the epoch. */
    private readonly now: () => number,
    private readonly capacity = CAPACITY,
  ) {}

  /** Runs `work` as handling `chat`'s message: what it logs is kept for that chat. */
  withChat<T>(chat: ChatScope, work: () => T): T {
    return this.scope.run(chat, work);
  }

  /** `inner`, also keeping each line logged in a chat's scope; `logger` names the part of the worker. */
  logger(inner: Logger, logger: string): Logger {
    const keep = (level: LogLevel, message: string, fields?: LogFields): void => {
      const chat = this.scope.getStore();
      if (chat === undefined) return;
      try {
        this.lines.push({ ...chat, at: this.now(), level, logger, text: safeLogText(this.mask, message, fields) });
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
