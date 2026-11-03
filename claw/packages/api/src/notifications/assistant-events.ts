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

export const ASSISTANT_EVENT_TYPES = ["assistant.say", "work_item.needs_you"] as const;
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

/** Something the assistant chose to say to the user. */
export interface AssistantSayPayload extends AssistantEventBase {
  type: "assistant.say";
}

/** The system's own message, sent when an item has needed the user for a while and nobody has said so. */
export interface WorkItemNeedsYouPayload extends AssistantEventBase {
  type: "work_item.needs_you";
  fallback: true;
  item: AssistantItemSnapshot;
}

export type AssistantEventPayload = AssistantSayPayload | WorkItemNeedsYouPayload;

export const isAssistantEventType = (type: string): type is AssistantEventType =>
  (ASSISTANT_EVENT_TYPES as readonly string[]).includes(type);
