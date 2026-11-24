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
  parseRemoteId,
  parsePromptFiles,
  REMOTE_COMMANDS,
} from "../../claw/packages/protocol/src/remote-agents.js";
export type {
  RemoteAgentDescriptor,
  RemoteCommandType,
  RemoteEventIn,
  RemotePromptFile,
} from "../../claw/packages/protocol/src/remote-agents.js";
