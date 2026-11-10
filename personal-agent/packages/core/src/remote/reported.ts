// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a connector reports inside an agent's `capabilities` (opaque to Claw: stored and relayed unchanged) is read here, key by
 * key and defensively: a field of the wrong type is a field that is not there.
 */
import { z } from "zod";

/** One entry of a connector's report (a conversation, a health problem, a permission option). */
export type Reported = Readonly<Record<string, unknown>>;

const Entry = z.record(z.string(), z.unknown());

/** `value` when it is a JSON object, else null. */
export function objOrNull(value: unknown): Reported | null {
  if (Array.isArray(value)) return null;
  const parsed = Entry.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The list `value` is, or []. */
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `value` when it is a string, else "". */
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
