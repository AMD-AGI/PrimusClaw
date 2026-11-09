// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How long ago, and clock times, as the remote-agent cards say them. */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/;

/** Seconds since the epoch of an ISO 8601 time as Claw writes it (`2026-10-29T05:00:00Z`, an offset, or fractional seconds), or
 * null when it is none. A time without an offset is read as UTC. */
export function parseIsoSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", , sign, oh = "0", om = "0", os = "0"] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const date = new Date(ms);
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59) {
    return null;
  }
  if (Number(s) > 59) return null;
  const offset = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60 + Number(os)) : 0;
  return ms / 1000 + Number(`0.${frac || "0"}`) - offset;
}

/** "just now", "3 h ago": how long before `now` (seconds since the epoch) the ISO time `when` was; "" when it is no time. */
export function ago(now: number, when: unknown, lang: Lang = "en"): string {
  const at = parseIsoSeconds(when);
  return at === null ? "" : agoSeconds(now, at, lang);
}

/** `ago` for a time in seconds since the epoch; "" for none. */
export function agoEpoch(now: number, when: number | null, lang: Lang = "en"): string {
  return when === null ? "" : agoSeconds(now, Math.max(0, when), lang);
}

function agoSeconds(now: number, at: number, lang: Lang): string {
  const seconds = Math.max(0, Math.trunc(now - at));
  if (seconds < 90) return remoteText.in(lang).justNow;
  if (seconds >= 86400) return remoteText.in(lang).daysAgo({ n: Math.floor(seconds / 86400) });
  if (seconds >= 3600) return remoteText.in(lang).hoursAgo({ n: Math.floor(seconds / 3600) });
  return remoteText.in(lang).minutesAgo({ n: Math.floor(seconds / 60) });
}

function parts(seconds: number, zone: string): Record<string, string> {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(format.formatToParts(new Date(seconds * 1000)).map((p) => [p.type, p.value]));
}

/** `HH:MM` of `seconds` in the time zone `zone` (an IANA name). */
export function clock(seconds: number, zone: string): string {
  const p = parts(seconds, zone);
  return `${p["hour"]}:${p["minute"]}`;
}

/** `HH:MM:SSZ` of `seconds` in UTC. */
export function utcClock(seconds: number): string {
  const p = parts(seconds, "UTC");
  return `${p["hour"]}:${p["minute"]}:${p["second"]}Z`;
}

/** `MM-DD HH:MMZ` of `seconds` in UTC. */
export function utcStamp(seconds: number): string {
  const p = parts(seconds, "UTC");
  return `${p["month"]}-${p["day"]} ${p["hour"]}:${p["minute"]}Z`;
}
