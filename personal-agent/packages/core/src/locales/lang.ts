// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The languages the personal agent speaks. Every user-facing text exists in each of them. */
export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

/**
 * A stored or reported language as one of `LANGS`: "zh", and any Chinese locale ("zh-CN", "zh_TW"), is Chinese;
 * everything else, including nothing, is English (the Python worker's `"zh" if lang == "zh" else "en"`, widened to the
 * locale tags a client reports).
 */
export function toLang(value: string | undefined): Lang {
  const v = (value ?? "").trim().toLowerCase();
  return v === "zh" || v.startsWith("zh-") || v.startsWith("zh_") ? "zh" : "en";
}
