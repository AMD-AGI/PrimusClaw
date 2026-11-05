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

/** Something the assistant chose to say to the user. */
export interface AssistantSayPayload extends AssistantEventBase {
  type: "assistant.say";
  confirm_action?: AssistantConfirmAction;
}

/** The system's own message, sent when an item has needed the user for a while and nobody has said so. */
export interface WorkItemNeedsYouPayload extends AssistantEventBase {
  type: "work_item.needs_you";
  fallback: true;
  item: AssistantItemSnapshot;
}

/**
 * A setting the channel offered beside the user's message, to be run by that channel as if the user typed it
 * (`channel_action`). The channel runs it only for a message it sent itself (`channel_message_id`), once per `event_id`.
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
}

export type AssistantEventPayload = AssistantSayPayload | WorkItemNeedsYouPayload | AssistantActionPayload;

export const isAssistantEventType = (type: string): type is AssistantEventType =>
  (ASSISTANT_EVENT_TYPES as readonly string[]).includes(type);
