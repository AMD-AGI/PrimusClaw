// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router's read of the user's own remote connectors (`remote-agents/`): which programs on their machines are registered with
 * Claw, which of them are online now, and which agents each one offers. "Is my laptop connector online?", "which agents can you
 * reach on my machine?" are answered in the conversation from this, instead of becoming a work item.
 *
 * Offered only where the deployment has remote agents on (`CLAW_REMOTE_AGENTS_ENABLED`), and only to a router turn (`mcp.ts`; an
 * observer's call is recorded, never run). It reads the owner's rows as `GET /v1/remote-agents/connectors` does for that owner,
 * and nothing of anyone else's. It only reads, so a router turn may still call it after another lookup has answered
 * (`AFTER_READ_TOOLS`).
 */
import { REMOTE_AGENT_TIMING } from "@claw/protocol";
import { CLAW_REMOTE_AGENTS_ENABLED } from "../config.js";
import { inTransaction } from "../infra/db.js";
import { listConnectors } from "../remote-agents/store.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun } from "./tools.js";

/** Whether the router is offered `connector_list`. */
export const remoteConnectorsOn = (): boolean => CLAW_REMOTE_AGENTS_ENABLED;

/** The longest name of a connector or an agent passed on; the connector chose it. */
const NAME_MAX = 80;
const short = (v: unknown): string | null => (typeof v === "string" && v ? v.replace(/\s+/g, " ").slice(0, NAME_MAX) : null);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

export interface ConnectorListed {
  name: string | null;
  online: boolean;
  version: string | null;
  last_seen: string | null;
  agents: Array<{ kind: string | null; name: string | null }>;
}

/** The user's connectors that are not revoked, oldest first, with how many there are and how many are online. */
export async function connectorList(
  claims: AssistantTokenClaims, onlineWindowMs: number = REMOTE_AGENT_TIMING.onlineWindowMs,
): Promise<{ ok: true; total: number; online: number; connectors: ConnectorListed[] }> {
  const { userId } = await inTransaction((q) => assertLiveRun(q, claims));
  const rows = await listConnectors(userId, onlineWindowMs);
  const connectors = rows.map((c): ConnectorListed => ({
    name: short(c.name),
    online: c.online === true,
    version: short(c.version),
    last_seen: iso(c.heartbeat_at),
    agents: (Array.isArray(c.agents) ? c.agents : []).map((a: Record<string, unknown>) => ({ kind: short(a.kind), name: short(a.name) })),
  }));
  return { ok: true, total: connectors.length, online: connectors.filter((c) => c.online).length, connectors };
}
