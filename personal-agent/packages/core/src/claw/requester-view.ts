// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { redactText } from "../redact/index.js";
import { cpHead, cpLength, cpSlice, pyRstrip, pyStrip, squashSpaces } from "../text/py-text.js";
import { isObject } from "./lenient.js";
import type { AskerView } from "./model.js";

/** A pull request's one-sentence summary is shown at most this long (code points): Chinese, Japanese, Korean / other. */
export const PR_SUMMARY_MAX_CJK = 80;
export const PR_SUMMARY_MAX_OTHER = 160;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿\u{20000}-\u{2fa1f}]/u;
/** Brackets that markdown or HTML would read as a link or a tag become their full-width forms. */
const SUMMARY_MARKUP: Readonly<Record<string, string>> = { "[": "［", "]": "］", "<": "‹", ">": "›" };

/**
 * A review's sentence of what the pull request does, as it is shown: one line, credentials masked, no link or tag
 * markup, at most PR_SUMMARY_MAX_CJK code points when it is Chinese and PR_SUMMARY_MAX_OTHER otherwise (a longer one
 * is cut and ends in an ellipsis). "" for anything that is not a non-empty string.
 */
export function clipPrSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const masked = redactText(squashSpaces(value)).text;
  const line = pyStrip(masked.replace(/[[\]<>]/g, (ch) => SUMMARY_MARKUP[ch] ?? ch));
  if (line === "") return "";
  const limit = CJK.test(line) ? PR_SUMMARY_MAX_CJK : PR_SUMMARY_MAX_OTHER;
  return cpLength(line) <= limit ? line : pyRstrip(cpSlice(line, 0, limit - 1)) + "…";
}

/** `requester_view` wherever Claw's answer puts it: the answer itself, `requester_view`, or `params.requester_view`. */
function viewFields(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  const params = raw["params"];
  for (const found of [raw["requester_view"], isObject(params) ? params["requester_view"] : undefined]) {
    if (isObject(found)) return found;
  }
  return "status" in raw && ("pr_url" in raw || "verdict" in raw || "merged" in raw) ? raw : null;
}

/** A string field, lower-cased and cut to 40 code points ("" when it is not a string). */
function word(value: unknown): string {
  return typeof value === "string" ? cpHead(value.toLowerCase(), 40) : "";
}

/**
 * The asker's view of a review item from Claw's answer; null when the answer carries none. Only the view's own fields
 * are read.
 */
export function parseRequesterView(raw: unknown, itemId: string): AskerView | null {
  const view = viewFields(raw);
  if (view === null) return null;
  const { pr_url: prUrl, pr, status, findings, note } = view;
  const url = typeof prUrl === "string" ? prUrl : typeof pr === "string" ? pr : "";
  return {
    itemId,
    status: typeof status === "string" ? status : "",
    prUrl: cpHead(url, 300),
    verdict: word(view["verdict"]),
    merged: view["merged"] === true,
    waitingFor: word(view["waiting_for"]),
    findings: typeof findings === "number" && Number.isInteger(findings) && findings >= 0 ? findings : null,
    note: typeof note === "string" ? cpHead(squashSpaces(note), 200) : "",
    prSummary: clipPrSummary(view["pr_summary"]),
  };
}
