// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two outbound events an assistant produces, and the payloads they carry.
 *
 * They are not run events: there is no session, task or link to report, only
 * something the assistant said, so they do not reuse `NotificationPayload`. They
 * say nothing about who receives them -- a subscription asks for the type and
 * the receiver decides how a person sees it.
 */

export const ASSISTANT_EVENT_TYPES = ["assistant.say", "work_item.needs_you", "assistant.action"] as const;
export type AssistantEventType = (typeof ASSISTANT_EVENT_TYPES)[number];

/** What a receiver needs to draw the item a message is about; derived from the item's state, never written by a model. */
export interface AssistantItemSnapshot {
  item_id: string;
  seq: number;
  title: string;
  board_state: string;
  result_version: number;
  can_accept: boolean;
}

interface AssistantEventBase {
  /** The id of the stored message: the receiver's dedup key. */
  event_id: string;
  occurred_at: string;
  user_id: string;
  text: string;
  item?: AssistantItemSnapshot;
}

/**
 * A channel action put to the person rather than run (`channel_action` when their message was not its command typed whole).
 * A channel that can draw a button shows one for `/{name} {args}` and runs it, as if the person typed it, only when that person
 * presses it, under the same checks as an `assistant.action` (a message it sent for them, an action that message declared).
 * A channel that cannot shows the text, which tells the person the command to type.
 */
export interface AssistantConfirmAction {
  name: string;
  args: string;
  /** The id of the turn's message in Claw. */
  message_id: string;
  /** What the channel called that message when it sent it. */
  channel_message_id: string;
}

/**
 * A source the message cites (`assistant/citations.ts`): `n` is the number its text writes as `[n]`. Each comes from a lookup the turn
 * made (a web page it found or read, an object of the user's GitHub), never from the model's own words. `title` is a plain line,
 * already cut and stripped of markup, but what someone else wrote: shown as text only.
 */
export interface AssistantSaySource {
  n: number;
  url: string;
  title: string;
  kind: "web" | "github_pr" | "github_issue" | "github_repo" | "github_check" | "github_file" | "board";
}

/**
 * A write the router proposed and Claw holds until the person answers it (`assistant/schedules.ts`): creating or cancelling a
 * scheduled task. A channel that can draw buttons shows the message's text with two: one that lets it through and one that does
 * not, each calling `POST /v1/assistant/confirmations/{confirmation_id}/decision` as that person (`allow` or `deny`). A channel that
 * cannot shows the text, which tells the person the command that lets it through (`批准 #{ref}`).
 */
export interface AssistantConfirmWrite {
  confirmation_id: string;
  /** The short id the person may type back. */
  ref: string;
  /** `devenv_send`: an instruction for an agent on the person's own machine (`assistant/devenv-tools.ts`). */
  kind: "trigger_create" | "trigger_cancel" | "github_comment" | "devenv_send";
  /** What the button that lets it through says, in the language of the text. */
  allow_label: string;
  expires_at: string;
}

/**
 * A file a work item's worker delivered (`deliver_file`, `deliver_text`), or one the router wrote (`deliver_text`), for a channel to
 * offer as a download. The download is Claw's own link, `GET /v1/sessions/{session_id}/deliveries/{id}`, which answers only the
 * signed-in owner of that session (the item's worker session, or the assistant's own, both the user's). `data_base64` is a small image itself (`DELIVERY_INLINE_TYPES`, at most
 * `DELIVERY_INLINE_MAX_BYTES`), for a channel that shows it without fetching the link.
 */
export interface AssistantFile {
  /** The work item whose worker delivered it; absent for a file the router wrote itself (`text-delivery.ts`). */
  item_id?: string;
  session_id: string;
  id: string;
  name: string;
  size: number;
  content_type: string;
  data_base64?: string;
}

/**
 * What a development environment session's own message is about (`assistant/remote-items.ts`): one of the three things a session is
 * ever said for, so a channel can draw it and tell it apart. `done`: the instruction finished; `needs_you`: the agent waits on the person
 * (`ask`: the permission request, for a channel to put to them with its options as buttons, answered as an attached chat's card is, a
 * decision on the session); `error`: the instruction failed, was refused, or its session ended before it finished. `machine` and
 * `agent` are what the connector reported, and `ask`'s words what the agent wrote: untrusted text, shown as text only.
 */
export interface AssistantRemoteNotice {
  kind: "done" | "needs_you" | "error";
  session_id: string;
  machine: string;
  agent: string;
  ask?: AssistantRemoteAsk;
}

/** A permission request a development environment's agent waits on (`permissionRequest`), as its connector posted it. */
export interface AssistantRemoteAsk {
  action_id: string;
  tool: string;
  /** The options the agent offered, ids as the agent gave them: the only answers a decision may carry. */
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** When the connector stops waiting for an answer (it refuses the request then); absent when it did not say. */
  expires_at?: string;
}

