// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How Teams shows the remote-agent views. */
import type { Renderers } from "../registry.js";
import { agentsCard } from "./agents-card.js";
import { type ApprovalBody, decidedCard, permissionCard, remoteAskCard } from "./permission-cards.js";
import { sessionsCard } from "./sessions-card.js";
import { disconnectCard, machineChoiceCard, modeCard, takeoverCard } from "./small-cards.js";
import { statusCard } from "./status-card.js";

export { agentsCard, conversationBlocks } from "./agents-card.js";
export { type ApprovalBody, decidedCard, permissionCard, remoteAskCard } from "./permission-cards.js";
export { connectBlocks, sessionsCard } from "./sessions-card.js";
export { disconnectButtons, disconnectCard, machineChoiceCard, modeCard, takeoverCard } from "./small-cards.js";
export { statusCard } from "./status-card.js";

type RemoteRenderers = Pick<
  Renderers,
  | "remoteAgents"
  | "remoteSessions"
  | "remoteStatus"
  | "remotePermission"
  | "remoteAsk"
  | "remoteDecided"
  | "remoteDisconnect"
  | "remoteTakeover"
  | "remoteMachineChoice"
  | "remoteMode"
>;

/** The remote-agent renderers; the permission card is built on the approval card's body, which the caller supplies. */
export function remoteRenderers(approvalBody: ApprovalBody): RemoteRenderers {
  return {
    remoteAgents: agentsCard,
    remoteSessions: sessionsCard,
    remoteStatus: statusCard,
    remotePermission: (view) => permissionCard(view, approvalBody),
    remoteAsk: remoteAskCard,
    remoteDecided: decidedCard,
    remoteDisconnect: disconnectCard,
    remoteTakeover: takeoverCard,
    remoteMachineChoice: machineChoiceCard,
    remoteMode: modeCard,
  };
}
