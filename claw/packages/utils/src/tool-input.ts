// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Make a replayed tool call's input something every model endpoint accepts: a
 * JSON object.
 *
 * Both wires refuse anything else. The OpenAI wire carries the input as the
 * `function.arguments` string and the backend rejects the WHOLE request when
 * that string does not decode to an object ("Assistant tool call
 * function.arguments must be a JSON object"); the Anthropic wire says
 * "tool_use.input: Input should be an object". One bad block in the history
 * therefore fails every later turn of the session, not just the turn that
 * produced it, because the history is replayed in full each time.
 *
 * What is accepted and what happens to it:
 *   - a plain object                      unchanged (same reference)
 *   - a string holding a JSON object      the parsed object
 *   - null, undefined, "", [], "[]"       {} (the call carried no arguments)
 *   - anything else (array, number, bool,
 *     a string that is not an object)     { value: <that thing> }, so what was
 *                                         recorded is kept rather than lost
 *
 * The result is always a fresh-or-original plain object, never an array and
 * never null, and never throws.
 */
export function coerceToolInput(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    if (raw.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { value: raw };
    }
    if (isPlainObject(parsed)) return parsed;
    if (parsed === null || (Array.isArray(parsed) && parsed.length === 0)) return {};
    return { value: parsed };
  }
  if (Array.isArray(raw) && raw.length === 0) return {};
  return { value: raw };
}

/** True for `{...}`: not null, not an array, not a class instance. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
