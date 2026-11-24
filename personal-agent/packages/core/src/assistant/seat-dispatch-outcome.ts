// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What came of a press on a seat dispatch's card (`seat_dispatch`): sent to the seat as which item, waiting in line behind which
 * items, or why nothing was sent; in one line, in the person's language. Every field is Claw's and is read defensively.
 */
import { SEAT_DISPATCH_FAILED, seatDispatchText } from "../locales/assistant-seats.js";
import type { Lang } from "../locales/lang.js";

type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

/** One plain line of Claw's words, at most `max` code points; "" for anything else. */
function line(value: unknown, max = 60): string {
  const flat = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return Array.from(flat).length <= max ? flat : "";
}

/** A positive whole number as text; "" for anything else. */
function count(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";
}

/** The items ahead in line, as people say them: #9, #10. */
function ahead(value: unknown): string {
  const seqs = (Array.isArray(value) ? (value as unknown[]) : []).map(count).filter(Boolean);
  return seqs
    .slice(0, 3)
    .map((s) => `#${s}`)
    .join(", ");
}

/** Sent to the seat (or waiting in line for it): to whom, as which item, behind which items. */
function dispatched(result: Fields, lang: Lang, picked: string): string {
  const t = seatDispatchText.in(lang);
  const who = line(result["alias"], 40) || line(result["label"], 40) || picked || t.theSeat;
  const seq = count(result["seq"]);
  if (result["dispatch"] === "queued") {
    const reason = result["queued_reason"];
    const why = reason === "in_terminal" ? t.inTerminal : reason === "machine_offline" ? t.offline : t.busy;
    return t.queued({ who, why, seq, position: count(result["position"]), ahead: ahead(result["ahead"]) });
  }
  return t.sent({ who, seq });
}

/**
 * What came of the press: `picked` is the label of the place a choice card's press picked ("" for a card of one place), said when
 * Claw names no seat back.
 */
export function seatDispatchOutcome(status: string, out: Fields, lang: Lang, picked = ""): string {
  const t = seatDispatchText.in(lang);
  const result = fieldsOf(out["result"]);
  if (status === "done" && Boolean(out["answered_now"])) return dispatched(result, lang, picked);
  if (status === "done") return t.alreadyAnswered;
  if (status === "denied") return t.notSent;
  if (status === "expired") return t.expired;
  const error = line(result["error"]);
  const known = Object.hasOwn(SEAT_DISPATCH_FAILED, error) ? SEAT_DISPATCH_FAILED[error]?.[lang] : undefined;
  return known ?? t.failed({ why: error || status || "?" });
}
