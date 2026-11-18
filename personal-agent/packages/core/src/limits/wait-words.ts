// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { limitsText } from "../locales/limits.js";
import type { Lang } from "../locales/lang.js";

/** How long to wait, in words: whole seconds (at least 1) under two minutes, else minutes rounded up. */
export function waitWords(seconds: number, lang: Lang = "en"): string {
  const whole = Math.max(Math.trunc(seconds + 0.999), 1);
  const text = limitsText.in(lang);
  return whole < 120 ? text.seconds({ n: whole }) : text.minutes({ n: Math.floor((whole + 59) / 60) });
}
