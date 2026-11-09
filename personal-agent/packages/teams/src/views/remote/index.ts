// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How Teams shows the remote-agent views. */
import type { Renderers } from "../registry.js";
import { agentsCard } from "./agents-card.js";
import { decidedCard, permissionCard, remoteAskCard } from "./permission-cards.js";
import { sessionsCard } from "./sessions-card.js";
import { disconnectCard, machineChoiceCard, modeCard, takeoverCard } from "./small-cards.js";
import { hiddenCard } from "./hidden-card.js";
import { statusCard } from "./status-card.js";
import { windowCard } from "./window-card.js";

export { agentsCard, conversationBlocks } from "./agents-card.js";
export { decidedCard, permissionCard, remoteAskCard } from "./permission-cards.js";
export { connectBlocks, sessionsCard } from "./sessions-card.js";
export { disconnectButtons, disconnectCard, machineChoiceCard, modeCard, takeoverCard } from "./small-cards.js";
export { hiddenCard } from "./hidden-card.js";
export { statusCard } from "./status-card.js";
export { windowCard } from "./window-card.js";

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
  | "remoteWindow"
  | "remoteHidden"
>;

/** The remote-agent renderers. */
export const REMOTE_RENDERERS: RemoteRenderers = {
  remoteAgents: agentsCard,
  remoteSessions: sessionsCard,
  remoteStatus: statusCard,
  remotePermission: permissionCard,
  remoteAsk: remoteAskCard,
  remoteDecided: decidedCard,
  remoteDisconnect: disconnectCard,
  remoteTakeover: takeoverCard,
  remoteMachineChoice: machineChoiceCard,
  remoteMode: modeCard,
  remoteWindow: windowCard,
  remoteHidden: hiddenCard,
};
