// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The remote-agent views core can show (a card on Teams). */
import type { AgentsView } from "./agents-view.js";
import type { DisconnectView, MachineChoiceView, ModeView, TakeoverView } from "./machine-views.js";
import type { DecidedView, PermissionView, RemoteAskView } from "./permission-view.js";
import type { SessionsView } from "./sessions-view.js";
import type { StatusView } from "./status-view.js";

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
  }
}
