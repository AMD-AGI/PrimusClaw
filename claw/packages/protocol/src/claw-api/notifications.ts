// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Outbound notifications as the Claw HTTP API defines them: the subscriptions a user keeps
 * (`/v1/notification-subscriptions`) and the run and approval events posted to them. The assistant's own events are in
 * `assistant-events.ts`.
 *
 * Types and constants only. The API builds these in `packages/api/src/notifications/outbox.ts`,
 * `packages/api/src/assistant/holds.ts` and `packages/api/src/routes/notification-subscriptions.ts`.
 */
import { ASSISTANT_EVENT_TYPES, type AssistantEventPayload, type AssistantItemSnapshot } from "./assistant-events.js";

export const NOTIFICATION_RUN_EVENT_TYPES = ["run.completed", "run.failed", "approval.requested"] as const;
export type NotificationEventType = (typeof NOTIFICATION_RUN_EVENT_TYPES)[number];

/**
 * Every type a subscription may list. A new subscription gets `run.completed` and `run.failed` unless it names its own;
 * `approval.requested` and the assistant's events have to be asked for.
 */
export const NOTIFICATION_SUBSCRIPTION_EVENT_TYPES = [...NOTIFICATION_RUN_EVENT_TYPES, ...ASSISTANT_EVENT_TYPES] as const;

/**
 * What started a run, which narrows run events (`trigger`, `long_run`), and `assistant_item`: an `approval.requested`
 * that an assistant's work item holds. A new subscription gets `trigger` and `long_run` unless it names its own.
 */
export const NOTIFICATION_SOURCES = ["trigger", "long_run", "assistant_item"] as const;
export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

/** One subscription, as listed, created (with its signing `secret`, once) and changed. */
export interface NotificationSubscription<Time = string> {
  subscription_id: string;
  url: string;
  event_types: string[];
  sources: string[];
  enabled: boolean;
  consecutive_failures: number;
  created_at: Time;
}

/** The part of an `approval.requested` payload that says what is being asked. */
export interface ApprovalInfo {
  tool_use_id: string;
  tool: string;
  /** Redacted and clipped to 300 characters. */
  target: string;
  /** ISO-8601 with an offset: when Brain stops waiting, after which the request is refused. */
  expires_at: string;
}

/** A run event (`run.completed`, `run.failed`) or an `approval.requested`. */
export interface NotificationPayload {
  event_id: string;
  type: NotificationEventType;
  occurred_at: string;
  user_id: string;
  session_id: string;
  task_id: string;
  /**
   * Run events only: the message whose turn this run was (`null` for a task that has none). A client that sent the
   * message can tell this run's end is that turn's by the id, not by when it ended.
   */
  message_id?: string | null;
  trigger_id: string | null;
  title: string;
  summary: string;
  link: string;
  /** Present on `approval.requested` only. */
  approval?: ApprovalInfo;
  /**
   * `assistant_item`: an `approval.requested` held by the worker of an assistant's work item, sent only to a subscription
   * that lists that source. Absent on every other event.
   */
  source?: "assistant_item";
  /** With `source`: the work item that waits, as an assistant event draws it. */
  item?: AssistantItemSnapshot;
  /**
   * With `source`, when what waits is a question (`approval.tool` is `ask_user_question`): what it asks. Answered as a
   * client answers any question (`messageType: "answer"`), not with a decision.
   */
  questions?: HeldQuestion[];
}

/** One question of an `ask_user_question`, as a channel shows it: masked and clipped. */
export interface HeldQuestion {
  id: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  allow_multiple: boolean;
}

/** Everything a subscription can be posted. */
export type OutboundPayload = NotificationPayload | AssistantEventPayload;
