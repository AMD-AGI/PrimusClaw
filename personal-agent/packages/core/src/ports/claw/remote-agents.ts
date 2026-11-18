// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../../json.js";
import type { RemoteHidden } from "../../protocol.js";
import type { ClawCredential } from "../../claw/credential.js";
import type { SseEvent } from "../../claw/model.js";
import type { RemoteConnector, RemoteEventRow, RemotePairing, RemoteSession, RemoteSetup } from "../../claw/remote.js";

/** What a remote session starts with. */
export interface NewRemoteSession {
  readonly connectorId: string;
  readonly agentId: string;
  readonly cwd: string;
  /** The permission mode to start in (absent: the agent's own). */
  readonly mode?: string;
  /** An existing conversation the agent offered to take over, passed on unread. */
  readonly resumeRef?: string;
  /** The person confirmed the terminal holding that conversation is ended first (only with `resumeRef`). */
  readonly takeover?: boolean;
}

/**
 * Agents on the user's own machines, the user side (`/v1/remote-agents/*`). Every call names this client in Claw's
 * audit trail (`X-Claw-Client`).
 */
export interface ClawRemoteAgentsPort {
  /** How to connect a machine: the connector's package and the exact commands. */
  setup(key: ClawCredential): Promise<RemoteSetup>;
  /**
   * The caller's connectors, each with `online` and its `agents`. The conversations the caller hid are left out of each
   * agent's `capabilities.resumable` and counted in `capabilities.hidden_count`; `includeHidden` lists them too, marked
   * `hidden: true` (`?hidden=include`).
   */
  connectors(key: ClawCredential, options?: { includeHidden?: boolean }): Promise<RemoteConnector[]>;
  /**
   * Hides conversations (1-50 refs) of one of the caller's machines from their lists, or (`hidden` false) shows them
   * again; nothing on the machine changes. ClawError(404): not the caller's machine, or revoked; 400 for refs Claw does
   * not take.
   */
  hide(key: ClawCredential, connectorId: string, refs: readonly string[], hidden: boolean): Promise<RemoteHidden>;
  /** A one-time pairing code inside the command line that uses it. */
  pair(key: ClawCredential): Promise<RemotePairing>;
  revoke(key: ClawCredential, connectorId: string): Promise<void>;
  /** Whether the questions the caller's terminals ask come to them (`GET /approvals`; on unless they turned it off). */
  approvals(key: ClawCredential): Promise<boolean>;
  /** Turn them on or off (`PUT /approvals`); answers the setting as Claw stored it. */
  setApprovals(key: ClawCredential, enabled: boolean): Promise<boolean>;
  createSession(key: ClawCredential, session: NewRemoteSession): Promise<RemoteSession>;
  sessions(key: ClawCredential): Promise<RemoteSession[]>;
  session(key: ClawCredential, sessionId: string): Promise<RemoteSession>;
  /** One command (`prompt`, `cancel`, `set_mode`, `resume`, `close`); a retry with the same key queues one command. */
  command(
    key: ClawCredential,
    sessionId: string,
    body: Readonly<JsonObject>,
    idempotencyKey?: string,
  ): Promise<JsonObject>;
  /** Answers a permission request with an option id the agent itself offered. */
  decide(key: ClawCredential, sessionId: string, actionId: string, optionId: string): Promise<JsonObject>;
  /** A page of stored events `{id, seq, type, ts, data}`, oldest first, after `after`. */
  events(key: ClawCredential, sessionId: string, after?: string, limit?: number): Promise<RemoteEventRow[]>;
  /** Stored events after `after`, a `historyComplete` marker, then live events. */
  stream(key: ClawCredential, sessionId: string, after?: string, signal?: AbortSignal): AsyncIterable<SseEvent>;
}
