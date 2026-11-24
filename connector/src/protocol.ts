// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one place the connector reaches the wire contract. The definitions live in
 * `claw/packages/protocol` and are compiled into the bundle, never copied: the
 * server, the connector and the chat bot therefore share the limits, the field
 * rules and the frame shapes by construction. `test/protocol-source.test.ts`
 * fails if any other file in `src/` imports that path or restates a constant.
 */
export {
  CONNECTOR_PACKAGE,
  compareConnectorVersions,
  REMOTE_AGENT_LIMITS,
  REMOTE_AGENT_PROTOCOL_VERSION,
  REMOTE_AGENT_TIMING,
  REMOTE_COMMAND_TYPES,
  REMOTE_EVENT_PERMISSION_REQUEST,
  REMOTE_EVENT_PERMISSION_RESOLVED,
  REMOTE_EVENT_SESSION_CLOSED,
  REMOTE_EVENT_TERMINAL_TURN_END,
  REMOTE_OUTBOX_REPORT_MAX_SESSIONS,
  isRemoteCommandType,
  normalizeGitBranch,
  normalizeGitRemote,
  parseRemoteId,
  parsePromptFiles,
  REMOTE_COMMANDS,
  REMOTE_WORKSPACE_LIMITS,
} from "../../claw/packages/protocol/src/remote-agents.js";
export type {
  RemoteAgentDescriptor,
  RemoteCommandType,
  RemoteEventIn,
  RemoteWorkspace,
  RemotePromptFile,
} from "../../claw/packages/protocol/src/remote-agents.js";

/**
 * A prompt sent with `park_permissions: true` (only by a Claw that read the agent capability `permission_park`) parks the
 * permission requests of its turn when their timeout passes instead of cancelling them: the connector says so with this
 * event (`{actionId, cmd_seq, parked_until}`) and keeps the request answerable until {@link PERMISSION_PARK_MAX_MS} after
 * it was asked, then cancels it with `permission_resolved` `by: "park_expired"`.
 *
 * Defined here until the shared protocol module carries the same names; `test/protocol-source.test.ts` fails the moment
 * the two disagree, and this file then re-exports them like the rest.
 */
export const REMOTE_EVENT_PERMISSION_PARKED = "permission_parked";
/** The longest a parked permission request keeps waiting, from when it was asked. */
export const PERMISSION_PARK_MAX_MS = 24 * 3600_000;
