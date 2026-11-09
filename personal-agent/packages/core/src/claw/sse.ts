// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pyStrip } from "../text/py-text.js";
import { isObject } from "./lenient.js";
import { pyStrOr } from "./py-value.js";
import type { JsonObject } from "../json.js";
import type { SseEvent } from "./model.js";

/** One SSE frame ("id:/event:/data:" lines) to an event; null for comments and anything whose data is not a JSON object. */
export function parseSseBlock(block: string): SseEvent | null {
  let id = "";
  let name = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = pyStrip(line.slice(3));
    else if (line.startsWith("event:")) name = pyStrip(line.slice(6));
    else if (line.startsWith("data:")) data.push(pyStrip(line.slice(5)));
  }
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const fallback = pyStrOr(parsed["type"]);
  return { id, name: name !== "" && name !== "message" ? name : fallback, data: parsed as JsonObject };
}

/**
 * Splits a stream of text chunks into SSE frames, as they complete (a frame ends at a blank line; CRLF is read as LF).
 * What is left at the end of the stream without a blank line is not a frame.
 */
export class SseFrames {
  private buffer = "";

  /** The events completed by `chunk`. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replaceAll("\r\n", "\n");
    const blocks = this.buffer.split("\n\n");
    this.buffer = blocks.pop() ?? "";
    return blocks.map(parseSseBlock).filter((event): event is SseEvent => event !== null);
  }
}
