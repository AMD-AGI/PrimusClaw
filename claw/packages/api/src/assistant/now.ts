// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What "now" is for the person a router turn answers: the date, weekday and time in their time zone, beside UTC. The router was told
 * only `now is 2026-11-13 16:40 UTC` (the item list's clock), and asked "今天是星期几？" after midnight in Beijing it answered Friday,
 * the UTC weekday, with Saturday in a note (sa-eval public-general-irr-026, 2026-11-13 16:40Z). The person's zone is the one their chat
 * sends (`channel_context.timezone`, the zone they set there); a chat that sends none gets the default, Asia/Shanghai, the zone the
 * personal agent's quiet hours and the router's scheduled tasks assume.
 */

/** The zone of a person whose chat names none. */
export const DEFAULT_USER_TIMEZONE = "Asia/Shanghai";

/** The clock a router turn reads, a port so a test can pin it. */
export const routerClock = { now: (): Date => new Date() };

/** An IANA time zone this runtime knows (`Asia/Shanghai`, `UTC`, `America/Los_Angeles`), or undefined for anything else. */
export function timeZoneOf(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(raw)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** `Saturday 2026-11-14 00:40` in `zone`. */
export function wallClock(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${v("weekday")} ${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}`;
}

/** The router's line of what now is for the person, in their zone first. */
export function renderNowState(now: Date, channelZone?: string): string {
  const zone = timeZoneOf(channelZone) ?? DEFAULT_USER_TIMEZONE;
  const whose = channelZone && timeZoneOf(channelZone)
    ? "the user's time zone, as their chat says"
    : "their chat names no time zone, so the default one";
  const utc = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `Now, for the user: ${wallClock(now, zone)} in ${zone} (${whose}); ${utc}. `
    + `Today, a weekday, a date or a time the user asks about (今天几号, 星期几, 明天, what day is it) is in ${zone}: answer with that, `
    + "as the answer, not in a note; give UTC or another zone only when they ask for it.";
}