/** Something the assistant chose to say to the user. */
export interface AssistantSayPayload extends AssistantEventBase {
  type: "assistant.say";
  confirm_action?: AssistantConfirmAction;
  /** Present only when the message cites any (`CLAW_ASSISTANT_CITATIONS`); a receiver that does not read it shows the text alone. */
  sources?: AssistantSaySource[];
  /**
   * Present only when the router suggested any (`CLAW_ASSISTANT_SUGGESTED_REPLIES`): up to three short replies the user may send
   * next, each one plain line. A channel shows them as buttons that send the words as the user's message; one that cannot ignores them.
   */
  suggested_replies?: string[];
  confirm_write?: AssistantConfirmWrite;
  /** Files the user gets with the message (a worker's deliveries, `deliveries.ts`): one download each. */
  files?: AssistantFile[];
  /** Present on a development environment session's own message: which session, and which of its three kinds of news. */
  remote?: AssistantRemoteNotice;
  /**
   * The `event_id` of an earlier message of this turn that this one adds to: the system's start notice of an item, after which the
   * router's words belong in that same message. A channel that still has that message shows it with these words added (its text, a
   * blank line, this text); one that does not shows this as a message of its own.
   */
  amends?: string;
  /**
   * The `event_id` of the router's first message of this turn, which this one takes the place of: a turn speaks to the user once, and a
   * later say of it (the answer after a quick "查一下", or a correction) is that whole message again. A channel that still has that message
   * shows this text in its place; one that does not shows this as a message of its own.
   */
  replaces?: string;
  /** The message id of the turn a system notice answers or a router say belongs to (what an `amends` or a `replaces` is matched by). */
  turn_message_id?: string;
}

/** The system's own message, sent when an item has needed the user for a while and nobody has said so. */
export interface WorkItemNeedsYouPayload extends AssistantEventBase {
  type: "work_item.needs_you";
  fallback: true;
  item: AssistantItemSnapshot;
  /** Present when what the item waits for is a write its worker holds for the person (`AssistantHeldWrite`). */
  held_write?: AssistantHeldWrite;
}

/**
 * A write an item's worker holds for the person (`assistant/holds.ts`), on the message that says so: what a card needs to put it to them
 * beside the text. The person answers it as any held call is answered: a `decision` (`allow` or `deny`, with `tool_use_id`) on the
 * worker's session, `POST /v1/sessions/{session_id}/messages`; the channel that got the item's `approval.requested` draws the same card
 * from that. Every field is what Claw recorded of the hold, never a model's words; `action` is in the person's language.
 */
export interface AssistantHeldWrite {
  item_id: string;
  /** The worker's session, where the decision is sent. */
  session_id: string;
  tool_use_id: string;
  /** What it would do, in plain words (`approvalAction`). */
  action: string;
  expires_at?: string;
}

/**
 * A review the person asked of someone else, handed to the channel that carried their message (`review_start` with a reviewer, when
 * that message declared `channel_context.handoffs: ["review_for_other"]`). It runs on the reviewer's own credentials, which only that
 * channel holds, so the channel starts it itself (`POST /v1/assistant/reviews` with the reviewer's token and key) and answers the
 * person's message about it, in one message (the router says nothing about it). Every field is the router's call as Claw checked it: the
 * reviewer is someone the channel listed with this message, each pull request is one the person's message names. `requester_note` is the
 * person's own message, to quote to the reviewer as untrusted. `handoff_id` names the record Claw kept of it: the channel echoes it as
 * `handoff_id` in that request, which then starts once and merges only if `merge` is true (Claw reads the record, not the request); how it
 * merges is the reviewer's own review setting's, as for a review asked of them in the chat, and the route's answer says so per item.
 */
export interface AssistantReviewHandoff {
  handoff_id: string;
  reviewer: { user_id: string; name: string };
  prs: Array<{ owner: string; repo: string; number: number }>;
  merge: boolean;
  requester_note: string;
  /**
   * What the router said in the same turn before handing the review over (another question of the person's answered), in order. Held
   * and never delivered on its own (`say-hold.ts`), so the channel's one answer carries it: the channel adds it to that answer. Absent
   * when nothing was said.
   */
  held_says?: string[];
}

/** The name an `assistant.action` carries when it is a handoff rather than one of the channel's own commands. */
export const REVIEW_HANDOFF_ACTION = "review_for_other";

/**
 * A setting the channel offered beside the user's message, to be run by that channel as if the user typed it
 * (`channel_action`); or, with `review` (and the action named `review_for_other`), a review asked of someone else, handed to the
 * channel to start with that person's credentials. The channel runs it only for a message it sent itself (`channel_message_id`), once
 * per `event_id`.
 */
export interface AssistantActionPayload {
  type: "assistant.action";
  event_id: string;
  occurred_at: string;
  user_id: string;
  /** The id of the turn's message in Claw. */
  message_id: string;
  /** What the channel called that message when it sent it. */
  channel_message_id: string;
  action: { name: string; args: string };
  review?: AssistantReviewHandoff;
}

export type AssistantEventPayload = AssistantSayPayload | WorkItemNeedsYouPayload | AssistantActionPayload;

export const isAssistantEventType = (type: string): type is AssistantEventType =>
  (ASSISTANT_EVENT_TYPES as readonly string[]).includes(type);
