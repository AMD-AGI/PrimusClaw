// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Claw HTTP API's wire types (`src/claw-api/`) against what the API actually builds.
 *
 * Two halves. The type assertions below are compiled by `tsconfig.wire-test.json` (CI: "Wire types compile against
 * the API" in tests.yml): each one names an API function's real return type, so a field renamed, dropped or retyped
 * on either side stops the compile. The tests run the API's own serializers on representative rows and check that
 * what goes on the wire has exactly the fields the protocol type names, with the JSON types it says: a field the
 * serializer adds by spreading a row is invisible to the compiler and is caught here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_STATES, HISTORY_COMPLETE_EVENT, ITEM_KINDS, NOTIFICATION_SOURCES, NOTIFICATION_SUBSCRIPTION_EVENT_TYPES,
  REPORT_KINDS, ASSISTANT_EVENT_TYPES,
  type AskedOfOther, type AssistantActionPayload, type AssistantEventPayload, type AssistantSayPayload,
  type HistoryCompleteData, type NotificationPayload, type NotificationSubscription, type OutboundPayload,
  type RequesterView, type RetryRefusal, type StartedReview, type StartedReviewForRequester, type WorkItemDecisionError,
  type WorkItemDetail, type WorkItemEvent, type WorkItemNeedsYouPayload, type WorkItemView,
  type RemoteHidden, type RemoteHiddenCapabilities, type RemoteResumableListed,
} from "../src/index.js";
// Runtime imports of the API's serializers: pure functions over a row, no database or network.
import { itemView } from "../../api/src/assistant/work-items.js";
import { asRequesterAnswer } from "../../api/src/assistant/review-items.js";
import { frozenRequesterView, routerView } from "../../api/src/assistant/requester-view.js";
import { historyCompleteFrame } from "../../api/src/routes/events.js";
import { withHidden } from "../../api/src/remote-agents/hidden.js";
import type { DecisionResult, recentEvents } from "../../api/src/assistant/work-items.js";
import type { RetryResult } from "../../api/src/assistant/retry.js";
import type { askedOfOthers, requesterViewOf } from "../../api/src/assistant/requester-view.js";
import type { CreatedReview, startReviews } from "../../api/src/assistant/review-items.js";
import type { HideOutcome, setHidden } from "../../api/src/remote-agents/store.js";
import type { NotificationPayload as ApiNotificationPayload, OutboundPayload as ApiOutboundPayload } from "../../api/src/notifications/outbox.js";

// ------------------------------------------------------------------------------------------- compile-time

/** True only when A and B are the same type (not merely assignable either way). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
/** What `JSON.stringify` makes of a value the API builds: a `Date` is an ISO string. */
type Jsonified<T> = T extends Date ? string
  : T extends Array<infer U> ? Array<Jsonified<U>>
  : T extends object ? { [K in keyof T]: Jsonified<T[K]> }
  : T;
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type Conflict<R> = Extract<R, { status: "conflict" }>;

/** Every key of a type, listed once: the list a runtime check compares against. */
const keysOf = <T>() => <const K extends ReadonlyArray<keyof T>>(keys: K & ([keyof T] extends [K[number]] ? unknown : never)) => keys;

const WORK_ITEM_KEYS = keysOf<WorkItemView>()([
  "item_id", "seq", "title", "summary", "board_state", "last_report_kind", "pending_question", "outcome", "result_version",
  "accepted_version", "can_accept", "kind", "params", "updated_at",
]);
const REQUESTER_VIEW_KEYS = keysOf<RequesterView>()([
  "status", "pr_url", "verdict", "merged", "waiting_for", "findings", "note", "pr_summary",
]);
const REMOTE_HIDDEN_KEYS = keysOf<RemoteHidden>()(["changed", "refused"]);
const HIDDEN_CAPABILITY_KEYS = keysOf<RemoteHiddenCapabilities>()(["resumable", "hidden_count"]);
const STARTED_REVIEW_KEYS = keysOf<StartedReview>()([
  "item_id", "seq", "title", "session_id", "pr", "message_id", "ignored", "review_only", "merge_needs_confirmation",
  "merge_by_requester", "model", "fell_back_from", "queued",
]);

