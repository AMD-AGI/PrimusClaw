// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * INTERIM (W4b): the one file through which the turn module reaches what other lines own. Until their branches land,
 * minimal stand-ins live here; each block is replaced by a re-export of the owning line's module:
 * - Claw stream types and errors, `clipPrSummary`, `errorKind`, `serviceRefusal`: W2 (core/src/claw, ClawPort).
 * - step labels (`labelFor`, `failedLine`, `isShell`, `skillInCommand`): W2.
 * - public error (`looksLikeFailure`, `splitErrorTail`, `withhold`): W2.
 * - `pickLang`: W5 (approval view).
 */

import { clipWithEllipsis, collapseSpaces, pyStrip } from "../text/python-str.js";

// --- Claw (W2) -------------------------------------------------------------------------------------------------------

export { HISTORY_COMPLETE_EVENT as HISTORY_COMPLETE } from "../protocol.js";
export { ClawAnswerInvalid, ClawError, ClawUnreachable, errorKind, ReplayRefused } from "../claw/errors.js";
export type { SseEvent } from "../claw/model.js";

/** The message id of a turn Claw runs from its queue (api tasks/chat-run.ts). */
export const QUEUED_PREFIX = "claw-pending-";

export const SERVICE_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  service_client_not_allowed:
    "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client.",
  interactive_sign_in_required: "PrimusClaw did not take my credential for you as a sign-in; tell the operator.",
  only_the_acting_user_can_decide: "PrimusClaw says this answer is not yours to give.",
};

/** The sentence for a refusal of Claw's: its reason (a word it does not name is the last one) and what was not done. */
export function serviceRefusal(code: string, undone: string): string {
  const reason = SERVICE_REFUSAL_REASONS[code] ?? SERVICE_REFUSAL_REASONS["only_the_acting_user_can_decide"];
  return `${reason ?? ""} ${undone}`;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
const SUMMARY_MARKUP: Readonly<Record<string, string>> = { "[": "［", "]": "］", "<": "‹", ">": "›" };

/** A review's sentence of what the pull request does, as shown (interim: without credential masking). */
export function clipPrSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = pyStrip(collapseSpaces(value).replace(/[[\]<>]/g, (c) => SUMMARY_MARKUP[c] ?? c));
  if (!line) return "";
  return clipWithEllipsis(line, CJK.test(line) ? 80 : 160);
}

// --- language (W5) ---------------------------------------------------------------------------------------------------

export { hasCjk, pickLang } from "../language/detect.js";

// --- public error (W2) -----------------------------------------------------------------------------------------------

const SERVICE_ERROR =
  /^\s*(?:(?:API |[A-Za-z_.]{1,40})Error:\s*){0,3}[1-5]\d\d\b|^\s*Traceback \(most recent call last\)|^\s*(?:API Error|[A-Za-z_.]{0,40}(?:Error|Exception))\s*:/;
const BRAIN_ERROR =
  /^\s*(?:(?:API |[A-Za-z_.]{1,40})Error:\s*){0,3}[1-5]\d\d\b|^\s*Traceback \(most recent call last\)|^\s*(?:API Error|[A-Za-z_]{1,30}\.[A-Za-z_.]{0,40}(?:Error|Exception))\s*:/;

/** True when `text` is the error a model call or a service failed with (interim: Brain's error shape only). */
export function looksLikeFailure(text: unknown): boolean {
  return typeof text === "string" && SERVICE_ERROR.test(text);
}

/** A failed turn's last text split into the model's own words and Brain's error that ended it (interim: no fences). */
export function splitErrorTail(text: unknown): [string, string] {
  if (typeof text !== "string" || !pyStrip(text)) return ["", ""];
  const paragraphs = text.split(/(\n[ \t]*\n)/);
  let at = 0;
  for (let i = 0; i < paragraphs.length; i += 2) {
    const para = paragraphs[i] ?? "";
    if (BRAIN_ERROR.test(para.replace(/^\n+/, ""))) {
      return [text.slice(0, at).trimEnd(), pyStrip(text.slice(at))];
    }
    at += para.length + (paragraphs[i + 1]?.length ?? 0);
  }
  return [text, ""];
}
