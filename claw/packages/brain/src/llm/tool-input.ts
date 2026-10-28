// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Message } from "@claw/protocol";
import { coerceToolInput, isPlainObject } from "@claw/utils";

/**
 * Tool-call arguments on the way in and out of the model wire.
 *
 * Both wires require a tool call's input to be a JSON object, and the endpoint
 * rejects the WHOLE request when one replayed call is not ("Assistant tool call
 * function.arguments must be a JSON object" on the OpenAI wire,
 * "tool_use.input: Input should be an object" on the Anthropic one). The
 * history is replayed in full on every turn, so one such block fails every
 * later turn of the session and nothing the session does can unstick it.
 *
 * Three places can hand us such a block, and each is closed here:
 *   - the history the API rebuilds from stored events (repaired at its source,
 *     and again here because rows already written still carry the bad shape);
 *   - a stream whose arguments decoded to something other than an object;
 *   - anything a later change introduces.
 */

/**
 * Decode a streamed tool call's accumulated arguments into a replayable input.
 *
 * `malformed` is true when the text was not JSON at all (a cut-off stream): the
 * input is then `{_raw}`, which the callers already treat as a failed parse and
 * retry. Valid JSON that is not an object (`[]`, `null`, `"x"`, `3`) is NOT a
 * failed parse -- it is a decodable answer of the wrong type -- so it is
 * coerced to an object here, and the stored block is always replayable.
 */
export function parseToolArguments(buf: string): { input: Record<string, unknown>; malformed: boolean } {
  if (buf.length === 0) return { input: {}, malformed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch {
    return { input: { _raw: buf }, malformed: true };
  }
  return { input: coerceToolInput(parsed), malformed: false };
}

/**
 * Return `messages` with every `tool_use` input made a JSON object.
 *
 * Copy-on-change: a message or block that needs nothing is passed through by
 * reference, so the common case allocates nothing and a clean history compares
 * identical. Never drops or reorders a block, so every tool_use keeps the
 * tool_result that answers it. `repaired` is the number of inputs changed.
 */
export function sanitizeToolUseInputs(messages: Message[]): { messages: Message[]; repaired: number } {
  let repaired = 0;
  let changed = false;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let messageChanged = false;
    const blocks = (m.content as unknown as Array<Record<string, unknown>>).map((b) => {
      if (!b || b.type !== "tool_use" || isPlainObject(b.input)) return b;
      repaired++;
      messageChanged = true;
      return { ...b, input: coerceToolInput(b.input) };
    });
    if (!messageChanged) return m;
    changed = true;
    return { ...m, content: blocks as unknown as Message["content"] };
  });
  return { messages: changed ? out : messages, repaired };
}

/**
 * Does this error say the endpoint refused a replayed tool call's arguments?
 *
 * Matches the wording of both wires, and of the gateway that fronts them: the
 * fallback leg of one failed request quotes the other backend's complaint, so
 * either phrase can arrive on either path.
 */
export function looksLikeToolArgumentsRejection(err: unknown): boolean {
  let text: string;
  try {
    const e = err as Record<string, unknown> | null;
    text = [
      (e?.message as string) ?? "",
      typeof e?.error === "object" ? JSON.stringify(e.error) : String(e?.error ?? ""),
    ].join(" ");
  } catch {
    text = String(err);
  }
  return /tool call function\.arguments must be a JSON object|tool_use\.input: Input should be an object/i.test(text);
}
