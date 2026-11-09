// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's machines (connectors), the agents each reports and their remote sessions, as the remote-agent domain reads them:
 * Claw's answers as the Claw client parsed them (`claw/remote.ts`, where a field that is absent or of another type is
 * `undefined`), with the defaults the Python worker read them with (`dict.get(...)` and its fallbacks). Text stays as it came:
 * whatever shows it makes it inert. An agent's `capabilities` stay opaque (the connector's own keys, read one by one where they
 * are used), and times stay the strings Claw sent (they are compared and aged as written).
 */
import type { RemoteAgent, RemoteConnector, RemoteSession } from "../claw/remote.js";

/** An agent a machine reports. */
export interface Agent {
  readonly agentId: string;
  readonly kind: string;
  readonly name: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/** One of the user's machines: its connector, whether it is online now, and the agents it reports. */
export interface Connector {
  readonly connectorId: string;
  readonly name: string;
  readonly online: boolean;
  /** The connector's version as it reported it ("" not said). */
  readonly version: string;
  /** Claw's word on that version: current | outdated | unsupported | unknown ("" not said). */
  readonly versionStatus: string;
  /** When Claw last heard from it, ISO 8601 as Claw wrote it ("" not said); `heartbeatAt` is the older field of the same. */
  readonly lastSeenAt: string;
  readonly heartbeatAt: string;
  /** Joined with a pairing code (`claw-connector pair`) rather than a sign-in. */
  readonly paired: boolean;
  readonly agents: readonly Agent[];
}

/** One of the user's remote sessions. */
export interface Session {
  readonly sessionId: string;
  readonly connectorId: string;
  readonly agentId: string;
  readonly cwd: string;
  /** active | closed (another word from a newer Claw is kept as it came). */
  readonly status: string;
  /** The session only watches a conversation open in a terminal (null: not said). */
  readonly readOnly: boolean | null;
  /** When it last changed, as Claw wrote it ("" not said): the newest is the one an agent's name attaches to. */
  readonly updatedAt: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function agentFrom(raw: RemoteAgent): Agent {
  return {
    agentId: raw.agent_id ?? "",
    kind: raw.kind ?? "",
    name: raw.name ?? "",
    capabilities: raw.capabilities ?? {},
  };
}

export function connectorFrom(raw: RemoteConnector): Connector {
  return {
    connectorId: raw.connector_id ?? "",
    name: raw.name ?? "",
    online: raw.online === true,
    version: raw.version ?? "",
    versionStatus: text(raw["version_status"]),
    lastSeenAt: text(raw["last_seen_at"]),
    heartbeatAt: text(raw["heartbeat_at"]),
    paired: raw["paired"] === true,
    agents: (raw.agents ?? []).map(agentFrom),
  };
}

export function sessionFrom(raw: RemoteSession): Session {
  return {
    sessionId: raw.session_id ?? "",
    connectorId: raw.connector_id ?? "",
    agentId: raw.agent_id ?? "",
    cwd: raw.cwd ?? "",
    status: raw.status ?? "",
    readOnly: raw.read_only ?? null,
    updatedAt: text(raw["updated_at"]),
  };
}

/** The connector `connectorId` names, or undefined. */
export function connectorById(connectors: readonly Connector[], connectorId: string): Connector | undefined {
  return connectors.find((c) => c.connectorId === connectorId);
}

/** The agent `agentId` names on `connector`, or undefined. */
export function agentById(connector: Connector | undefined, agentId: string): Agent | undefined {
  return connector?.agents.find((a) => a.agentId === agentId);
}
