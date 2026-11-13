// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What came of a press on a held write's card (teams_agent/agent.py `confirm_outcome`, `comment_outcome`,
 * `devenv_send_outcome`): Claw's answer to the person's answer (`decideConfirmation`), said plainly in one line, in their
 * language. Every field is Claw's and is read as the Python worker read it (`str(x or "")`).
 */
import {
  COMMENT_FAILED,
  CONFIRM_FAILED,
  DEVENV_SEND_FAILED,
  assistantActionText,
} from "../locales/assistant-actions.js";
import type { Lang } from "../locales/lang.js";
import { devenvHideOutcome } from "./devenv-hide-outcome.js";
import { skillText } from "../locales/skills.js";

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python's `str(value)` for a JSON value that is shown as text. */
function shown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null || value === undefined) return "None";
  return JSON.stringify(value);
}

/** `str(value or fallback)`. */
function or(value: unknown, fallback: string): string {
  return truthy(value) ? shown(value) : fallback;
}

/** Python's `datetime.fromisoformat` (3.12) of the forms Claw sends: an instant in ms, or undefined for a text it refuses. */
const ISO =
  /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))(?:[^\d](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d+)?)?)?)?)?$/u;

function offsetSeconds(zone: string | undefined): number {
  if (zone === undefined || zone === "Z") return 0;
  const [h = "0", m = "0", s = "0"] =
    zone
      .slice(1)
      .replace(/:/g, "")
      .match(/\d{2}(?:\.\d+)?/g) ?? [];
  const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s);
  return zone.startsWith("-") ? -seconds : seconds;
}

function parseIso(text: string): number | undefined {
  const m = ISO.exec(text);
  if (m === null) return undefined;
  const n = (i: number): number => Number(m[i] ?? "0");
  const [year, month, day] = [1, 2, 3].map((i) => Number(m[i] ?? m[i + 3])) as [number, number, number];
  const [hour, minute, second] = [n(7), n(8), n(9)];
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, Number(`0.${m[10] ?? "0"}`.slice(0, 8)) * 1000);
  const same =
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second;
  return same ? at.getTime() - offsetSeconds(m[11]) * 1000 : undefined;
}

/** The formatter of `zone`, or undefined for a zone the Python worker's ZoneInfo would not open (it is case-sensitive). */
function zoneFormat(zone: string): Intl.DateTimeFormat | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return undefined;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return undefined;
  }
  const resolved = format.resolvedOptions().timeZone;
  return resolved.toLowerCase() === zone.toLowerCase() && resolved !== zone ? undefined : format;
}

/** An ISO time as the person reads it: their wall clock in the trigger's timezone, `2026-11-07 09:00` (else the text as sent). */
export function localTime(at: unknown, zone: string): string {
  const raw = or(at, "");
  const instant = at === null || at === undefined ? undefined : parseIso(shown(at));
  const format = instant === undefined ? undefined : zoneFormat(zone);
  if (instant === undefined || format === undefined) return raw;
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    format.formatToParts(instant).find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function failed(table: typeof CONFIRM_FAILED, error: string, lang: Lang): string | undefined {
  return Object.hasOwn(table, error) ? table[error]?.[lang] : undefined;
}

/**
 * A comment's address on GitHub as Claw gives it back, shown as a link only when the whole value is exactly one (as the Python
 * worker reads it): https, the host github.com, a pull request's or an issue's path and the comment's anchor (or none); no line
 * break, space, query, port or user. A value that only starts like one could carry a second link.
 */
const COMMENT_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/(?:pull|issues)\/[1-9][0-9]{0,6}(?:#(?:issuecomment-|discussion_r|pullrequestreview-)[1-9][0-9]{0,19})?$/;

/** A comment's address from GitHub, shown as a link only when it is exactly one. */
function commentLink(result: Fields): string {
  const url = or(result["url"], "");
  return COMMENT_URL.test(url) ? url : "";
}

/** What came of a press on a drafted comment's card, or undefined for what every card says alike (answered before, lapsed). */
export function commentOutcome(out: Fields, lang: Lang): string | undefined {
  const t = assistantActionText.in(lang);
  const status = or(out["status"], "");
  const result = fields(out["result"]);
  if (status === "done" && truthy(out["answered_now"])) return t.commentPosted({ link: commentLink(result) });
  if (status === "denied") return t.commentDenied;
  if (status !== "failed") return undefined;
  const error = or(result["error"], "");
  return failed(COMMENT_FAILED, error, lang) ?? t.commentNotPosted({ why: error || status });
}

/** What came of a press on an instruction card (`devenv_send`): sent, as which item, or why not. */
export function devenvSendOutcome(status: string, out: Fields, lang: Lang): string {
  const t = assistantActionText.in(lang);
  const result = fields(out["result"]);
  if (status === "done" && truthy(out["answered_now"])) {
    const seq = truthy(result["seq"]) ? shown(result["seq"]) : "";
    return t.sent({ agent: or(result["agent"], "agent"), machine: or(result["machine"], ""), seq });
  }
  if (status === "done") return t.alreadyAnswered;
  if (status === "denied") return t.notSent;
  if (status === "expired") return t.sendExpired;
  const error = or(result["error"], "");
  return failed(DEVENV_SEND_FAILED, error, lang) ?? t.notSentWhy({ why: error || status });
}

function triggerDone(create: boolean, out: Fields, lang: Lang): string {
  const t = assistantActionText.in(lang);
  if (!create) return t.triggerCancelled;
  const trigger = fields(fields(out["result"])["trigger"]);
  const tz = or(trigger["timezone"], "UTC");
  const next = localTime(trigger["next_fire_at"], tz);
  return t.scheduled({ name: or(trigger["name"], ""), schedule: or(trigger["schedule"], ""), tz, next });
}

/** What came of Save or Discard on a drafted skill's card: saved (which version), discarded, or why not. */
export function skillSaveOutcome(status: string, out: Fields, lang: Lang): string {
  const t = assistantActionText.in(lang);
  const s = skillText.in(lang);
  const result = fields(out["result"]);
  if (status === "done" && truthy(out["answered_now"])) {
    const version = typeof result["version"] === "number" ? result["version"] : 1;
    return s.draftSaved({ name: or(result["name"], ""), version });
  }
  if (status === "done") return t.alreadyAnswered;
  if (status === "denied") return s.draftDiscarded;
  if (status === "expired") return t.expired;
  return s.refused({ why: or(result["message"], or(result["error"], status)) });
}

/** What came of a press on a held write's card of `kind`, in one line: Claw's answer said plainly. */
export function confirmOutcome(kind: string, out: Fields, lang: Lang): string {
  const t = assistantActionText.in(lang);
  const status = or(out["status"], "");
  const create = kind === "trigger_create";
  if (kind === "devenv_send") return devenvSendOutcome(status, out, lang);
  if (kind === "devenv_hide") return devenvHideOutcome(status, out, lang);
  if (kind === "skill_save") return skillSaveOutcome(status, out, lang);
  const comment = kind === "github_comment" ? commentOutcome(out, lang) : undefined;
  if (comment !== undefined) return comment;
  if (status === "done" && truthy(out["answered_now"])) return triggerDone(create, out, lang);
  if (status === "done") return t.alreadyAnswered;
  if (status === "denied") return create ? t.notCreated : t.notCancelled;
  if (status === "expired") return t.expired;
  const error = or(fields(out["result"])["error"], "");
  return failed(CONFIRM_FAILED, error, lang) ?? t.notDone({ why: error || status });
}
