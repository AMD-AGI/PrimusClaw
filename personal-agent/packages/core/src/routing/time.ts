// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { DEFAULT_TIMEZONE } from "../ports/store/policy.js";

/** A moment as a wall clock in a time zone shows it. */
export interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** "Mon", "Tue", ... (Python's `%a` in the C locale). */
  readonly weekday: string;
}

const IANA = /^[A-Z][A-Za-z_]*(?:\/[A-Z0-9][A-Za-z0-9_+-]*){0,2}$/u;

/**
 * Whether `name` is a time zone the worker takes (Python `ZoneInfo(name)` on the tz database's file names): a name the
 * runtime knows, written as the database writes it ("Asia/Shanghai", "UTC", "Etc/GMT+8"; not "asia/shanghai" or "+08:00").
 */
export function isTimeZone(name: string): boolean {
  if (!IANA.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The person's zone (`proactive.zone_of`): theirs when it is one, else the default. */
export function zoneOf(timezone: string): string {
  return isTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
}

/** `epochSeconds` on the wall clock of `zone`. */
export function wallClock(epochSeconds: number, zone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(epochSeconds * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: part("weekday"),
  };
}

export function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** "HH:MM" of a wall clock. */
export function hhmm(wall: Wall): string {
  return `${two(wall.hour)}:${two(wall.minute)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Python's `%b`. */
export function monthName(wall: Wall): string {
  return MONTHS[wall.month - 1] ?? "";
}

/** Days from `then` to `now` on the calendar (both wall dates in one zone). */
export function daysBetween(then: Wall, now: Wall): number {
  return Math.round(
    (Date.UTC(now.year, now.month - 1, now.day) - Date.UTC(then.year, then.month - 1, then.day)) / 86_400_000,
  );
}

/**
 * When a session was last used, in the person's zone: "today 12:40", "yesterday 18:05", else "03 Oct 09:15" (in Chinese
 * "今天 12:40", "昨天 18:05", else "10月03日 09:15") (the Python `render.when_text`).
 */
export function whenText(at: number, now: number, zone: string, lang: string): string {
  const then = wallClock(at, zone);
  const days = daysBetween(then, wallClock(now, zone));
  const clock = hhmm(then);
  if (lang === "zh") {
    if (days === 0) return `今天 ${clock}`;
    if (days === 1) return `昨天 ${clock}`;
    return `${two(then.month)}月${two(then.day)}日 ${clock}`;
  }
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `yesterday ${clock}`;
  return `${two(then.day)} ${monthName(then)} ${clock}`;
}
