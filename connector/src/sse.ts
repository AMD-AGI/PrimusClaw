// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A text/event-stream parser that also reports every byte it sees, so a watchdog can tell a silent stream from a quiet one. */

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  /** A `:` comment line. */
  comment?: boolean;
}

/** Incremental parser: feed text, get the frames completed so far. */
export class SseParser {
  private buf = "";

  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const out: SseFrame[] = [];
    for (;;) {
      const m = /\r\n\r\n|\n\n|\r\r/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const f = parseBlock(block);
      if (f) out.push(f);
    }
    return out;
  }
}

function parseBlock(block: string): SseFrame | null {
  const f: SseFrame = {};
  let any = false;
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === "") continue;
    if (line.startsWith(":")) { f.comment = true; any = true; continue; }
    const i = line.indexOf(":");
    const key = i < 0 ? line : line.slice(0, i);
    const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (key === "id") f.id = val;
    else if (key === "event") f.event = val;
    else if (key === "data") f.data = f.data === undefined ? val : f.data + "\n" + val;
    else continue;
    any = true;
  }
  return any ? f : null;
}

/** Read a response body as frames; `onBytes` fires for every chunk, frame or not. */
export async function* readSse(body: ReadableStream<Uint8Array>, onBytes: () => void = () => {}): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const p = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onBytes();
      for (const f of p.push(dec.decode(value, { stream: true }))) yield f;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
