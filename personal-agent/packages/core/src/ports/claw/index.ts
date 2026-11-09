// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ClawAssistantPort } from "./assistant.js";
import type { ClawRemoteAgentsPort } from "./remote-agents.js";
import type { ClawSessionsPort } from "./sessions.js";
import type {
  ClawMergeConfirmationsPort,
  ClawNotificationsPort,
  ClawSettingsPort,
  ClawTriggersPort,
} from "./settings.js";
import type { ClawWorkItemsPort } from "./work-items.js";

export type * from "./assistant.js";
export type * from "./remote-agents.js";
export type * from "./sessions.js";
export type * from "./settings.js";
export type * from "./work-items.js";

/**
 * Claw's public HTTP API, always called as one person with that person's own credential (a per-call argument, never
 * kept). Grouped by resource. Errors: ClawError (Claw answered with an error), ReviewsRefused, ReplayRefused,
 * ClawAnswerInvalid (an answer this client does not understand), CredentialMisuse (refused before sending),
 * ClawUnreachable. An id that could change which endpoint a request reaches is refused as ClawError(404).
 */
export interface ClawPort {
  /** The address Claw's API is reached at. */
  readonly baseUrl: string;
  readonly sessions: ClawSessionsPort;
  readonly workItems: ClawWorkItemsPort;
  readonly assistant: ClawAssistantPort;
  readonly settings: ClawSettingsPort;
  readonly notifications: ClawNotificationsPort;
  readonly triggers: ClawTriggersPort;
  readonly mergeConfirmations: ClawMergeConfirmationsPort;
  readonly remoteAgents: ClawRemoteAgentsPort;
}
