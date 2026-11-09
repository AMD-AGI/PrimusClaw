// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The smaller cards of the remote agents: disconnecting a machine, taking over a terminal's conversation, picking an agent on a
 * machine, picking a mode. */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { type RemoteButton, remoteButton } from "./actions.js";
import { type Approval, approvalChoice, kindLabel, startsUnattended } from "./agents.js";
import type { Conversation } from "./conversations.js";
import { lit, neutral } from "./inert.js";
import { BUTTON_TITLE_MAX, OPTION_BUTTONS_MAX } from "./limits.js";
import { disconnectTitle } from "./lines.js";
import type { RemoteAgent, RemoteConnector } from "./pending-model.js";
import type { ConnectorSetupWords } from "./setup.js";

export interface DisconnectView {
  readonly lang: Lang;
  readonly title: string;
  /** How to connect it again. */
  readonly again: string;
  /** The exact login command (a machine that signed in with login), null for a paired machine. */
  readonly login: string | null;
  readonly connectorId: string;
  readonly confirm: string;
  readonly keep: string;
}

/** Asks before a machine is disconnected: it ends every session on it, and says how to connect it again. `paired`: Claw says the
 * machine was connected with a pairing code; a login command is no use there. */
export function disconnectView(
  host: string,
  connectorId: string,
  setup: ConnectorSetupWords,
  lang: Lang = "en",
  paired = false,
): DisconnectView {
  const words = remoteText.in(lang);
  return {
    lang,
    title: disconnectTitle(host, lang),
    again: paired ? words.disconnectAgainPaired : words.disconnectAgain,
    login: paired ? null : setup.login(),
    connectorId,
    confirm: words.disconnect,
    keep: words.keepIt,
  };
}

export interface TakeoverView {
  readonly lang: Lang;
  readonly title: string;
  readonly conversation: string;
  /** `host · folder`. */
  readonly where: string;
  readonly what: string;
  readonly oneSide: string;
  readonly buttons: readonly RemoteButton[];
}

/** What a tap on Take over… for a conversation open in a terminal opens: what will happen, in so many words, then Take over and
 * Cancel. `ticket`: what the confirmation carries ("1" when none). */
export function takeoverView(
  connector: RemoteConnector,
  agent: RemoteAgent,
  entry: Conversation,
  lang: Lang = "en",
  view = "",
  ticket = "",
): TakeoverView {
  const words = remoteText.in(lang);
  const viewField = view ? { view } : {};
  return {
    lang,
    title: words.takeOverTitle,
    conversation: `**${lit(entry.title, 80) || words.untitled}**`,
    where: `${lit(connector.name, 80)} · ${lit(entry.cwd, 80)}`,
    what: words.takeOverWhat({ ref: lit(entry.ref, 64) }),
    oneSide: words.oneSide,
    buttons: [
      remoteButton(words.takeOverOk, "new", "destructive", {
        takeover: ticket || "1",
        connector_id: connector.connectorId,
        agent_id: agent.agentId,
        resume: entry.ref,
        ...viewField,
      }),
      remoteButton(words.cancel, "list", null, viewField),
    ],
  };
}

export interface ApprovalInput {
  readonly id: string;
  readonly label: string;
  readonly value: Approval;
  readonly choices: readonly { readonly title: string; readonly value: Approval }[];
}

/** The choice between asking for approval and not, for an agent whose connector lets a client switch; null otherwise. */
export function approvalInput(agent: RemoteAgent, slot: number, lang: Lang): ApprovalInput | null {
  const choice = approvalChoice(agent);
  if (!choice) return null;
  const words = remoteText.in(lang);
  return {
    id: `appr${slot}`,
    label: words.approval,
    value: choice.default,
    choices: [
      { title: words.askMe, value: "ask" },
      { title: words.noApproval, value: "unattended" },
    ],
  };
}

export interface MachineChoiceView {
  readonly lang: Lang;
  readonly title: string;
  readonly worksIn: string;
  readonly agents: readonly {
    readonly unattendedNote: string | null;
    readonly approval: ApprovalInput | null;
    readonly button: RemoteButton;
  }[];
  readonly more: string | null;
}

/** `/agent new MACHINE PATH` named a machine with more than one online agent: a block per agent, each starting the session in
 * `path`. The folder is not in the buttons: the worker keeps what was typed under `token`, so a card cannot choose it. */
export function machineChoiceView(
  connector: RemoteConnector,
  agents: readonly RemoteAgent[],
  token: string,
  path: string,
  lang: Lang = "en",
): MachineChoiceView {
  const words = remoteText.in(lang);
  const shown = agents.slice(0, OPTION_BUTTONS_MAX).map((agent, slot) => {
    const { icon, label } = kindLabel(agent.kind);
    const title = neutral(`${icon} ${neutral(agent.name, 30) || label}`, BUTTON_TITLE_MAX);
    return {
      unattendedNote: startsUnattended(agent) ? words.unattendedNote : null,
      approval: approvalInput(agent, slot, lang),
      button: remoteButton(title, "new", null, {
        connector_id: connector.connectorId,
        agent_id: agent.agentId,
        slot,
        typed: token,
      }),
    };
  });
  const hidden = agents.length - OPTION_BUTTONS_MAX;
  return {
    lang,
    title: words.whichAgent({ host: lit(connector.name, 80) }),
    worksIn: words.worksIn({ path: lit(path, 200) }),
    agents: shown,
    more: hidden > 0 ? words.moreNotShown({ n: hidden }) : null,
  };
}

export interface ModeView {
  readonly lang: Lang;
  readonly title: string;
  readonly value: string;
  readonly choices: readonly { readonly title: string; readonly value: string }[];
  readonly setMode: RemoteButton;
  readonly back: RemoteButton;
}

/** What a tap on Mode opens: the modes the connector reports (one that runs without asking for approval says so), Set mode, Back. */
export function modeView(
  sessionId: string,
  current: string | null,
  modes: readonly string[],
  unattended: ReadonlySet<string> = new Set(),
  lang: Lang = "en",
): ModeView {
  const words = remoteText.in(lang);
  return {
    lang,
    title: words.whichMode,
    value: current !== null && modes.includes(current) ? current : (modes[0] ?? ""),
    choices: modes.map((m) => ({ title: neutral(m, 40) + (unattended.has(m) ? words.unattendedSuffix : ""), value: m })),
    setMode: remoteButton(words.setMode, "set_mode", null, { session_id: sessionId }),
    back: remoteButton(words.backButton, "row", null, { session_id: sessionId }),
  };
}
