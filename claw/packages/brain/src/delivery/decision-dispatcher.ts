// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unified NATS decision dispatcher.
 * Routes both HITL decisions and ask_user_question answers
 * from the same `decision.<sessionId>` subject using a (type, actionId) key.
 */

import type { NatsConnection, Subscription } from "nats";
import { StringCodec } from "nats";
import pino from "pino";

const logger = pino({ name: "decision-dispatcher" });
const sc = StringCodec();

export interface NatsDecisionMessage {
  type: "decision" | "answer";
  session_id: string;
  user_id?: string;
  action_id: string;
  decision?: string;
  feedback?: string;
  edited_input?: Record<string, unknown>;
  remember?: boolean;
  answers?: unknown;
  skipped?: string[];
}

export class DecisionDispatcher {
  private pending = new Map<string, {
    type: "decision" | "answer";
    resolve: (msg: NatsDecisionMessage) => void;
  }>();
  private sub: Subscription;
  private closed = false;

  constructor(nc: NatsConnection, private sessionId: string) {
    this.sub = nc.subscribe(`decision.${sessionId}`);
    this.drain();
  }

  private async drain(): Promise<void> {
    try {
      for await (const raw of this.sub) {
        if (this.closed) break;
        let msg: NatsDecisionMessage;
        try {
          msg = JSON.parse(sc.decode(raw.data)) as NatsDecisionMessage;
        } catch {
          logger.warn("decision_dispatcher.invalid_json");
          continue;
        }

        const key = `${msg.type}:${msg.action_id}`;
        const entry = this.pending.get(key);
        if (!entry) {
          logger.debug({ key }, "decision_dispatcher.no_pending");
          continue;
        }
        if (entry.type !== msg.type) continue;
        entry.resolve(msg);
        this.pending.delete(key);
      }
    } catch (err) {
      if (!this.closed) {
        logger.error({ err }, "decision_dispatcher.drain_error");
      }
    }
  }

  /**
   * Register a pending request and await its resolution.
   * Rejects on timeout or abort signal.
   */
  register(req: {
    actionId: string;
    type: "decision" | "answer";
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<NatsDecisionMessage> {
    const { actionId, type, timeoutMs, signal } = req;
    const key = `${type}:${actionId}`;

    if (this.pending.has(key)) {
      return Promise.reject(new Error(`duplicate pending request for ${key}`));
    }

    return new Promise<NatsDecisionMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("decision_timeout"));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new Error("decision_aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(key, {
        type,
        resolve: (msg) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(msg);
        },
      });
    }).finally(() => {
      this.pending.delete(key);
    });
  }

  /** Remove a pending entry without resolving it. */
  deregister(actionId: string, type: "decision" | "answer"): void {
    this.pending.delete(`${type}:${actionId}`);
  }

  /** Drain the NATS subscription and reject all pending entries. */
  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [key, entry] of entries) {
      entry.resolve({
        type: entry.type, session_id: this.sessionId,
        action_id: key.split(":")[1], decision: "skip",
        feedback: "session closed",
      });
    }
    await this.sub.drain();
  }
}
