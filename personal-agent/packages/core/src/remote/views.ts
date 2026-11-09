// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cards of remote agents, as the remote-agent domain asks for them. The views themselves (what a card says, its buttons)
 * are `remote-view`'s; this port is the boundary the domain posts through, so the domain decides only which card, when, and with
 * what facts. The assembly implements it with the view constructors; tests may record what was asked for.
 */
import type { Lang } from "../locales/lang.js";
import type { OutMessage } from "../ports/surface.js";
import type { Conversation } from "../remote-view/conversations.js";
import type { Reported } from "../remote-view/reported.js";
import type { ConnectorSetupWords } from "../remote-view/setup.js";
import type { WindowView } from "./window/view.js";

/** The phases a status card says: attached ones, and the two of a chat that left its session. */
export type Phase = "idle" | "working" | "starting" | "watching" | "offline" | "detached" | "ended";

/** A conversation the watching card offers to take over: which agent, and its ref. */
export interface TakeoverOffer {
  readonly connectorId: string;
  readonly agentId: string;
  readonly resume: string;
}

/** What the chat's status card (or the session card, when it is the window) shows. */
export interface StatusInput {
  readonly label: string;
  readonly host: string;
  readonly cwd: string;
  readonly mode: string;
  readonly sessionId: string;
  readonly phase: Phase;
  /** Wall-clock seconds: when it was last true. */
  readonly at: number;
  readonly lang: Lang;
  readonly hasModes: boolean;
  readonly unattended: boolean;
  readonly lead: string;
  readonly conversation: string;
  readonly takeover: TakeoverOffer | null;
  /** What is sent is typed into a terminal on the machine. */
  readonly terminal: boolean;
}

/** An approval the session card offers as buttons. */
export interface WindowApproval {
  readonly actionId: string;
  readonly tool: string;
  readonly expiresAt: number;
  readonly options: readonly unknown[];
}

export interface WindowInput extends StatusInput {
  readonly view: WindowView;
  readonly approvals: readonly WindowApproval[];
  /** The person's time zone (IANA). */
  readonly timezone: string;
  /** A group chat bound to a session (its approvals go to the binder's 1:1 chat). */
  readonly group: boolean;
}

export interface Listed {
  readonly message: OutMessage;
  /** The session ids it lists in order: the numbers of `/agent attach N`. */
  readonly listing: readonly string[];
}

export interface AgentsInput {
  readonly connectors: readonly Reported[];
  readonly sessions: readonly Reported[];
  readonly attached: string | null;
  readonly now: number;
  readonly lead: string;
  readonly machines: boolean;
  readonly lang: Lang;
  readonly names: ReadonlyMap<string, { readonly title: string; readonly ref: string }>;
  readonly own: ReadonlyMap<string, string>;
}

export interface SessionsInput {
  readonly connectors: readonly Reported[];
  readonly sessions: readonly Reported[];
  readonly attached: string | null;
  readonly now: number;
  readonly lang: Lang;
  readonly lead: string;
  /** Sessions with an approval card still open. */
  readonly waiting: ReadonlySet<string>;
  /** The connect steps, for a person with no machine. */
  readonly setup: ConnectorSetupWords;
}

export interface PermissionInput {
  readonly request: Readonly<Record<string, unknown>>;
  readonly options: readonly unknown[];
  readonly sessionId: string;
  readonly who: string;
  readonly expiresAt: number;
  readonly timezone: string;
  readonly lang: Lang;
}

export interface RemoteViews {
  status(input: StatusInput): OutMessage;
  /** The session card; `takesInput`: it has the text box. */
  window(input: WindowInput): { readonly message: OutMessage; readonly takesInput: boolean };
  agents(input: AgentsInput): Listed;
  sessions(input: SessionsInput): Listed;
  machineChoice(connector: Reported, agents: readonly Reported[], token: string, path: string, lang: Lang): OutMessage;
  modes(
    sessionId: string,
    current: string,
    modes: readonly string[],
    unattended: ReadonlySet<string>,
    lang: Lang,
  ): OutMessage;
  disconnect(host: string, connectorId: string, setup: ConnectorSetupWords, lang: Lang, paired: boolean): OutMessage;
  /** The disconnect card again, `text` on it: pressing again can help. */
  disconnectAgain(text: string, connectorId: string, host: string, lang: Lang): OutMessage;
  permission(input: PermissionInput): OutMessage;
  decided(option: Readonly<Record<string, unknown>>, when: number, timezone: string, lang: Lang): OutMessage;
  /** The permission card again with `text` on it, its buttons live. */
  reopened(
    options: readonly unknown[],
    sessionId: string,
    actionId: string,
    tool: string,
    text: string,
    lang: Lang,
  ): OutMessage;
  takeoverConfirm(
    connector: Reported,
    agent: Reported,
    entry: Conversation,
    lang: Lang,
    view: string,
    ticket: string,
  ): OutMessage;
  /** A short note that replaces a tapped card (under `title` when there is one). */
  note(text: string, title?: string): OutMessage;
}
