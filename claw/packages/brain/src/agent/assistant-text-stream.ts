// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import pino from "pino";
import {
  ASSISTANT_TEXT_DELTA_EVENT, ASSISTANT_TEXT_VOID_EVENT,
  type AssistantTextDeltaData, type AssistantTextVoidData,
} from "@claw/protocol";
import type { StreamTurnOptions } from "../llm/provider.js";

const logger = pino({ name: "assistant-text-stream" });

/**
 * The least time between two `assistantTextDelta` events of one text block. A block's first text goes out at once; what the
 * model writes inside an interval goes out together when it ends. Without a floor every token would be its own JetStream
 * publish, which buys nothing a reader can see.
 */
export const ASSISTANT_TEXT_DELTA_INTERVAL_MS = 50;

/**
 * Where the text written so far may be published up to: everything but a trailing run of printable, non-space ASCII, which may
 * be the first half of a credential (`ghp_...`, an API key, a password). Events are redacted one at a time on their way out
 * (`redactPersistedEvent` in tasks/runner.ts), and a value split across two deltas is in neither of them whole, so the run is held
 * until the character after it arrives: a space, a newline, or any other character such a value cannot contain (CJK text is not
 * held at all). `final`: the block is complete, so all of it.
 */
export function publishableLength(text: string, final: boolean): number {
  if (final) return text.length;
  let end = text.length;
  while (end > 0) {
    const c = text.charCodeAt(end - 1);
    if (c < 0x21 || c > 0x7e) break;
    end--;
  }
  // Never half of a surrogate pair.
  if (end > 0) {
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
  }
  return end;
}

interface Block {
  id: string;
  index: number;
  text: string;
  sent: number;
  seq: number;
  lastAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One model call's own text (`StreamTurnOptions.text`), published while it is written as `assistantTextDelta` events
 * (`@claw/protocol`): each block's first publishable text at once, then at most once per `intervalMs`, the rest by `flush` when
 * the call returns. Publishes go out one after another in order; a failed one is logged and the run goes on, since the turn's
 * `AssistantMessage` still carries the whole text. `void` takes back what a failed call showed.
 */
export class AssistantTextStream {
  private readonly blocks = new Map<number, Block>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly prefix = `txt_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  readonly options: NonNullable<StreamTurnOptions["text"]>;

  constructor(
    private readonly turn: number,
    private readonly publish: (event: AssistantTextDeltaData | AssistantTextVoidData) => Promise<void>,
    private readonly intervalMs = ASSISTANT_TEXT_DELTA_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.options = { onText: (b) => this.onText(b.index, b.text), onToolCall: () => {} };
  }

  /** The ids of the blocks this call streamed, in the order their text blocks come in the call's content. */
  textIds(): string[] {
    return [...this.blocks.values()].sort((a, b) => a.index - b.index).filter((b) => b.sent > 0).map((b) => b.id);
  }

  private onText(index: number, text: string): void {
    if (this.closed) return;
    let block = this.blocks.get(index);
    if (!block) {
      block = { id: `${this.prefix}_${this.turn}_${index}`, index, text, sent: 0, seq: 0, lastAt: -Infinity };
      this.blocks.set(index, block);
    }
    block.text = text;
    if (block.timer) return;
    const wait = block.lastAt + this.intervalMs - this.now();
    if (wait <= 0) {
      this.send(block, false);
      return;
    }
    block.timer = setTimeout(() => {
      block.timer = undefined;
      if (!this.closed) this.send(block, false);
    }, wait);
    block.timer.unref?.();
  }

  private send(block: Block, final: boolean): void {
    const upTo = publishableLength(block.text, final);
    if (upTo <= block.sent) return;
    const event: AssistantTextDeltaData = {
      type: ASSISTANT_TEXT_DELTA_EVENT,
      text_id: block.id,
      seq: block.seq++,
      delta: block.text.slice(block.sent, upTo),
      turn: this.turn,
    };
    block.sent = upTo;
    block.lastAt = this.now();
    this.enqueue(event);
  }

  private enqueue(event: AssistantTextDeltaData | AssistantTextVoidData): void {
    this.chain = this.chain.then(() => this.publish(event)).catch((err: unknown) => {
      logger.warn({ err: (err as Error)?.message, type: event.type }, "assistant_text.publish_failed");
    });
  }

  private stopTimers(): void {
    for (const b of this.blocks.values()) {
      if (b.timer) clearTimeout(b.timer);
      b.timer = undefined;
    }
  }

  /** The call returned: publish every block's remaining text and wait until all of it is out. */
  async flush(): Promise<void> {
    this.stopTimers();
    if (!this.closed) {
      this.closed = true;
      for (const b of [...this.blocks.values()].sort((x, y) => x.index - y.index)) this.send(b, true);
    }
    await this.chain;
  }

  /** The call failed and is made again: what it showed is taken back, and nothing more of it is published. */
  async void(): Promise<void> {
    this.stopTimers();
    this.closed = true;
    for (const b of this.blocks.values()) {
      if (b.sent > 0) this.enqueue({ type: ASSISTANT_TEXT_VOID_EVENT, text_id: b.id, reason: "retry" });
    }
    await this.chain;
  }
}
