// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The languages the personal agent speaks. Every user-facing text exists in each of them. */
export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

/**
 * A stored language as one of `LANGS`: exactly "zh" is Chinese, anything else (including nothing) is English -- the
 * Python worker's `"zh" if lang == "zh" else "en"`. A client locale ("zh-CN") is not a stored language: reading one is
 * the feature's own rule (the Python `answer_lang`), not this function's.
 */
export function toLang(value: string | undefined): Lang {
  return value === "zh" ? "zh" : "en";
}
