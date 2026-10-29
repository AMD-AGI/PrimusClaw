// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Cron schedules in a user's timezone.
 *
 * croner owns the calendar arithmetic, including daylight-saving transitions
 * (a wall-clock time that does not exist on a spring-forward day is skipped, and
 * one that occurs twice on a fall-back day fires once). Nothing here re-derives
 * a UTC offset by hand.
 */
import { Cron } from "croner";

export type ScheduleCheck = { ok: true } | { ok: false; error: string };

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

/** The next firing strictly after `after`, or null when the schedule has none. */
export function nextFireAfter(expr: string, timezone: string, after: Date): Date | null {
  const cron = new Cron(expr, { timezone, paused: true });
  return cron.nextRun(after);
}

/**
 * Whether a schedule is acceptable: five fields, a real timezone, and no two
 * consecutive firings closer than `minIntervalMinutes`. The gap is measured over
 * the next several occurrences, so a daily schedule passes and a ten-minute one does not.
 */
export function checkSchedule(
  expr: string, timezone: string, minIntervalMinutes: number, from: Date = new Date(),
): ScheduleCheck {
  if (typeof expr !== "string" || expr.trim().split(/\s+/).length !== 5) {
    return { ok: false, error: "schedule must be a five-field cron expression" };
  }
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) {
    return { ok: false, error: "timezone must be an IANA timezone name" };
  }
  let prev: Date | null;
  try {
    prev = nextFireAfter(expr, timezone, from);
  } catch {
    return { ok: false, error: "schedule is not a valid cron expression" };
  }
  if (!prev) return { ok: false, error: "schedule never fires" };
  for (let i = 0; i < 24; i++) {
    const next = nextFireAfter(expr, timezone, prev);
    if (!next) break;
    if (next.getTime() - prev.getTime() < minIntervalMinutes * 60_000) {
      return { ok: false, error: `schedule fires more often than every ${minIntervalMinutes} minutes` };
    }
    prev = next;
  }
  return { ok: true };
}
