// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The remote-agent views (`remote-view`) as messages to post. */
import type { Lang } from "../locales/lang.js";
import type { OutMessage, View } from "../ports/surface.js";
import {
  type AgentsInput,
  type Conversation,
  type SessionsInput,
  agentsView,
  sessionsView,
  type PermissionOption,
  type StatusInput,
  decidedView,
  disconnectView,
  machineChoiceView,
  modeView,
  permissionView,
  statusView,
  takeoverView,
} from "../remote-view/index.js";
import type { ConnectorSetupWords } from "../remote-view/setup.js";
import type { Agent, Connector } from "./model.js";

/** A view as a message; `fallback` is what a client that cannot show it shows. */
export function viewMessage(view: View, fallback: string): OutMessage {
  return { body: { type: "view", view, fallbackText: fallback } };
}

export function statusMessage(input: StatusInput): OutMessage {
  const model = statusView(input);
  return viewMessage({ name: "remoteStatus", model }, model.title);
}

export function machineChoiceMessage(
  connector: Connector,
  agents: readonly Agent[],
  token: string,
  path: string,
  lang: Lang,
): OutMessage {
  const model = machineChoiceView(connector, agents, token, path, lang);
  return viewMessage({ name: "remoteMachineChoice", model }, model.title);
}

export function modeMessage(
  sessionId: string,
  current: string | null,
  modes: readonly string[],
  unattended: ReadonlySet<string>,
  lang: Lang,
): OutMessage {
  const model = modeView(sessionId, current, modes, unattended, lang);
  return viewMessage({ name: "remoteMode", model }, model.title);
}

export function disconnectMessage(
  host: string,
  connectorId: string,
  setup: ConnectorSetupWords,
  lang: Lang,
  paired: boolean,
): OutMessage {
  const model = disconnectView(host, connectorId, setup, lang, paired);
  return viewMessage({ name: "remoteDisconnect", model }, model.title);
}

export interface PermissionCard {
  readonly request: Readonly<Record<string, unknown>>;
  readonly options: readonly PermissionOption[];
  readonly sessionId: string;
  readonly who: string;
  readonly expiresAt: number;
  readonly zone: string;
  readonly lang: Lang;
}

export function permissionMessage(card: PermissionCard): OutMessage {
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
}

export function decidedMessage(option: PermissionOption, when: number, zone: string, lang: Lang): OutMessage {
  const model = decidedView(option, when, zone, lang);
  return viewMessage({ name: "remoteDecided", model }, model.title);
}

export function takeoverMessage(
  connector: Connector,
  agent: Agent,
  entry: Conversation,
  lang: Lang,
  view: string,
  ticket: string,
): OutMessage {
  const model = takeoverView(connector, agent, entry, lang, view, ticket);
  return viewMessage({ name: "remoteTakeover", model }, model.title);
}

/** A card that lists sessions, and the session ids it numbers. */
export interface ListedMessage {
  readonly message: OutMessage;
  readonly listing: readonly string[];
}

export function agentsMessage(input: AgentsInput): ListedMessage {
  const model = agentsView(input);
  return { message: viewMessage({ name: "remoteAgents", model }, model.title), listing: model.listing };
}

export function sessionsMessage(input: SessionsInput): ListedMessage {
  const model = sessionsView(input);
  return { message: viewMessage({ name: "remoteSessions", model }, model.title), listing: model.listing };
}