export type WireAssertions = [
  // The board, and accept/stop/retry: what `itemView` returns is the protocol's item, and once serialized its wire form.
  Expect<Equal<ReturnType<typeof itemView>, WorkItemView<Date>>>,
  Expect<Equal<Jsonified<ReturnType<typeof itemView>>, WorkItemView>>,
  Expect<Equal<Conflict<DecisionResult>["error"], WorkItemDecisionError>>,
  Expect<Equal<Conflict<DecisionResult>["item"], WorkItemView<Date>>>,
  Expect<Equal<Conflict<RetryResult>["error"], RetryRefusal>>,
  // One item: its events as the API reads them.
  Expect<Equal<Awaited<ReturnType<typeof recentEvents>>, Array<WorkItemEvent<Date>>>>,
  Expect<Equal<Jsonified<WorkItemDetail<Date>>, WorkItemDetail>>,
  // Reviews: what `POST /v1/assistant/reviews` answers its owner and the person who asked.
  Expect<Equal<Awaited<ReturnType<typeof startReviews>>[number], StartedReview>>,
  Expect<Equal<CreatedReview, StartedReview>>,
  Expect<Equal<ReturnType<typeof asRequesterAnswer>, StartedReviewForRequester>>,
  Expect<Equal<RequiredKeys<StartedReviewForRequester>, "item_id" | "seq" | "title" | "pr" | "review_only">>,
  // The requester's view, read and listed.
  Expect<Equal<Awaited<ReturnType<typeof requesterViewOf>>, RequesterView>>,
  Expect<Equal<ReturnType<typeof frozenRequesterView>, RequesterView | null>>,
  Expect<Equal<Awaited<ReturnType<typeof askedOfOthers>>[number], AskedOfOther>>,
  // Notifications: the outbox's payloads are the protocol's.
  Expect<Equal<ApiNotificationPayload, NotificationPayload>>,
  Expect<Equal<ApiOutboundPayload, OutboundPayload>>,
  Expect<Equal<OutboundPayload, NotificationPayload | AssistantEventPayload>>,
  Expect<Equal<AssistantEventPayload["type"], (typeof ASSISTANT_EVENT_TYPES)[number]>>,
  Expect<Equal<Jsonified<NotificationSubscription<Date>>, NotificationSubscription>>,
  // Every field the protocol says is always there.
  Expect<Equal<RequiredKeys<WorkItemView>, (typeof WORK_ITEM_KEYS)[number]>>,
  Expect<Equal<RequiredKeys<RequesterView>, (typeof REQUESTER_VIEW_KEYS)[number]>>,
  // Remote agents: what a hide or show of a machine's conversations answers (`POST .../connectors/:cid/hidden`).
  Expect<Equal<Awaited<ReturnType<typeof setHidden>>, RemoteHidden | null>>,
  Expect<Equal<HideOutcome, RemoteHidden>>,
  Expect<Equal<RequiredKeys<RemoteHidden>, (typeof REMOTE_HIDDEN_KEYS)[number]>>,
  Expect<Equal<RequiredKeys<RemoteHiddenCapabilities>, (typeof HIDDEN_CAPABILITY_KEYS)[number]>>,
  // The mark on a hidden conversation is a named field, not the open rest of the entry: renamed, this reads `unknown`.
  Expect<Equal<RemoteResumableListed["hidden"], true | undefined>>,
];

// ------------------------------------------------------------------------------------------- runtime

/** `value` as a client receives it. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const isStringOrNull = (v: unknown) => v === null || typeof v === "string";
const isIntOrNull = (v: unknown) => v === null || Number.isInteger(v);

/** A `claw_work_items` row as the API selects it (`ITEM_COLUMNS`), with the columns the route reads beside it. */
const ITEM_ROW = {
  item_id: "wi_0123456789abcdef", seq: "7", title: "Fix the flaky test", summary: "ready for review",
  board_state: "needs_you", last_report_kind: "ready", pending_question: null, outcome: null, result_version: 2,
  accepted_version: null, worker_session_id: "s-worker", created_at: new Date("2026-11-09T10:00:00Z"),
  updated_at: new Date("2026-11-09T11:00:00Z"), closed_at: null, kind: "task", params: {}, repo: null,
  // A column the serializer must not pass through.
  user_id: "u-owner", generation: 3,
};

test("a work item on the wire has exactly the protocol's fields, with their JSON types", () => {
  const item = wire(itemView(ITEM_ROW)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(item).sort(), [...WORK_ITEM_KEYS].sort());
  assert.equal(typeof item.item_id, "string");
  assert.equal(item.seq, 7, "seq is a number on the wire, whatever the driver gave");
  assert.ok((BOARD_STATES as readonly unknown[]).includes(item.board_state));
  assert.ok(item.last_report_kind === null || (REPORT_KINDS as readonly unknown[]).includes(item.last_report_kind));
  assert.ok((ITEM_KINDS as readonly unknown[]).includes(item.kind));
  assert.equal(item.can_accept, true);
  assert.ok(isStringOrNull(item.pending_question) && isStringOrNull(item.outcome));
  assert.ok(Number.isInteger(item.result_version) && isIntOrNull(item.accepted_version));
  assert.deepEqual(item.params, {});
  assert.equal(item.updated_at, "2026-11-09T11:00:00.000Z");
});

