// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Python's `datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()`, which is how the Python worker read the
 * time of a session event. `Date.parse` is no stand-in: it takes "2026", "Jan 1 2026" and "2026/01/01", which Python
 * refuses, and cuts a fraction to milliseconds. Read by position (CPython's own algorithm), no pattern, no backtracking.
 * A text without an offset is local time, as Python's `timestamp()` takes a naive datetime.
 */

const MINUTE = 60;
const HOUR = 3600;
const DAY_MS = 86_400_000;

function digit(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return code >= 48 && code <= 57 ? code - 48 : -1;
}

/** The ASCII digits of `text[at, at + count)` as a number, or -1 when any is not one. */
function digits(text: string, at: number, count: number): number {
  if (at + count > text.length) return -1;
  let value = 0;
  for (let i = at; i < at + count; i += 1) {
    const d = digit(text, i);
    if (d < 0) return -1;
    value = value * 10 + d;
  }
  return value;
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return month === 2 ? (isLeap(year) ? 29 : 28) : ([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0);
}

/** Days from 1970-01-01 to a proleptic Gregorian date (any year, unlike `Date.UTC` for years below 100). */
function epochDay(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / DAY_MS);
}

const FIRST_DAY = epochDay(1, 1, 1);
const LAST_DAY = epochDay(9999, 12, 31);

/** Where the date ends and the separator is (CPython's `_find_isoformat_datetime_separator`). */
function separatorAt(text: string): number {
  const n = text.length;
  if (n === 7) return 7;
  if (text[4] === "-") {
    if (text[5] !== "W") return 10;
    if (n > 8 && text[8] === "-") return n > 10 && digit(text, 10) >= 0 ? 8 : 10;
    return 8;
  }
  if (text[4] !== "W") return 8;
  let i = 7;
  while (i < n && digit(text, i) >= 0) i += 1;
  if (i < 9) return i;
  return i % 2 === 0 ? 7 : 8;
}

/** Monday of ISO week 1 of `year`, as an epoch day. */
function isoWeek1Monday(year: number): number {
  const jan4 = epochDay(year, 1, 4);
  const weekday = (((jan4 + 3) % 7) + 7) % 7; // 0 = Monday (1970-01-01 was a Thursday)
  return jan4 - weekday;
}

function hasWeek53(year: number): boolean {
  const jan1 = (((epochDay(year, 1, 1) + 3) % 7) + 7) % 7; // 0 = Monday
  return jan1 === 3 || (jan1 === 2 && isLeap(year));
}

function validWeek(year: number, week: number): boolean {
  return week >= 1 && (week <= 52 || (week === 53 && hasWeek53(year)));
}

/** `Www[-?D]` from `at` (the "W"): the epoch day of that ISO week day, or undefined. */
function weekDate(text: string, year: number, sep: number, at: number): number | undefined {
  const week = digits(text, at + 1, 2);
  let next = at + 3;
  let day = 1;
  if (text.length > next) {
    // a day after the week; CPython also checks its dash here, but the separator search has already cut the date where
    // a dash would be inconsistent, so that check never fires
    next += sep;
    day = digits(text, next, 1);
    if (next + 1 !== text.length) return undefined;
  }
  if (!validWeek(year, week) || day < 1 || day > 7) return undefined;
  const ord = isoWeek1Monday(year) + (week - 1) * 7 + (day - 1);
  return ord <= LAST_DAY ? ord : undefined;
}

/** `MM-?DD` from `at`: the epoch day, or undefined. */
function calendarDate(text: string, year: number, sep: number, at: number): number | undefined {
  const month = digits(text, at, 2);
  if ((text[at + 2] === "-") !== (sep === 1)) return undefined;
  const dayAt = at + 2 + sep;
  const day = digits(text, dayAt, 2);
  if (dayAt + 2 !== text.length || month < 1 || month > 12) return undefined;
  return day >= 1 && day <= daysInMonth(year, month) ? epochDay(year, month, day) : undefined;
}

/** The date part (7, 8 or 10 characters) as an epoch day, or undefined (CPython's `parse_isoformat_date`). */
function dateOf(text: string): number | undefined {
  if (![7, 8, 10].includes(text.length)) return undefined;
  const year = digits(text, 0, 4);
  if (year < 1) return undefined;
  const sep = text[4] === "-" ? 1 : 0;
  const at = 4 + sep;
  return text[at] === "W" ? weekDate(text, year, sep, at) : calendarDate(text, year, sep, at);
}

interface Clock {
  readonly parts: readonly [number, number, number];
  readonly us: number;
  /** Something was left before `end` (CPython's return value 1): an error unless a time zone follows. */
  readonly rest: boolean;
}

function isAscii(text: string, at: number): boolean {
  return text.charCodeAt(at) < 0x80;
}

/**
 * `HH[:?MM[:?SS[{.,}f+]]]` in `text[from, end)`, as CPython's C `parse_hh_mm_ss_ff` reads it (the `datetime` module
 * Python uses): one stray ASCII character may close the last part read, which only a following time zone excuses.
 */
function clockOf(text: string, from: number, end: number): Clock | undefined {
  const parts: [number, number, number] = [0, 0, 0];
  let at = from;
  let colon = true;
  for (let i = 0; i < 3; i += 1) {
    const value = digits(text, at, 2);
    if (value < 0) return undefined;
    parts[i] = value;
    const c = text.charAt(at + 2);
    at += 3;
    if (i === 0) colon = c === ":";
    if (at >= end) return isAscii(text, at - 1) || c === "" ? { parts, us: 0, rest: c !== "" } : undefined;
    const step = stepAfter(c, i, colon);
    if (step === "fail") return undefined;
    if (step === "fraction") break;
    if (step === "again") at -= 1;
  }
  return fractionOf(text, parts, at, end);
}

/** What follows the `i`th two digits: the next part after a colon, the next part right away, a fraction, or an error. */
function stepAfter(c: string, i: number, colon: boolean): "next" | "again" | "fraction" | "fail" {
  if (colon && c === ":") return i === 2 ? "fail" : "next";
  if (c === "." || c === ",") return i < 2 ? "fail" : "fraction";
  return colon ? "fail" : "again";
}

/** Up to six digits of a fraction from `at` (more are read and dropped), as microseconds. */
function fractionOf(text: string, parts: Clock["parts"], from: number, end: number): Clock | undefined {
  const used = Math.min(end - from, 6);
  const value = digits(text, from, used);
  if (value < 0) return undefined;
  let at = from + used;
  while (digit(text, at) >= 0) at += 1;
  return { parts, us: value * 10 ** (6 - used), rest: at < text.length };
}

/** A zone `HH[:?MM[:?SS[.f+]]]` after its sign, in microseconds, or undefined; Python's timezone takes under a day. */
function zoneOf(text: string, sign: number, from: number): number | undefined {
  const zone = clockOf(text, from, text.length);
  if (zone === undefined || zone.rest) return undefined;
  const [h, m, s] = zone.parts;
  const us = ((h * 60 + m) * 60 + s) * 1e6 + zone.us;
  return us < 24 * HOUR * 1e6 ? sign * us : undefined;
}

/** The time part (after the separator): microseconds into the day and the offset in microseconds, or undefined. */
function timeOf(text: string): { readonly us: number; readonly offsetUs: number | undefined } | undefined {
  if (text.length === 0) return undefined;
  let tz = 0;
  // "Z" was written as "+00:00" before the text got here (the Python worker's own replace), so a zone starts at + or -
  while (tz < text.length && !"+-".includes(text.charAt(tz))) tz += 1;
  const clock = clockOf(text, 0, tz);
  if (clock === undefined) return undefined;
  const aware = tz < text.length;
  if (!aware && clock.rest) return undefined;
  const offsetUs = aware ? zoneOf(text, text[tz] === "-" ? -1 : 1, tz + 1) : undefined;
  if (aware && offsetUs === undefined) return undefined;
  const us = dayMicros(clock);
  return us === undefined ? undefined : { us, offsetUs };
}

/** Microseconds into the day of a clock time, 24:00 being the next midnight; undefined for one Python refuses. */
function dayMicros(clock: Clock): number | undefined {
  const [h, m, s] = clock.parts;
  if (h === 24 ? m || s || clock.us : h > 23 || m > 59 || s > 59) return undefined;
  return ((h * 60 + m) * 60 + s) * 1e6 + clock.us;
}

/** `d` as `m * 2^e` exactly; `d` is a normal double here (at least 2**53 / 10**6 in magnitude). */
function exact(d: number): { readonly m: bigint; readonly e: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  return { m: sign * (fraction | (1n << 52n)), e: exponent - 1075 };
}

/** The double one step from `d` (`step` 1 or -1 on its bit pattern). */
function neighbour(d: number, step: 1n | -1n): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d);
  view.setBigUint64(0, view.getBigUint64(0) + step);
  return view.getFloat64(0);
}

