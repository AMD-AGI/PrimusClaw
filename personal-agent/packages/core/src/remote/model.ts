// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What remote agents are, as this agent reads Claw's remote-agents answers (`GET /v1/remote-agents/connectors`, `.../sessions`):
 * the user's machines (connectors), the agents each reports, and the sessions. Claw relays what a connector reported and does not
 * interpret it, so every reading is tolerant: a field that is missing or of another type reads as "not said" (the way the Python
 * worker read the answer's dicts), never as a failure. Untrusted text stays as it came; what shows it makes it inert.
 */
import { z } from "zod";

/** A field read as text: a string as it is, a number in decimal, anything else as nothing. */
const text = z
  .unknown()
  .optional()
  .transform((v): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : ""));
/** A field read as a flag: only `true` is true. */
const flag = z
  .unknown()
  .optional()
  .transform((v): boolean => v === true);
/** A field read as an optional flag: `true` / `false` as said, anything else null. */
const maybeFlag = z
  .unknown()
  .optional()
  .transform((v): boolean | null => (typeof v === "boolean" ? v : null));
const record = z
  .unknown()
  .optional()
  .transform((v): Readonly<Record<string, unknown>> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {},
  );

const agentSchema = z.object({
  agent_id: text,
  kind: text,
  name: text,
  capabilities: record,
});

/** An agent a machine reports. `capabilities` is whatever its connector reported (read by `view/capabilities.ts`). */
export interface RemoteAgent {
  readonly agentId: string;
  readonly kind: string;
  readonly name: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

const agents = z
  .unknown()
  .optional()
  .transform((v): RemoteAgent[] =>
    (Array.isArray(v) ? v : []).flatMap((raw) => {
      const parsed = agentSchema.safeParse(raw);
      if (!parsed.success || typeof raw !== "object" || raw === null) return [];
      const a = parsed.data;
      return [{ agentId: a.agent_id, kind: a.kind, name: a.name, capabilities: a.capabilities }];
    }),
  );

const connectorSchema = z.object({
  connector_id: text,
  name: text,
  online: flag,
  version: text,
  version_status: text,
  last_seen_at: text,
  heartbeat_at: text,
  paired: flag,
  agents,
});

/** One of the user's machines: its connector, whether it is online now, and the agents it reports. */
export interface RemoteConnector {
  readonly connectorId: string;
  readonly name: string;
  readonly online: boolean;
  /** The connector's version as it reported it ("" not said). */
  readonly version: string;
  /** Claw's word on that version: current | outdated | unsupported | unknown ("" not said). */
  readonly versionStatus: string;
  /** When Claw last heard from it, ISO 8601 ("" not said); `heartbeatAt` is the older field of the same. */
  readonly lastSeenAt: string;
  readonly heartbeatAt: string;
  /** Joined with a pairing code (`claw-connector pair`) rather than a sign-in. */
  readonly paired: boolean;
  readonly agents: readonly RemoteAgent[];
}

const sessionSchema = z.object({
  session_id: text,
  connector_id: text,
  agent_id: text,
  cwd: text,
  status: text,
  mode: text,
  read_only: maybeFlag,
  connector_online: maybeFlag,
  created_at: text,
  updated_at: text,
});

/** One of the user's remote sessions as Claw lists it. */
export interface RemoteSession {
  readonly sessionId: string;
  readonly connectorId: string;
  readonly agentId: string;
  readonly cwd: string;
  /** active | closed (another word from a newer Claw is kept as it came). */
  readonly status: string;
  readonly mode: string;
  /** The session only watches a conversation open in a terminal (null: not said). */
  readonly readOnly: boolean | null;
  /** Whether its machine is online (only `GET .../sessions/{id}` says it; null otherwise). */
  readonly connectorOnline: boolean | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Claw's list of the user's connectors; an entry that is not an object is no connector. */
export function readConnectors(answer: readonly unknown[]): RemoteConnector[] {
  return answer.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    const c = connectorSchema.parse(raw);
    return [
      {
        connectorId: c.connector_id,
        name: c.name,
        online: c.online,
        version: c.version,
        versionStatus: c.version_status,
        lastSeenAt: c.last_seen_at,
        heartbeatAt: c.heartbeat_at,
        paired: c.paired,
        agents: c.agents,
      },
    ];
  });
}

export function readSession(raw: unknown): RemoteSession | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const s = sessionSchema.parse(raw);
  return {
    sessionId: s.session_id,
    connectorId: s.connector_id,
    agentId: s.agent_id,
    cwd: s.cwd,
    status: s.status,
    mode: s.mode,
    readOnly: s.read_only,
    connectorOnline: s.connector_online,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/** Claw's list of the user's sessions; an entry that is not an object is no session. */
export function readSessions(answer: readonly unknown[]): RemoteSession[] {
  return answer.flatMap((raw) => {
    const session = readSession(raw);
    return session ? [session] : [];
  });
}

/** The connector `connectorId` names among `connectors`, or undefined. */
export function connectorById(
  connectors: readonly RemoteConnector[],
  connectorId: string,
): RemoteConnector | undefined {
  return connectors.find((c) => c.connectorId === connectorId);
}

/** The agent `agentId` names on `connector`, or undefined. */
export function agentById(connector: RemoteConnector | undefined, agentId: string): RemoteAgent | undefined {
  return connector?.agents.find((a) => a.agentId === agentId);
}
