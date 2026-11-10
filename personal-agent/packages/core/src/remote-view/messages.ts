// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The remote agents' cards as messages to post: the view's side of the domain's `RemoteViews` port. */
import { viewMessage } from "../remote/cards.js";
import type { RemoteViews } from "../remote/ports.js";
import { agentsView } from "./agents-view.js";
import { hiddenView } from "./hidden-view.js";
import { RemoteLiveView } from "./live-view.js";
import { disconnectView, machineChoiceView, modeView, takeoverView } from "./machine-views.js";
import { decidedView, optionButtons, permissionView } from "./permission-view.js";
import { sessionsView } from "./sessions-view.js";
import { statusView } from "./status-view.js";
import { windowView } from "./window-view.js";

/** The view the assembly gives the remote agents (`RemoteContext.views`). */
export function createRemoteViews(): RemoteViews {
  return {
    status: (input) => {
      const model = statusView(input);
      return viewMessage({ name: "remoteStatus", model }, model.title);
    },
    window: (input) => {
      const model = windowView(input);
      return { message: viewMessage({ name: "remoteWindow", model }, model.title), takesInput: model.box !== null };
    },
    agents: (input) => {
      const model = agentsView(input);
      return { message: viewMessage({ name: "remoteAgents", model }, model.title), listing: model.listing };
    },
    sessions: (input) => {
      const model = sessionsView(input);
      return { message: viewMessage({ name: "remoteSessions", model }, model.title), listing: model.listing };
    },
    machineChoice: (connector, agents, token, path, lang) => {
      const model = machineChoiceView(connector, agents, token, path, lang);
      return viewMessage({ name: "remoteMachineChoice", model }, model.title);
    },
    mode: (sessionId, current, modes, unattended, lang) => {
      const model = modeView(sessionId, current, modes, unattended, lang);
      return viewMessage({ name: "remoteMode", model }, model.title);
    },
    disconnect: (host, connectorId, setup, lang, paired) => {
      const model = disconnectView(host, connectorId, setup, lang, paired);
      return viewMessage({ name: "remoteDisconnect", model }, model.title);
    },
    permission: (card) => {
      const model = permissionView(
        card.request,
        card.options,
        card.sessionId,
        card.who,
        card.expiresAt,
        card.zone,
        card.lang,
      );
      return viewMessage({ name: "remotePermission", model }, model.asking);
    },
    decided: (option, when, zone, lang) => {
      const model = decidedView(option, when, zone, lang);
      return viewMessage({ name: "remoteDecided", model }, model.title);
    },
    takeover: (connector, agent, entry, lang, view, ticket) => {
      const model = takeoverView(connector, agent, entry, lang, view, ticket);
      return viewMessage({ name: "remoteTakeover", model }, model.title);
    },
    hidden: (connector, now, lang) => {
      const model = hiddenView(connector, now, lang);
      return viewMessage({ name: "remoteHidden", model }, model.title);
    },
    optionButtons: (options, sessionId, actionId, lang) => optionButtons(options, sessionId, actionId, lang),
    liveView: (label, lang) => new RemoteLiveView(label, lang),
  };
}
