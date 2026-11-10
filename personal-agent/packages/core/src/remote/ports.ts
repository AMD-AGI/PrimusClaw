// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the remote agents need of their view (core/src/remote-view, which implements it as `createRemoteViews`): the cards they
 * post, as messages, and the live view of a turn. The domain says what is shown (the inputs here); the view says how. The
 * assembly gives the domain the view's implementation (`RemoteContext.views`), so the domain never imports the view.
 */
import type { Lang } from "../locales/lang.js";
import type { OutMessage } from "../ports/surface.js";
import type { ButtonFields, DecisionButton } from "./actions.js";
import type { Conversation } from "./conversations.js";
import type { RemoteStep } from "./events.js";
import type { StatusPhase } from "./lines.js";
import type { Agent, Connector, Session } from "./model.js";
import type { PermissionOption } from "./options.js";
import type { ConnectorSetupWords } from "./setup.js";
import type { WindowView } from "./window/view.js";

export interface StatusInput {
  /** `icon name` of the agent. */
  readonly label: string;
  readonly host: string;
  readonly cwd: string;
  readonly mode: string | null;
  readonly sessionId: string;
  readonly phase: StatusPhase;
  /** When the phase was last true, seconds since the epoch (shown as UTC, so a phone that did not redraw shows its age). */
  readonly at: number;
  readonly lang?: Lang;
  /** The agent said its modes: Mode is offered. */
  readonly hasModes?: boolean;
  readonly unattended?: boolean;
  readonly lead?: string;
  /** The title of the conversation the chat joined, "" for none. */
  readonly conversation?: string;
  /** What Take over… carries, for a watched conversation the connector can take over; null for none. */
  readonly takeover?: ButtonFields | null;
  /** What is sent is typed into a terminal on the machine, so Stop says it interrupts the turn running there. */
  readonly terminal?: boolean;
  /** The assistant's display name. */
  readonly bot: string;
}

export interface AgentsInput {
  readonly connectors: readonly Connector[];
  readonly sessions: readonly Session[];
  /** The session the chat is attached to. */
  readonly attached: string | null;
  readonly now: number;
  /** One line on top: what the tap that brought the card back did, or why it did not. */
  readonly lead?: string;
  readonly machines?: boolean;
  readonly lang?: Lang;
  /** Session id -> (title, the ref of the terminal conversation it joined, "" for none) of the sessions this chat started. */
  readonly names?: ReadonlyMap<string, { readonly title: string; readonly ref: string }>;
  /** Session id -> the machine's conversation id of this chat's own sessions. */
  readonly own?: ReadonlyMap<string, string>;
  readonly setup: ConnectorSetupWords;
}

export interface SessionsInput {
  readonly connectors: readonly Connector[];
  readonly sessions: readonly Session[];
  readonly attached: string | null;
  readonly now: number;
  readonly lang?: Lang;
  readonly lead?: string;
  readonly setup: ConnectorSetupWords;
  /** Session ids with an approval card open. */
  readonly waiting?: ReadonlySet<string>;
}

/** One approval the session waits on: the tool, when it runs out, and the agent's own options as buttons. */
export interface WindowApproval {
  readonly actionId: string;
  readonly tool: string;
  readonly expiresAt: number;
  readonly buttons: readonly DecisionButton[];
}

export interface WindowInput {
  /** `icon name` of the agent. */
  readonly label: string;
  readonly host: string;
  readonly cwd: string;
  readonly mode: string | null;
  readonly sessionId: string;
  readonly phase: StatusPhase;
  readonly at: number;
  readonly lang: Lang;
  readonly view: WindowView;
  readonly approvals: readonly WindowApproval[];
  /** The person's time zone (an IANA name). */
  readonly zone?: string;
  readonly unattended?: boolean;
  readonly lead?: string;
  readonly conversation?: string;
  readonly hasModes?: boolean;
  readonly takeover?: ButtonFields | null;
  /** A group chat bound to the session: its approvals go to the binder's 1:1 chat, never here. */
  readonly group?: boolean;
  readonly terminal?: boolean;
  /** The assistant's display name. */
  readonly bot: string;
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

/** A card that lists sessions, and the session ids it numbers. */
export interface ListedMessage {
  readonly message: OutMessage;
  readonly listing: readonly string[];
}

/** The live view of a remote turn in a chat (`RemoteLiveView`): what the turn's status message shows as it goes. */
export interface RemoteLive {
  readonly header: string;
  /** True when the step changed what is shown. */
  apply(step: RemoteStep): boolean;
  render(): string;
  statusLines(): string[];
}

/** The remote agents' cards, as messages to post. */
export interface RemoteViews {
  status(input: StatusInput): OutMessage;
  window(input: WindowInput): { readonly message: OutMessage; readonly takesInput: boolean };
  agents(input: AgentsInput): ListedMessage;
  sessions(input: SessionsInput): ListedMessage;
  machineChoice(connector: Connector, agents: readonly Agent[], token: string, path: string, lang: Lang): OutMessage;
  mode(
    sessionId: string,
    current: string | null,
    modes: readonly string[],
    unattended: ReadonlySet<string>,
    lang: Lang,
  ): OutMessage;
  disconnect(host: string, connectorId: string, setup: ConnectorSetupWords, lang: Lang, paired: boolean): OutMessage;
  permission(card: PermissionCard): OutMessage;
  decided(option: PermissionOption, when: number, zone: string, lang: Lang): OutMessage;
  takeover(
    connector: Connector,
    agent: Agent,
    entry: Conversation,
    lang: Lang,
    view: string,
    ticket: string,
  ): OutMessage;
  hidden(connector: Connector, now: number, lang: Lang): OutMessage;
  /** A permission request's buttons (the ones its card shows). */
  optionButtons(
    options: readonly PermissionOption[],
    sessionId: string,
    actionId: string,
    lang: Lang,
  ): DecisionButton[];
  liveView(label: string, lang: Lang): RemoteLive;
}
