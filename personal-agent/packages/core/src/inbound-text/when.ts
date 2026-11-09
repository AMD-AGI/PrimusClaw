// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The time a channel gave for a quoted message, as the text the model reads ("2026-11-03 08:36 UTC"), or "" when it is
 * not a time: the Python worker's `activity._when`. Epoch seconds or milliseconds (more than ten digits), or an ISO
 * 8601 date as `datetime.fromisoformat` reads it (a time without an offset is UTC).
 *
 * Differences from CPython, chosen: only ASCII digits are a number (Python's `int()` also reads other decimal digits);
 * a time an offset moves out of the years 1-9999 is "" (Python raised there).
 */
import { pyStrip } from "../text/py-text.js";

/** The last instant `datetime` can hold, in epoch milliseconds (9999-12-31 23:59:59.999 UTC). */
const MAX_MS = 253402300799999;
const DAY_MS = 86_400_000;

const DIGITS = /^[0-9]+$/;
const CALENDAR = /^([0-9]{4})(?:-([0-9]{2})-([0-9]{2})|([0-9]{2})([0-9]{2}))/;
const WEEK = /^([0-9]{4})(?:-W([0-9]{2})(?:-([1-7]))?|W([0-9]{2})([1-7])?)/;
const TIME =
  /^[\s\S]([0-9]{2})(?::([0-9]{2})(?::([0-9]{2})(?:[.,][0-9]+)?)?|([0-9]{2})(?:([0-9]{2})(?:[.,][0-9]+)?)?)?(Z|[+-][0-9]{2}(?::?[0-9]{2}(?::?[0-9]{2}(?:\.[0-9]+)?)?)?)?$/u;
const OFFSET = /^([+-])([0-9]{2})(?::?([0-9]{2})(?::?([0-9]{2}))?)?/;

function num(text: string | undefined): number {
  return text === undefined || text === "" ? 0 : Number(text);
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** Midnight UTC of a calendar day, in epoch milliseconds; undefined when there is no such day. */
function dayMs(year: number, month: number, day: number): number | undefined {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

/** Midnight UTC of an ISO week day (`2026-W45-2`); undefined when there is no such week. */
function weekDayMs(year: number, week: number, weekday: number): number | undefined {
  const jan4 = dayMs(year, 1, 4);
  if (jan4 === undefined || week < 1 || week > 53) return undefined;
  const isoDay = (new Date(jan4).getUTCDay() + 6) % 7; // Monday 0
  if (week === 53) {
    // Only a year that starts on a Thursday, or a leap year that starts on a Wednesday, has a 53rd week.
    const jan1 = (isoDay + 4) % 7;
    const leap = daysInMonth(year, 2) === 29;
    if (!(jan1 === 3 || (leap && jan1 === 2))) return undefined;
  }
  return jan4 - isoDay * DAY_MS + ((week - 1) * 7 + (weekday - 1)) * DAY_MS;
}

/** The date at the start of `raw` and how long it is. */
function dateOf(raw: string): { ms: number; length: number } | undefined {
  const calendar = CALENDAR.exec(raw);
  if (calendar) {
    const ms = dayMs(num(calendar[1]), num(calendar[2] ?? calendar[4]), num(calendar[3] ?? calendar[5]));
    return ms === undefined ? undefined : { ms, length: calendar[0].length };
  }
  const week = WEEK.exec(raw);
  if (!week) return undefined;
  const ms = weekDayMs(num(week[1]), num(week[2] ?? week[4]), num(week[3] ?? week[5]) || 1);
  return ms === undefined ? undefined : { ms, length: week[0].length };
}

/** The offset east of UTC in milliseconds ("Z" or ±HH[:MM[:SS]]); undefined when it is not one Python accepts. */
function offsetMs(zone: string | undefined): number | undefined {
  if (zone === undefined || zone === "Z") return 0;
  const parts = OFFSET.exec(zone);
  if (!parts) return undefined;
  const ms = ((num(parts[2]) * 60 + num(parts[3])) * 60 + num(parts[4])) * 1000;
  // CPython checks only the whole: "+01:60" is two hours.
  if (ms >= DAY_MS) return undefined;
  return parts[1] === "-" ? -ms : ms;
}

/** The time of day after the date (with its separator), in milliseconds from midnight UTC; undefined when invalid. */
function timeOf(rest: string): number | undefined {
  if (rest === "") return 0;
  const parts = TIME.exec(rest);
  if (!parts) return undefined;
  const hour = num(parts[1]);
  const minute = num(parts[2] ?? parts[4]);
  const second = num(parts[3] ?? parts[5]);
  if (hour > 24 || minute > 59 || second > 59 || (hour === 24 && (minute > 0 || second > 0))) return undefined;
  const offset = offsetMs(parts[6]);
  if (offset === undefined) return undefined;
  return ((hour * 60 + minute) * 60 + second) * 1000 - offset;
}

function epochMs(raw: string): number | undefined {
  if (DIGITS.test(raw)) return raw.length > 10 ? Number(raw) : Number(raw) * 1000;
  const date = dateOf(raw);
  if (date === undefined) return undefined;
  const time = timeOf(raw.slice(date.length));
  return time === undefined ? undefined : date.ms + time;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `activity._when(raw)`: the UTC minute `raw` names, or "". */
export function whenOf(raw: string): string {
  const ms = epochMs(pyStrip(raw));
  const first = dayMs(1, 1, 1) ?? 0;
  if (ms === undefined || !Number.isFinite(ms) || ms > MAX_MS || ms < first) return "";
  // Epoch milliseconds keep sub-millisecond digits only for an over-long number: the minute is all that is shown.
  const date = new Date(Math.floor(ms));
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