test("an unknown kind and missing params read as a task with {}: the closed sets hold on the wire", () => {
  const item = wire(itemView({ ...ITEM_ROW, kind: "something-new", params: null, board_state: "done", outcome: "accepted" })) as WorkItemView;
  assert.equal(item.kind, "task");
  assert.deepEqual(item.params, {});
  assert.equal(item.can_accept, false);
});

test("the requester's view on the wire has exactly the protocol's fields, before and after the fields it gained", () => {
  const full: RequesterView = {
    status: "done", pr_url: "https://github.com/o/r/pull/1", verdict: "approve", merged: true, waiting_for: null,
    findings: 0, note: null, pr_summary: "Adds a retry.",
  };
  // A view frozen before `waiting_for`, `findings`, `note` and `pr_summary` existed reads them as null.
  const old = frozenRequesterView({ requester_view: { status: "stopped", pr_url: null, verdict: null, merged: false } });
  for (const view of [frozenRequesterView({ requester_view: full }), old, routerView(full)]) {
    assert.ok(view);
    assert.deepEqual(Object.keys(wire(view) as object).sort(), [...REQUESTER_VIEW_KEYS].sort());
  }
  assert.deepEqual(wire(old), { status: "stopped", pr_url: null, verdict: null, merged: false, waiting_for: null, findings: null, note: null, pr_summary: null });
  const listed: AskedOfOther = { item_id: "wi_1", reviewer: null, view: full };
  assert.deepEqual(Object.keys(wire(listed) as object).sort(), ["item_id", "reviewer", "view"]);
});

test("a review started for someone else leaves out the reviewer's session, and keeps everything else", () => {
  const started: StartedReview = {
    item_id: "wi_2", seq: 3, title: "Review o/r#9", session_id: "s-reviewer", pr: { owner: "o", repo: "r", number: 9 },
    message_id: "claw-pending-4", review_only: false, merge_by_requester: true, queued: { reason: "too_many_requested_reviews" },
  };
  const answer = wire(asRequesterAnswer(started)) as Record<string, unknown>;
  assert.equal("session_id" in answer, false);
  assert.equal("message_id" in answer, false);
  assert.deepEqual(answer, { item_id: "wi_2", seq: 3, title: "Review o/r#9", pr: { owner: "o", repo: "r", number: 9 }, review_only: false, merge_by_requester: true, queued: { reason: "too_many_requested_reviews" } });
  for (const key of Object.keys(answer)) assert.ok((STARTED_REVIEW_KEYS as readonly string[]).includes(key), key);
});

test("the history marker on the SSE stream is the protocol's", () => {
  const frame = historyCompleteFrame(12, true);
  const lines = frame.trimEnd().split("\n");
  assert.equal(lines[0], `event: ${HISTORY_COMPLETE_EVENT}`);
  assert.equal(lines.some((l) => l.startsWith("id:")), false, "the marker never moves Last-Event-ID");
  const data = JSON.parse(lines[1]!.slice("data: ".length)) as HistoryCompleteData;
  assert.deepEqual(data, { type: "historyComplete", count: 12, has_more: true });
});

test("a subscription may list every run and assistant event type, and the sources a subscription names", () => {
  assert.deepEqual([...NOTIFICATION_SUBSCRIPTION_EVENT_TYPES], [
    "run.completed", "run.failed", "approval.requested", "assistant.say", "work_item.needs_you", "assistant.action",
  ]);
  assert.deepEqual([...NOTIFICATION_SOURCES], ["trigger", "long_run", "assistant_item"]);
});

