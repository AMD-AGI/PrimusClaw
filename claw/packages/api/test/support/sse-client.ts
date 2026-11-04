// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A minimal text/event-stream reader over a real HTTP connection, for tests
 * that must see frames arrive over time. `fetch` with an abort signal, so
 * closing it really drops the socket, which is what a disconnect is.
 */

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  /** True for a `:` comment line (a keepalive), which has no event. */
  comment?: boolean;
  json(): any;
}

function parseFrame(block: string): SseFrame | null {
  const f: SseFrame = { json: () => (f.data === undefined ? undefined : JSON.parse(f.data)) };
  let any = false;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) { f.comment = true; any = true; continue; }
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i);
    const val = line.slice(i + 1).replace(/^ /, "");
    if (key === "id") f.id = val;
    else if (key === "event") f.event = val;
    else if (key === "data") f.data = (f.data === undefined ? "" : f.data + "\n") + val;
    any = true;
  }
  return any ? f : null;
}

export class SseClient {
  readonly frames: SseFrame[] = [];
  status = 0;
  ended = false;
  private cursor = 0;
  private readonly abort = new AbortController();
  private poke: (() => void) | null = null;
  private done!: Promise<void>;

  static async open(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const c = new SseClient();
    const res = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: c.abort.signal });
    c.status = res.status;
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      // A refusal: the body is JSON, readable through `json()`.
      c.ended = true;
      c.body = await res.json().catch(() => null);
      return c;
    }
    c.done = c.pump(res);
    return c;
  }

  /** The JSON body of a non-stream answer. */
  body: any = null;

  private async pump(res: Response): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = parseFrame(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (frame) { this.frames.push(frame); this.poke?.(); }
        }
      }
    } catch { /* aborted or reset: the stream is over either way */ }
    this.ended = true;
    this.poke?.();
  }

  /** The next frame not yet consumed that satisfies `pred`; earlier ones that do not are skipped. */
  async next(pred: (f: SseFrame) => boolean = () => true, timeoutMs = 4000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.frames.length) {
        const f = this.frames[this.cursor++]!;
        if (pred(f)) return f;
      }
      if (this.ended) throw new Error("stream ended before the expected frame");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.poke = () => { clearTimeout(t); resolve(); };
      });
    }
  }

  /** The next event frame of this name. */
  nextEvent(event: string, timeoutMs?: number): Promise<SseFrame> {
    return this.next((f) => f.event === event, timeoutMs);
  }

  /** Whether no frame satisfying `pred` arrives within `ms`. */
  async quiet(ms: number, pred: (f: SseFrame) => boolean = (f) => !f.comment && f.event !== "ping"): Promise<boolean> {
    try { await this.next(pred, ms); return false; } catch (e) { return !this.ended || /timed out/.test(String(e)); }
  }

  /** Resolves when the server has ended the stream. */
  async waitEnded(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended) {
      if (Date.now() > deadline) throw new Error("stream did not end");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close(): void {
    this.abort.abort();
    this.ended = true;
  }

  async closed(): Promise<void> {
    this.close();
    await this.done?.catch(() => {});
  }
}
