// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What came of a press on a hide card (`devenv_hide`): how many conversations were hidden, shown again and disconnected, or why
 * nothing was; in one line (teams_agent/agent.py `devenv_hide_outcome`).
 */
import { devenvHideText } from "../locales/assistant-devenv-hide.js";
import type { Lang } from "../locales/lang.js";
import { own } from "../own.js";

type Fields = Readonly<Record<string, unknown>>;

function count(result: Fields, key: string): number {
  const value = own(result, key);
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

/** Python's `str(x or default)` for a field Claw sends as text. */
function textOr(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && value !== 0) return String(value);
  return fallback;
}

export function devenvHideOutcome(status: string, out: Fields, lang: Lang): string {
  const t = devenvHideText.in(lang);
  const result = fieldsOf(out["result"]);
  if (status === "done" && Boolean(out["answered_now"])) {
    const parts = [
      count(result, "hidden") ? t.hidden({ n: count(result, "hidden") }) : "",
      count(result, "shown_again") ? t.shownAgain({ n: count(result, "shown_again") }) : "",
      count(result, "disconnected") ? t.disconnected({ n: count(result, "disconnected") }) : "",
    ].filter(Boolean);
    return parts.length ? t.done({ parts, hidden: count(result, "hidden") !== 0 }) : t.nothing;
  }
  if (status === "done") return t.alreadyAnswered;
  if (status === "denied") return t.denied;
  if (status === "expired") return t.expired;
  return t.failed({ why: textOr(result["error"], status) });
}
