// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An in-memory Claw with an assistant (the Python tests' `assistant_fake.FakeAssistantClaw`, the parts the assistant's services
 * call): each key owns one assistant session; messages are heard in order; a session's live stream plays scripted events; uploads
 * land under `.uploads/`. Failures are set per call (`fail`) as the error the real client throws.
 */
import type { ClawAssistantPort, ClawSessionsPort, JsonObject, SseEvent, UploadFile } from "@primusclaw/personal-agent";

export interface Heard {
  readonly key: string;
  readonly sessionId: string;
  readonly text: string;
  readonly modelKey: string;
  readonly context: Readonly<JsonObject> | undefined;
  readonly plugin: number | undefined;
}

type Call = "session" | "send" | "turn" | "interrupt" | "upload";

export class FakeAssistantClaw {
  readonly heard: Heard[] = [];
  readonly calls: string[] = [];
  readonly running = new Set<string>();
  readonly uploads: { sessionId: string; folder: string; names: string[] }[] = [];
  /** The error the next call of a kind throws (kept until cleared). */
  readonly fail = new Map<Call, Error>();
  /** Files Claw refuses by name. */
  readonly refuseFiles = new Set<string>();
  /** Messages are queued (no message id) while this is set. */
  queue = false;
  /** Scripted live events, played to the next stream opened once the next message is heard. */
  script: SseEvent[] = [];
  private n = 0;
  private onHeard: (() => void)[] = [];

  private check(call: Call): void {
    const error = this.fail.get(call);
    this.calls.push(call);
    if (error) throw error;
  }

  sessionOf(key: string): string {
    return `asst-${key}`;
  }

  readonly assistant: Pick<ClawAssistantPort, "session" | "send"> = {
    session: (key) => {
      this.check("session");
      return Promise.resolve({ sessionId: this.sessionOf(key), created: false });
    },
    send: (key, sessionId, text, options) => {
      this.check("send");
      this.n += 1;
      this.heard.push({
        key,
        sessionId,
        text,
        modelKey: options?.modelKey ?? "",
        context: options?.context,
        plugin: options?.plugin,
      });
      for (const resolve of this.onHeard.splice(0)) resolve();
      return Promise.resolve(this.queue ? null : `msg-${String(this.n)}`);
    },
  };

  readonly sessions: Pick<ClawSessionsPort, "turn" | "interrupt" | "stream" | "uploadFiles"> = {
    turn: (_key, sessionId) => {
      this.check("turn");
      return Promise.resolve({ running: this.running.has(sessionId), messageId: null });
    },
    interrupt: (_key, sessionId) => {
      this.check("interrupt");
      this.running.delete(sessionId);
      return Promise.resolve();
    },
    stream: (_key, _sessionId, _after, signal) => this.play(signal),
    uploadFiles: (_key, sessionId, folder, files: readonly UploadFile[]) => {
      this.check("upload");
      const taken = files.filter((f) => !this.refuseFiles.has(f.name));
      this.uploads.push({ sessionId, folder, names: taken.map((f) => f.name) });
      return Promise.resolve({
        paths: taken.map((f) => `/workspace/.uploads/${folder.replace(/^\.uploads\//, "")}/${f.name}`),
        refused: files.filter((f) => this.refuseFiles.has(f.name)).map((f) => f.name),
      });
    },
  };

  /** The scripted events, then nothing until the stream is closed (a live stream does not end by itself). */
  private async *play(signal: AbortSignal | undefined): AsyncGenerator<SseEvent> {
    const events = this.script;
    this.script = [];
    const heard = this.heard.length;
    if (events.length && this.heard.length === heard) await new Promise<void>((resolve) => this.onHeard.push(resolve));
    for (const event of events) {
      if (signal?.aborted) return;
      await Promise.resolve();
      yield event;
    }
    if (signal && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          resolve();
        });
      });
    }
  }
}
