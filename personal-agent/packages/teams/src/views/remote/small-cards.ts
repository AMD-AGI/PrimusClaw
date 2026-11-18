// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The smaller remote-agent cards: disconnecting a machine, taking over a terminal's conversation, choosing an agent, a mode. */
import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, buttons, header, message, text } from "../../cards/kit.js";
import { approvalBlock } from "./agents-card.js";
import { actionSet, block, remoteAction, warningNote } from "./elements.js";

/** Disconnect (the destructive primary) and Keep it: what the disconnect card's buttons carry. */
export function disconnectButtons(connectorId: string, confirm: string, keep: string): CardElement[] {
  const button = (title: string, yes: boolean): CardElement => ({
    type: "Action.Execute",
    title,
    verb: "primusclaw.remote_off",
    data: remoteDomain.disconnectData(connectorId, yes),
  });
  return buttons([button(confirm, true), button(keep, false)], "destructive");
}

/** Asks before a machine is disconnected. */
export function disconnectCard(view: remoteView.DisconnectView): CardMessage {
  const body = [header(view.title, { tone: "attention", emoji: "connect" }), text(view.again)];
  if (view.login !== null) body.push(text(view.login, { mono: true, spacing: "Small" }));
  return message(body, disconnectButtons(view.connectorId, view.confirm, view.keep));
}

/** What a tap on Take over… opens. */
export function takeoverCard(view: remoteView.TakeoverView): CardMessage {
  const body = [
    header(view.title, { tone: "warning", emoji: "connect" }),
    block(view.conversation, { spacing: "Small" }),
    block(view.where, { isSubtle: true, size: "Small", spacing: "None" }),
    block(view.what, { spacing: "Small" }),
    block(view.oneSide, { isSubtle: true, size: "Small" }),
  ];
  return message(body, view.buttons.map(remoteAction));
}

/** Which agent on a machine a new session goes to. */
export function machineChoiceCard(view: remoteView.MachineChoiceView): CardMessage {
  const body: CardElement[] = [header(view.title, { emoji: "machine" }), block(view.worksIn, { isSubtle: true })];
  view.agents.forEach((agent, slot) => {
    const items: CardElement[] = [];
    if (agent.unattendedNote) items.push(warningNote(agent.unattendedNote, (v) => text(v, { size: "Small" })));
    if (agent.approval) items.push(approvalBlock(agent.approval));
    items.push(actionSet([agent.button]));
    body.push({ type: "Container", items, separator: slot > 0 });
  });
  if (view.more) body.push(block(view.more, { isSubtle: true }));
  return message(body);
}

/** What a tap on Mode opens. */
export function modeCard(view: remoteView.ModeView): CardMessage {
  return message(
    [
      header(view.title, { emoji: "settings" }),
      {
        type: "Input.ChoiceSet",
        id: "mode",
        style: "compact",
        value: view.value,
        choices: view.choices.map((c) => ({ title: c.title, value: c.value })),
      },
    ],
    buttons([remoteAction(view.setMode), remoteAction(view.back)]),
  );
}
