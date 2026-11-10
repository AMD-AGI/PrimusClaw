// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A recording live stream with Teams' rules: text only grows, a final closes it, refusals on demand. */
import { err, ok, type Result } from "../../src/result.js";
import type { MessageId, OutMessage, StreamRefused, UpdateOptions } from "../../src/ports/surface.js";
import type { ReceiptStream } from "../../src/assistant/receipt.js";

export type StreamOp =
  | { readonly op: "inform"; readonly text: string }
  | { readonly op: "emit"; readonly text: string }
  | { readonly op: "final"; readonly message: OutMessage }
  | { readonly op: "update"; readonly id: string; readonly message: OutMessage }
  | { readonly op: "delete"; readonly id: string };

const refused = (reason: string): Result<void, StreamRefused> =>
  err({ kind: "stream_refused", reason, status: 403, code: "ContentStreamNotAllowed" });

export class FakeReceiptStream implements ReceiptStream {
  open = true;
  streamed = "";
  streamId = "stream-1";
  replyTo = "act-1";
  closable = true;
  age = 0;
  readonly ops: StreamOp[] = [];
  /** A final whose text does not start with what was streamed is refused (as Teams may). */
  refuseShrinkingFinal = false;
  refuseUpdates = false;
  refuseAll = false;
  /** Updates are on their way and never answered: each ends only when its sender gives it up (refused then). */
  hangUpdates = false;

  ageSeconds(): number {
    return this.age;
  }

  /** An update that is never answered: refused once `options.signal` aborts, else pending for good. */
  private hung(options: UpdateOptions | undefined): Promise<Result<void, StreamRefused>> {
    return new Promise((resolve) => {
      options?.signal?.addEventListener("abort", () => {
        resolve(refused("given up"));
      });
    });
  }

  inform(text: string, options?: UpdateOptions): Promise<Result<void, StreamRefused>> {
    this.ops.push({ op: "inform", text });
    if (this.hangUpdates) return this.hung(options);
    return Promise.resolve(this.refuseAll ? refused("refused") : ok(undefined));
  }

  emit(text: string, options?: UpdateOptions): Promise<Result<void, StreamRefused>> {
    if (this.hangUpdates) {
      this.ops.push({ op: "emit", text });
      return this.hung(options);
    }
    if (this.refuseAll || !text.startsWith(this.streamed)) return Promise.resolve(refused("shrinks"));
    this.ops.push({ op: "emit", text });
    this.streamed = text;
    return Promise.resolve(ok(undefined));
  }

  final(message: OutMessage): Promise<Result<void, StreamRefused>> {
    const body = message.body;
    const text = body.type === "text" ? body.text : body.type === "rich" ? body.markdown : "";
    if (this.refuseAll || (this.refuseShrinkingFinal && this.streamed && !text.startsWith(this.streamed))) {
      return Promise.resolve(refused("final"));
    }
    this.ops.push({ op: "final", message });
    this.open = false;
    return Promise.resolve(ok(undefined));
  }

  update(id: MessageId, message: OutMessage): Promise<void> {
    if (this.refuseUpdates) return Promise.reject(new Error("edit refused"));
    this.ops.push({ op: "update", id, message });
    return Promise.resolve();
  }

  delete(id: MessageId): Promise<void> {
    this.ops.push({ op: "delete", id });
    return Promise.resolve();
  }

  finals(): string[] {
    return this.ops.flatMap((o) => {
      if (o.op !== "final") return [];
      const b = o.message.body;
      return [b.type === "text" ? b.text : b.type === "rich" ? b.markdown : `view:${b.view.name}`];
    });
  }
}
