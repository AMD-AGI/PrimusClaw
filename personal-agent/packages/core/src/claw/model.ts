// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What this agent reads out of Claw's answers, after they were checked (`ClawPort` implementations and the parsers in
 * this directory build these). The wire shapes themselves are `@claw/protocol`'s (`../protocol.ts`); these are the
 * readings: tolerant of a missing field the way the worker always was, and in this codebase's naming.
 */
import type { JsonObject } from "../json.js";
import type { PrRef } from "../protocol.js";

/** One pull request: `{owner, repo, number}` as Claw writes it. */
export type PullRef = Readonly<PrRef>;

/**
 * One work item as Claw's board shows it (`GET /v1/work-items`) and as an assistant event carries it. `canAccept` is
 * Claw's own word for "a result waits for this person" (false as well when Claw says it needs no acceptance).
 */
export interface WorkItem {
  readonly itemId: string;
  readonly seq: number;
  readonly title: string;
  /** in_progress | needs_you | done (another word from a newer Claw is kept as it came). */
  readonly boardState: string;
  readonly resultVersion: number;
  readonly canAccept: boolean;
  readonly lastReportKind: string | null;
  readonly pendingQuestion: string | null;
  readonly summary: string;
  /** accepted | answered | dropped | stopped, once the item is done. */
  readonly outcome: string | null;
  /** task | review | remote. */
  readonly kind: string;
  /** What a review was asked with (`{}` for a task). */
  readonly params: Readonly<JsonObject>;
  /** The pull request of a review item, or null. */
  readonly pull: PullRef | null;
  /** When Claw last changed it (ISO 8601; "" not said). */
  readonly updatedAt: string;
}

/**
 * What Claw answered to a person's accept, stop or retry: `ok`, or a 409 that says why not (`error`) and carries the item
 * as it is now, so that a card for an old version can be replaced by one for the current one.
 */
export interface Decision {
  readonly ok: boolean;
  readonly item: WorkItem;
  /** version_mismatch | not_acceptable | item_closed | ... ("" when ok). */
  readonly error: string;
}

/**
 * What the asker of a review someone else runs may know of it: its state, the pull request's link, the conclusion and
 * whether it was merged, what a waiting one waits for, what it found, and what the pull request does.
 */
export interface AskerView {
  readonly itemId: string;
  readonly status: string;
  readonly prUrl: string;
  /** approve | request_changes | comment ("" none yet). */
  readonly verdict: string;
  readonly merged: boolean;
  /** confirm_merge | confirm_review | failed | reviewer ("" Claw did not say). */
  readonly waitingFor: string;
  /** Open findings posted on the pull request (null: Claw did not say). */
  readonly findings: number | null;
  /** The first open finding in one line ("" none). */
  readonly note: string;
  /** What the pull request does, clipped for showing ("" Claw did not say). */
  readonly prSummary: string;
}

/** A review the caller asked of someone else: its item, whom they asked, and their view of it. */
export interface ReviewAskedOfOther {
  readonly itemId: string;
  readonly reviewer: string;
  readonly view: AskerView;
}

/**
 * One pull request Claw started a review item for (`POST /v1/assistant/reviews`): the item, and the session Claw made
 * for it with its first message queued.
 */
export interface ReviewStart {
  readonly target: PullRef;
  readonly itemId: string;
  readonly seq: number;
  readonly title: string;
  /** "" for a review asked of someone else (that person's session, never followed). */
  readonly sessionId: string;
  /** The first turn's id when Claw says it ("" otherwise). */
  readonly messageId: string;
  /** The model Claw says it runs on ("" its default); null: Claw did not say. */
  readonly model: string | null;
  /** The model it was to run on, which the payer's key cannot use ("" none). */
  readonly fellBackFrom: string;
  /** What Claw set aside of the request ("model", "effort"). */
  readonly ignored: readonly string[];
  /** true: every merge waits for the reviewer's confirmation; false: their review mode decides; null: Claw did not say. */
  readonly mergeNeedsConfirmation: boolean | null;
  /** The item limit that was full when Claw queued it ("" it started). */
  readonly queued: string;
  /** Claw merges it with the asker's own account once approved and green. */
  readonly mergeByRequester: boolean;
}

/** Which GitHub token Claw's GitHub tools use for the token's own user now (never the token). */
export interface GithubConnection {
  /** "env" | "binding" | "" (none: `missing` says why). */
  readonly readsWith: string;
  readonly login: string;
  /** "none" | "expired" | "". */
  readonly missing: string;
  readonly bindingReads: boolean;
}

/** One frame of a Claw SSE stream. `name` is the `event:` line, or the data's `type` for a plain `message` frame. */
export interface SseEvent {
  readonly id: string;
  readonly name: string;
  readonly data: Readonly<JsonObject>;
}

/** A person's long-term memory in Claw: whether it is on, whether Claw has it at all, and what it remembers. */
export interface MemoryState {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly items: readonly string[];
}