test("representative payloads of each event type round-trip unchanged", () => {
  const say: AssistantSayPayload = {
    type: "assistant.say", event_id: "e1", occurred_at: "2026-11-09T11:00:00.000Z", user_id: "u", text: "Done [1].",
    item: { item_id: "wi_1", seq: 1, title: "t", board_state: "needs_you", result_version: 1, can_accept: true },
    sources: [{ n: 1, url: "https://example.com", title: "Example", kind: "web" }], suggested_replies: ["ok"],
    choices: { options: ["prod", "staging"], multiple: false },
    confirm_write: { confirmation_id: "c1", ref: "a1", kind: "trigger_create", allow_label: "Create", expires_at: "2026-11-10T11:00:00.000Z" },
    skill_card: {
      kind: "saved", name: "weekly-report", version: 2, created: false, description: "Weekly report", invocation: "auto",
      files: [{ path: "templates/r.md", size_bytes: 12 }], preview: "## Steps", change_id: "c2", undo_expires_at: "2026-11-10T11:00:00.000Z",
    },
    files: [{ session_id: "s", id: "d1", name: "a.png", size: 3, content_type: "image/png" }],
    remote: { kind: "needs_you", session_id: "rs", machine: "m", agent: "a", tool: "claude", ask: { action_id: "x", tool: "Bash", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } },
  };
  const needsYou: WorkItemNeedsYouPayload = {
    type: "work_item.needs_you", fallback: true, event_id: "e2", occurred_at: "2026-11-09T11:00:00.000Z", user_id: "u", text: "#1 waits",
    item: { item_id: "wi_1", seq: 1, title: "t", board_state: "needs_you", result_version: 0, can_accept: false },
    held_write: { item_id: "wi_1", session_id: "s", tool_use_id: "tu", action: "push to main" },
  };
  const action: AssistantActionPayload = {
    type: "assistant.action", event_id: "e3", occurred_at: "2026-11-09T11:00:00.000Z", user_id: "u", message_id: "m", channel_message_id: "cm",
    action: { name: "review_for_other", args: "" },
    review: { handoff_id: "h", reviewer: { user_id: "u2", name: "R" }, prs: [{ owner: "o", repo: "r", number: 1 }], merge: false, requester_note: "please" },
  };
  const approval: NotificationPayload = {
    event_id: "e4", type: "approval.requested", occurred_at: "2026-11-09T11:00:00.000Z", user_id: "u", session_id: "s", task_id: "t",
    trigger_id: null, title: "t", summary: "s", link: "https://claw.example/s", source: "assistant_item",
    approval: { tool_use_id: "tu", tool: "ask_user_question", target: "", expires_at: "2026-11-09T12:00:00.000+00:00" },
    questions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }], allow_multiple: false }],
  };
  const payloads: OutboundPayload[] = [say, needsYou, action, approval];
  for (const p of payloads) assert.deepEqual(wire(p), p);
  const subscription: NotificationSubscription<Date> = {
    subscription_id: "00000000-0000-4000-8000-000000000000", url: "https://hooks.example/claw", event_types: ["assistant.say"],
    sources: ["trigger"], enabled: true, consecutive_failures: 0, created_at: new Date("2026-11-09T10:00:00Z"),
  };
  assert.equal((wire(subscription) as NotificationSubscription).created_at, "2026-11-09T10:00:00.000Z");
});

test("a listing with hidden conversations has the protocol's capability fields, the hidden ones marked when included", () => {
  const agent = {
    agent_id: "a1", kind: "claude", name: "Claude",
    capabilities: { unattended: true, resumable: [
      { ref: "r-live", title: "open", state: "live" }, { ref: "r-old", title: "old", state: "idle" }, { ref: "r-kept", title: "kept" },
    ] },
  };
  const hidden = new Set(["r-live", "r-old"]);
  const left = wire(withHidden(agent, hidden, false)) as { capabilities: Record<string, unknown> };
  for (const key of HIDDEN_CAPABILITY_KEYS) assert.ok(key in left.capabilities, key);
  assert.deepEqual(left.capabilities, {
    unattended: true, resumable: [{ ref: "r-live", title: "open", state: "live" }, { ref: "r-kept", title: "kept" }], hidden_count: 1,
  });
  const all = wire(withHidden(agent, hidden, true)) as { capabilities: RemoteHiddenCapabilities };
  assert.deepEqual(all.capabilities.resumable.map((r) => [r.ref, r.hidden ?? false]), [["r-live", false], ["r-old", true], ["r-kept", false]]);
  assert.equal(all.capabilities.hidden_count, 1);
  // Nothing hidden: the row as it was, with no count.
  assert.equal(withHidden(agent, undefined, true), agent);
});

test("a hide's answer has exactly the protocol's fields", () => {
  const answer: RemoteHidden = { changed: ["r-old"], refused: [{ ref: "r-live", reason: "live" }] };
  assert.deepEqual(Object.keys(wire(answer) as object).sort(), [...REMOTE_HIDDEN_KEYS].sort());
});
