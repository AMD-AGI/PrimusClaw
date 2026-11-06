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
  kind: "web" | "github_pr" | "github_issue" | "github_repo" | "github_check" | "github_file";
}

/** Something the assistant chose to say to the user. */
export interface AssistantSayPayload extends AssistantEventBase {
  type: "assistant.say";
  confirm_action?: AssistantConfirmAction;
  /** Present only when the message cites any (`CLAW_ASSISTANT_CITATIONS`); a receiver that does not read it shows the text alone. */
  sources?: AssistantSaySource[];
}

/** The system's own message, sent when an item has needed the user for a while and nobody has said so. */
export interface WorkItemNeedsYouPayload extends AssistantEventBase {
  type: "work_item.needs_you";
  fallback: true;
  item: AssistantItemSnapshot;
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