/**
 * `us / 10**6` rounded once to the nearest double, as Python divides two ints. `Number(us) / 1e6` rounds twice once
 * `us` passes 2**53 (from the year 2255 on), and can land one step off.
 */
function microsToSeconds(us: bigint): number {
  if (us <= 9_007_199_254_740_991n && us >= -9_007_199_254_740_991n) return Number(us) / 1e6;
  const first = Number(us / 1_000_000n) + Number(us % 1_000_000n) / 1e6;
  const target = us << 1074n;
  const distance = (d: number): bigint => {
    const { m, e } = exact(d);
    const gap = ((m * 1_000_000n) << BigInt(e + 1074)) - target;
    return gap < 0n ? -gap : gap;
  };
  let best = first;
  for (const candidate of [neighbour(first, -1n), neighbour(first, 1n)]) {
    const [a, b] = [distance(candidate), distance(best)];
    if (a < b || (a === b && (exact(candidate).m & 1n) === 0n)) best = candidate;
  }
  return best;
}

/** Seconds since the epoch of an ISO 8601 text as Python's `fromisoformat` reads it, or undefined where it refuses. */
export function isoSeconds(value: string): number | undefined {
  const text = value.replaceAll("Z", "+00:00");
  if (text.length < 7) return undefined;
  const sep = separatorAt(text);
  const day = dateOf(text.slice(0, sep));
  if (day === undefined) return undefined;
  let time: { readonly us: number; readonly offsetUs: number | undefined } | undefined = { us: 0, offsetUs: undefined };
  if (sep < text.length) {
    // the separator is any one character (a code point: CPython skips a whole UTF-8 sequence)
    time = timeOf(text.slice(sep + String.fromCodePoint(text.codePointAt(sep) ?? 0).length));
  }
  if (time === undefined) return undefined;
  if (time.us === 24 * HOUR * 1e6 && day === LAST_DAY) return undefined; // 24:00 on 9999-12-31 is year 10000
  const whole = BigInt(day) * 86_400_000_000n + BigInt(time.us);
  // aware: the exact microseconds, divided once (Python's total_seconds)
  if (time.offsetUs !== undefined) return microsToSeconds(whole - BigInt(time.offsetUs));
  // naive: local time, whole seconds plus the fraction (Python's timestamp() of a naive datetime); its search for the
  // local offset looks a day back, so the first day of year 1 fails there as here
  if (whole < BigInt(FIRST_DAY + 1) * 86_400_000_000n) return undefined;
  const seconds = Number(whole / 1_000_000n);
  const shift = new Date(seconds * 1000).getTimezoneOffset() * MINUTE;
  return seconds + shift + Number(whole % 1_000_000n) / 1e6;
}
