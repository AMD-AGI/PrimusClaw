// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What came of a press on a seat card (`seat_role`, `seat_set`): what Claw kept for the seat (its alias and role, as the card showed
 * them), that the seat was retired, or why nothing was kept; in one line.
 */
import { seatOutcomeText } from "../locales/assistant-seats.js";
import type { Lang } from "../locales/lang.js";

type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function seatOutcome(kind: "seat_role" | "seat_set", status: string, out: Fields, lang: Lang): string {
  const t = seatOutcomeText.in(lang);
  const result = fieldsOf(out["result"]);
  if (status === "done" && Boolean(out["answered_now"])) {
    const alias = text(result["alias"]);
    const role = text(result["role"]);
    return t.kept({ what: [alias, role].filter(Boolean).join(lang === "zh" ? "，" : ", ") });
  }
  if (status === "done") return t.alreadyAnswered;
  if (status === "denied") return kind === "seat_role" ? t.retired : t.denied;
  if (status === "expired") return t.expired;
  const error = text(result["error"]);
  if (error === "stale") return t.stale;
  if (error === "no_seat") return t.gone;
  return t.failed({ why: error || status });
}
