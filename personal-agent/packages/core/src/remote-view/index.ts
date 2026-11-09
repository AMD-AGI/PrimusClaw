// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a person sees of a remote agent (a coding agent on their own machine, reached through Claw's remote-agents API): reading
 * its events, the live view of a turn, the lines a chat attached to it is told, and the views of its cards. Nothing here talks
 * to Claw or a channel.
 */
import type { AgentsView } from "./agents-view.js";
import type { DisconnectView, MachineChoiceView, ModeView, TakeoverView } from "./machine-views.js";
import type { DecidedView, PermissionView, RemoteAskView } from "./permission-view.js";
import type { SessionsView } from "./sessions-view.js";
import type { StatusView } from "./status-view.js";
import type { HiddenView } from "./hidden-view.js";
import type { WindowCardView } from "./window-view.js";

export * from "./actions.js";
export * from "./agents-view.js";
export * from "./agents.js";
export * from "./answer.js";
export * from "./conversations-view.js";
export * from "./conversations.js";
export * from "./events.js";
export * from "./health.js";
export * from "./hidden-view.js";
export { defang, lit, plain } from "./inert.js";
export * from "./limits.js";
export * from "./lines.js";
export * from "./listing.js";
export * from "./live-view.js";
export * from "./machine-views.js";
export * from "./options.js";
export * from "./permission-view.js";
export * from "./sessions-view.js";
export * from "./status-view.js";
export type { Reported } from "./reported.js";
export * from "./setup.js";
export * from "./turn-state.js";
export * from "./window-view.js";
export { remoteHealthText, remoteOffText, remoteQueuedText, remoteStopText, remoteText } from "../locales/remote.js";
export { remoteWindowCardText } from "../locales/remote-window-card.js";

declare module "../ports/surface.js" {
  interface ViewMap {
    remoteAgents: AgentsView;
    remoteSessions: SessionsView;
    remoteStatus: StatusView;
    remotePermission: PermissionView;
    remoteAsk: RemoteAskView;
    remoteDecided: DecidedView;
    remoteDisconnect: DisconnectView;
    remoteTakeover: TakeoverView;
    remoteMachineChoice: MachineChoiceView;
    remoteMode: ModeView;
    remoteWindow: WindowCardView;
    remoteHidden: HiddenView;
  }
}
