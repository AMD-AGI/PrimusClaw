// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Numbers, times of day and durations as people say them ("晚上 10 点", "八点半", "两小时"), for the sentences that set quiet hours,
 * a pause or the brief (`natural.ts`).
 */
import { decimalInt, isDigits, pyLower, pyRstrip, pySplit, pyStrip } from "../text/py-text.js";
import { pyFullmatch } from "../text/py-regex.js";

/** The punctuation and spacing a whole message may carry at either end without changing what it says. */
export const PUNCT = " \t\r\n。．.！!？?～~，,、；;：:\"'“”‘’（）()";
/** What a sentence may end with ("切到 X 的 claude。"): dropped before it is matched whole. */
export const TRAILING = "。.！!？?～~ ";

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** One or two digits, or a Chinese number up to 99. */
export const NUM = String.raw`(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})`;
export const PERIOD = String.raw`(?:早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间|凌晨|半夜)`;
/** A time of day: "22:00", "晚上 10 点", "8 点半", "九点十五分". No capturing groups: it is used inside other patterns. */
export const TIME = String.raw`(?:${PERIOD})?\s*${NUM}\s*(?:[:：]\s*\d{2}|(?:点|點)\s*(?:半|${NUM}\s*分?)?)`;

const TIME_PARTS = pyFullmatch(
  String.raw`(?<p>${PERIOD})?\s*(?<h>${NUM})\s*(?:[:：]\s*(?<m>\d{2})|(?:点|點)\s*(?:(?<half>半)|(?<m2>${NUM})\s*分?)?)`,
);

/** A whole message as a phrase to look up: lower case, no spaces between the words, no punctuation at either end. */
export function phraseKey(text: string): string {
  return pySplit(pyLower(pyStrip(text, PUNCT))).join("");
}

/** A whole message as it is matched against a sentence pattern: no spacing at either end, no closing punctuation. */
export function flatten(text: string): string {
  return pyStrip(pyRstrip(pyStrip(text), TRAILING));
}

/** A Chinese digit's value; undefined for anything else (a name every object inherits included). */
function digitOf(word: string): number | undefined {
  return Object.hasOwn(CN_DIGITS, word) ? CN_DIGITS[word] : undefined;
}

/** A number as written ("12", "十二", "两"); null when it is none. */
export function spokenNumber(text: string): number | null {
  if (isDigits(text)) return decimalInt(text);
  const single = digitOf(text);
  if (single !== undefined) return single;
  const ten = text.indexOf("十");
  if (ten < 0) return null;
  const tens = text.slice(0, ten);
  const ones = text.slice(ten + 1);
  const high = tens === "" ? 1 : digitOf(tens);
  const low = ones === "" ? 0 : digitOf(ones);
  return high === undefined || low === undefined ? null : high * 10 + low;
}

function afternoon(period: string, hour: number): number {
  if (["下午", "傍晚", "晚上", "夜里", "夜间"].includes(period) && hour < 12) return hour + 12;
  if (["晚上", "夜里", "夜间", "凌晨", "半夜"].includes(period) && hour === 12) return 0;
  if (period === "中午" && hour <= 2) return hour + 12;
  return hour;
}

/** '晚上 10 点' / '早上 8 点半' / '22:00' / '九点' as '22:00' / '08:30' / '22:00' / '09:00'; null when it is no time of day. */
export function clockOf(text: string): string | null {
  const groups = TIME_PARTS.exec(pyStrip(text))?.groups;
  if (groups === undefined) return null;
  const hour = spokenNumber(groups["h"] ?? "");
  const minute = groups["half"] !== undefined ? 30 : spokenNumber(groups["m"] ?? groups["m2"] ?? "0");
  if (hour === null || minute === null) return null;
  const at = afternoon(groups["p"] ?? "", hour);
  if (at > 23 || minute > 59) return null;
  return `${String(at).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const UNITS: Readonly<Record<string, string>> = {
  分钟: "m",
  分: "m",
  小时: "h",
  个小时: "h",
  钟头: "h",
  个钟头: "h",
  天: "d",
};
const HOURS = ["个小时", "小时", "个钟头", "钟头"];

/** A duration as `/pause` takes it ("30m", "2h", "1d") from a number and a unit as said; null when it is none. */
export function spokenDuration(count: string, unit: string): string | null {
  const lower = pyLower(unit);
  if (count === "半") return HOURS.includes(lower) ? "30m" : null;
  const value = spokenNumber(count);
  if (value === null || value === 0) return null;
  if (lower.startsWith("minute") || lower.startsWith("hour") || lower.startsWith("day")) {
    return `${String(value)}${lower.charAt(0)}`;
  }
  const short = Object.hasOwn(UNITS, lower) ? UNITS[lower] : undefined;
  return short === undefined ? null : `${String(value)}${short}`;
}
