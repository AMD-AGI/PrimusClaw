// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The machines and sessions of test_remote_view's cards, and the cards built from them. */
import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { SETUP, agent, connector, session } from "../../../../test-support/card-catalog/remote.js";
import { cardOf } from "../../../../test-support/adaptive-card.js";
import { agentsCard, sessionsCard, statusCard } from "../../src/views/remote/index.js";

export { SETUP, agent, connector, session };

export const CONNECTORS = [
  connector({
    connectorId: "c1",
    name: "dev-pod",
    online: true,
    agents: [
      agent({
        agentId: "codex",
        kind: "codex",
        name: "Codex",
        capabilities: { roots: ["/a", "/b"], modes: ["read-only"] },
      }),
      agent({
        agentId: "claude",
        kind: "claude",
        name: "",
        capabilities: {
          roots: ["/a"],
          modes: ["default", "bypass"],
          ask_mode: "default",
          unattended: false,
          unattended_allowed: true,
        },
      }),
    ],
  }),
  connector({
    connectorId: "c2",
    name: "laptop",
    agents: [agent({ agentId: "cursor", kind: "cursor", name: "Cursor" })],
  }),
  connector({ connectorId: "c3", name: "empty", online: true }),
];

export const SESSIONS = [
  session({
    sessionId: "s1",
    connectorId: "c1",
    agentId: "codex",
    cwd: "/a",
    status: "active",
    updatedAt: "2026-10-29T05:00:00Z",
  }),
  session({
    sessionId: "s2",
    connectorId: "c1",
    agentId: "claude",
    cwd: "/b",
    status: "active",
    updatedAt: "2026-10-29T06:00:00Z",
  }),
  session({
    sessionId: "s3",
    connectorId: "c9",
    agentId: "x",
    cwd: "/gone",
    status: "active",
    updatedAt: "2026-10-29T04:00:00Z",
  }),
  session({
    sessionId: "s4",
    connectorId: "c1",
    agentId: "codex",
    cwd: "/closed",
    status: "closed",
    updatedAt: "2026-10-29T07:00:00Z",
  }),
];

type Json = Record<string, unknown>;

/** The agents card and the session ids it lists. */
export function agents(input: Omit<remoteDomain.AgentsInput, "setup">): { card: Json; listing: readonly string[] } {
  const view = remoteView.agentsView({ ...input, setup: SETUP });
  return { card: cardOf(agentsCard(view)), listing: view.listing };
}

/** The sessions card and the session ids it lists. */
export function sessions(input: Omit<remoteDomain.SessionsInput, "setup">): { card: Json; listing: readonly string[] } {
  const view = remoteView.sessionsView({ ...input, setup: SETUP });
  return { card: cardOf(sessionsCard(view)), listing: view.listing };
}

/** The status card. */
export function status(input: Omit<remoteDomain.StatusInput, "bot">): Json {
  return cardOf(statusCard(remoteView.statusView({ ...input, bot: "Clawy" })));
}
