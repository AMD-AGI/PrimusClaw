// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawAnswerInvalid } from "./errors.js";
import { isObject, someText, wholeNumber } from "./lenient.js";
import type { PullRef, ReviewStart } from "./model.js";

/** `{owner, repo, number}` as Claw wrote it, or null. */
function targetOf(raw: unknown): PullRef | null {
  if (!isObject(raw)) return null;
  const { owner, repo, number } = raw;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  return typeof number === "number" && Number.isInteger(number) ? { owner, repo, number } : null;
}

/** The model Claw says a review runs on: a string as it is, "" for a `model` that is there but not a string, else null. */
function modelOf(raw: Record<string, unknown>): string | null {
  const model = raw["model"];
  if (typeof model === "string") return model;
  return "model" in raw ? "" : null;
}

/** true / false when Claw says how a merge is made (it sends `review_only` with every item once it does), else null. */
function heldOf(raw: Record<string, unknown>): boolean | null {
  return "review_only" in raw || "merge_needs_confirmation" in raw ? raw["merge_needs_confirmation"] === true : null;
}

/** The limit that was full when Claw queued the item ("queued" when it did not say which; "" it started). */
function queuedOf(raw: Record<string, unknown>): string {
  const queued = raw["queued"];
  if (!isTruthy(queued)) return "";
  const reason = isObject(queued) ? queued["reason"] : undefined;
  return typeof reason === "string" && reason !== "" ? reason : "queued";
}

/** Python's truth of a JSON value. */
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function readOne(raw: unknown, followed: boolean): ReviewStart {
  const row = isObject(raw) ? raw : {};
  const target = targetOf(row["pr"]);
  const itemId = row["item_id"];
  let sessionId = row["session_id"];
  if (!followed && (sessionId === undefined || sessionId === null)) sessionId = "";
  if (target === null || typeof sessionId !== "string" || (followed && sessionId === "")) {
    throw new ClawAnswerInvalid("a review item without its pull request, item or session");
  }
  if (typeof itemId !== "string" || itemId === "") {
    throw new ClawAnswerInvalid("a review item without its pull request, item or session");
  }
  const { message_id: messageId, fell_back_from: fellBack, ignored } = row;
  return {
    target,
    itemId,
    seq: wholeNumber.parse(row["seq"]) ?? 0,
    title: someText.parse(row["title"]) ?? "",
    sessionId,
    messageId: typeof messageId === "string" ? messageId : "",
    model: modelOf(row),
    fellBackFrom: typeof fellBack === "string" ? fellBack : "",
    ignored: Array.isArray(ignored) ? ignored.filter((i): i is string => typeof i === "string") : [],
    mergeNeedsConfirmation: heldOf(row),
    queued: queuedOf(row),
    mergeByRequester: row["merge_by_requester"] === true,
  };
}

/**
 * Claw's `data` for reviews it started. One without its pull request or its session cannot be told from the others or
 * followed: an answer this client does not understand (ClawAnswerInvalid), never a review that is quietly not shown.
 * `followed` false: reviews asked of someone else, whose sessions are that person's; none is needed.
 */
export function parseStartedReviews(data: unknown, followed = true): ReviewStart[] {
  if (!isObject(data) || !Array.isArray(data["items"])) {
    throw new ClawAnswerInvalid("not a list of started reviews");
  }
  return data["items"].map((raw) => readOne(raw, followed));
}
