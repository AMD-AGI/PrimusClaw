// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What reaches a person unasked, as views (the arguments of teams_agent/render.py event_card, digest_card, approval_card,
 * item_approval_card and item_question_card, one for one), and the pure helpers their cards share: the one link a card may open,
 * a clock time in the person's zone, and the line that names which work item asks.
 */
import type { JsonObject } from "../json.js";
import { asText, pickLang } from "../language/detect.js";
import type { Lang } from "../locales/lang.js";
import { proactiveText } from "../locales/proactive.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import { redactText } from "../security/redact.js";
import { clip } from "../text/plain.js";

/** The longest summary a notice shows. */
export const NOTICE_SUMMARY_MAX = 280;
/** What Claw sends as an approval's target is at most this long; a bash command is shown whole. */
export const TARGET_MAX = 300;
/** At a phone's width 300 characters are about 6 lines; the card keeps four and the clip marks the rest. */
export const TARGET_LINES = 4;
/** The longest work item title a request card names. */
export const ITEM_TITLE_MAX = 80;

/** A Claw event (run.completed, run.failed, another notice) as a card (render.event_card). */
export interface RunEventModel {
  /** The event, made public first (`publicRunEvent`). */
  readonly event: JsonObject;
  readonly publicBaseUrl: string;
}

/** Everything held back while the person was away, as one card (render.digest_card). */
export interface DigestModel {
  readonly events: readonly JsonObject[];
  /** Approvals that ran out while held, and were refused. */
  readonly expiredApprovals: number;
  readonly publicBaseUrl: string;
}

/** An approval.requested event of a run (render.approval_card), or of a work item (render.item_approval_card). */
export interface ProactiveApprovalModel {
  readonly event: JsonObject;
  readonly publicBaseUrl: string;
  /** When it runs out, epoch seconds, shown as HH:MM in `zone`. */
  readonly expiresAt: number;
  /** An IANA time zone name. */
  readonly zone: string;
}

/** A work item's question to its person (render.item_question_card). */
export interface ItemQuestionModel {
  readonly event: JsonObject;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    digest: DigestModel;
    itemApproval: ProactiveApprovalModel;
    itemQuestion: ItemQuestionModel;
    proactiveApproval: ProactiveApprovalModel;
    runEvent: RunEventModel;
  }
}

/** The absolute https URL of a Claw-relative link; null for anything else (never an arbitrary URL). */
export function openUrl(link: unknown, publicBaseUrl: string): string | null {
  const path = asText(link);
  const base = publicBaseUrl.replace(/\/+$/, "");
  if (!path.startsWith("/") || path.startsWith("//") || !base.startsWith("https://")) return null;
  return base + path;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** `datetime.fromtimestamp(at, zone).strftime("%H:%M")`. */
export function clockText(at: number, zone: string): string {
  let clock = clocks.get(zone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clocks.set(zone, clock);
  }
  const parts = clock.formatToParts(new Date(at * 1000));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The language of a work item's request card: the model's summary, else the item's title (what the person asked for). */
export function itemLang(event: Readonly<Record<string, unknown>>): Lang {
  return pickLang(event["summary"], objectOf(event["item"])["title"]);
}

/** The line that names the work item a request comes from: "Task #13: title" ("task") or "... asks you" ("asks"). */
export function itemRequestLabel(event: Readonly<Record<string, unknown>>, key: "task" | "asks", lang: Lang): string {
  const item = objectOf(event["item"]);
  const seq = item["seq"];
  const title = clip(redactText(asText(item["title"])).text, ITEM_TITLE_MAX);
  const t = proactiveText.in(lang);
  return t[key]({ seq: typeof seq === "number" && Number.isInteger(seq) ? String(seq) : "?", title: title || "-" });
}

/** A target Claw sent, masked for credential shapes and clipped (what a work item's approval card shows). */
export function maskedTarget(target: unknown): string {
  return clip(redactText(asText(target)).text, TARGET_MAX);
}

/**
 * A run.failed event as it may be shown: what Claw says about a failed run may be the raw error, so a title with the shape of
 * internal detail is dropped and such a summary is withheld to the log under a reference the person is told. Other events are
 * returned as they are. `looksInternal` is the public-error check of a service error or internal detail.
 */
export function publicRunEvent(
  event: JsonObject,
  errors: PublicErrors,
  looksInternal: (text: unknown) => boolean,
): JsonObject {
  if (event["type"] !== "run.failed") return event;
  const out: Record<string, JsonObject[string]> = { ...event };
  if (looksInternal(event["title"])) delete out["title"];
  if (looksInternal(event["summary"])) {
    const session = event["session_id"];
    const ref = errors.withhold("run_failed_notice", event["summary"], {
      session: typeof session === "string" ? session : null,
    });
    out["summary"] = proactiveText.in("en").failedRef({ ref });
  }
  return out;
}
