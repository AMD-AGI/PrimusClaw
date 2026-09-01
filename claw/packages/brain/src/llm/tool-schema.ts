// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which tools cannot be called with no arguments.
 *
 * Both providers reject a `tool_use` that carries an empty input, on the
 * theory that an empty input means the stream was cut mid-block. For a tool
 * whose schema marks nothing required that theory is wrong twice over: the
 * call is valid, and the retry that follows reproduces it exactly. Asking the
 * schema instead keeps the guard where it earns its keep -- `bash` without a
 * command -- and takes it off the calls it was never meant to catch.
 *
 * Read defensively: this runs against whatever the caller handed the provider,
 * and a tool with no schema, or a schema with no `required`, is a tool that
 * takes no required arguments.
 */
export function requiredArgToolNames(tools: readonly unknown[] | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const tool of tools ?? []) {
    const t = tool as Record<string, unknown> | null;
    if (!t || typeof t !== "object") continue;
    const name = t.name;
    if (typeof name !== "string" || name.length === 0) continue;
    // Anthropic spells it `input_schema`; the OpenAI wire nests the same
    // JSON Schema under `function.parameters`. Either is the same question.
    const fn = t.function as Record<string, unknown> | undefined;
    const schema = (t.input_schema ?? fn?.parameters) as Record<string, unknown> | undefined;
    const required = schema?.required;
    if (Array.isArray(required) && required.length > 0) out.add(name);
  }
  return out;
}
