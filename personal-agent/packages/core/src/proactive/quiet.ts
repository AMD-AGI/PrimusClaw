// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * When something unasked may reach a person (teams_agent/proactive.py): quiet hours in their time zone, an explicit pause, and the
 * expiry of an approval or a remote agent's permission request that was held.
 */
import { DEFAULT_TIMEZONE, type Prefs } from "../ports/store/index.js";

/** When an approval event carries no usable `expires_at`: fail closed, a short life. */
export const APPROVAL_DEFAULT_SECONDS = 600;
/** When a pushed permission request carries no usable `expires_at`. */
export const PERMISSION_DEFAULT_SECONDS = 600;
/** A pushed permission request runs out at most this long from now. */
const PERMISSION_MAX_SECONDS = 3600;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat | undefined {
  const known = formatters.get(zone);
  if (known) return known;
  try {
    const made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, made);
    return made;
  } catch {
    return undefined; // (an unknown zone: the caller falls back to the default)
  }
}

/** The person's time zone when it is one this runtime knows, else DEFAULT_TIMEZONE (Python's `zone_of`). */
export function zoneOf(prefs: Pick<Prefs, "timezone">): string {
  return prefs.timezone && formatter(prefs.timezone) ? prefs.timezone : DEFAULT_TIMEZONE;
}

/** Minutes since local midnight of `epochSeconds` in `zone`. */
export function localMinutes(epochSeconds: number, zone: string): number {
  const parts = (formatter(zone) ?? formatter(DEFAULT_TIMEZONE))?.formatToParts(new Date(epochSeconds * 1000)) ?? [];
  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

function minutesOf(clock: string): number {
  const [hour = "0", minute = "0"] = clock.split(":");
  return Number(hour) * 60 + Number(minute);
}

/** Is `now` inside the daily window [start, end) in `zone`? A window may wrap midnight (22:00-08:00); start == end is none. */
export function inQuiet(now: number, zone: string, start: string, end: string): boolean {
  const minute = localMinutes(now, zone);
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === e) return false;
  return s < e ? s <= minute && minute < e : minute >= s || minute < e;
}

export type Muted = "paused" | "quiet";

/** Why nothing may be pushed right now, or undefined when it may. */
export function muted(prefs: Prefs, now: number): Muted | undefined {
  if (prefs.pausedUntil !== null && now < prefs.pausedUntil) return "paused";
  if (prefs.quietEnabled && inQuiet(now, zoneOf(prefs), prefs.quietStart, prefs.quietEnd)) return "quiet";
  return undefined;
}

/**
 * An ISO time with an offset, as epoch seconds; undefined for anything else (Python's `datetime.fromisoformat` on a "Z" or
 * "+hh:mm" time: a time without an offset cannot be compared safely).
 */
export function isoSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const match = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2})?)$/.exec(
    raw.trim(),
  );
  if (!match) return undefined;
  const at = Date.parse(raw.trim().replace(" ", "T"));
  return Number.isNaN(at) ? undefined : at / 1000;
}

/** When an approval event runs out: its `approval.expires_at`, else APPROVAL_DEFAULT_SECONDS from now. */
export function approvalExpiry(event: Readonly<Record<string, unknown>>, now: number): number {
  const approval = event["approval"];
  const raw =
    typeof approval === "object" && approval !== null ? (approval as Record<string, unknown>)["expires_at"] : undefined;
  return isoSeconds(raw) ?? now + APPROVAL_DEFAULT_SECONDS;
}

/** When a pushed permission request runs out: its `expires_at`, at most an hour on; else PERMISSION_DEFAULT_SECONDS from now. */
export function remoteAskExpiry(ask: Readonly<Record<string, unknown>>, now: number): number {
  const at = isoSeconds(ask["expires_at"]);
  return at === undefined ? now + PERMISSION_DEFAULT_SECONDS : Math.min(at, now + PERMISSION_MAX_SECONDS);
}
