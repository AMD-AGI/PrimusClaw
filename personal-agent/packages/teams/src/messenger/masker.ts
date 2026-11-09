// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Credential masking of what a group chat is told: every member sees it, and an agent that reads a workload's environment
 * can put a key into its answer. The masking rules are core's (`redact`); this is the shape the Teams side applies them in.
 */
import type { JsonObject } from "../cards/json.js";

export interface Masked {
  readonly text: string;
  /** Whether anything was masked. */
  readonly hit: boolean;
}

export interface Masker {
  /** `text` with every credential shape masked. */
  text(text: string): Masked;
  /** `activity` with every credential shape in its text and cards masked (a typing indicator passes through). */
  activity(activity: JsonObject): JsonObject;
  /** The line added under an answer something was masked in. */
  readonly note: string;
}

/** Masks nothing: a 1:1 chat, where only the person sees what their own agent wrote. */
export const noMasking: Masker = {
  text: (text) => ({ text, hit: false }),
  activity: (activity) => activity,
  note: "",
};
