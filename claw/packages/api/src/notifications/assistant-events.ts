// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's outbound events. Their payloads are part of the HTTP API's wire contract and are defined in
 * `@claw/protocol` (`claw-api/assistant-events.ts`), which clients of the API share; they are re-exported here so
 * the API's own modules keep one import path.
 */
import { ASSISTANT_EVENT_TYPES, type AssistantEventType } from "@claw/protocol";

export {
  ASSISTANT_EVENT_TYPES,
  REVIEW_HANDOFF_ACTION,
  type AssistantActionPayload,
  type AssistantConfirmAction,
  type AssistantConfirmWrite,
  type AssistantEventPayload,
  type AssistantEventType,
  type AssistantFile,
  type AssistantHeldWrite,
  type AssistantItemSnapshot,
  type AssistantRemoteAsk,
  type AssistantRemoteNotice,
  type AssistantReviewHandoff,
  type AssistantSayPayload,
  type AssistantSaySource,
  type WorkItemNeedsYouPayload,
} from "@claw/protocol";

export const isAssistantEventType = (type: string): type is AssistantEventType =>
  (ASSISTANT_EVENT_TYPES as readonly string[]).includes(type);
