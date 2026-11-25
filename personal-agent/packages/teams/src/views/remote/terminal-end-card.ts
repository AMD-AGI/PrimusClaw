// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of a turn that ended in a terminal while nobody was at it: the conversation's name and status as the title, the tool, machine,
 * folder and item number in one small line under it, what the agent did, its whole last answer folded behind "Show all", and buttons
 * that send the commands for it as the person's own message (an imBack: the command is handled exactly as if typed).
 */
import type { remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, fold, header, message, note } from "../../cards/kit.js";
import { block } from "./elements.js";

/** A button that sends `command` into the chat as the person's own message. */
export function commandAction(button: remoteView.CommandButton): CardElement {
  return { type: "Action.Submit", title: button.title, data: { msteams: { type: "imBack", value: button.command } } };
}

export function terminalEndCard(view: remoteView.TerminalEndView): CardMessage {
  const body: CardElement[] = [
    header(view.title, {
      tone: view.failed ? "attention" : "good",
      emoji: view.failed ? "failed" : "good",
      subtitle: view.where,
    }),
  ];
  if (view.summary) body.push(block(view.summary, { spacing: "Small" }));
  if (view.full) body.push(...fold("end-full", [block(view.full, { spacing: "Small" })], view.fullLabel));
  if (view.rest) body.push(note(view.rest));
  return message(body, view.buttons.map(commandAction));
}
