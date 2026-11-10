// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cards the domain builds beside `cards.ts`: the note that replaces a tapped card (and the notes that bring a card's buttons
 * back), and the session card as the window. Built from the note view and the remote views; nothing here talks to a channel.
 */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { noteMessage } from "../note/note.js";
import type { OutMessage, ViewButton } from "../ports/surface.js";
import { type DecisionButton, decisionData, disconnectData } from "./actions.js";

/** A short note that replaces a tapped card (under `title` when there is one). */
export function noteCard(text: string, title?: string, buttons?: readonly ViewButton[]): OutMessage {
  return noteMessage({
    text,
    ...(title === undefined ? {} : { title }),
    ...(buttons === undefined ? {} : { buttons }),
  });
}

function decisionButton(button: DecisionButton): ViewButton {
  return {
    title: button.title,
    verb: "primusclaw.remote_decision",
    data: decisionData(button),
    ...(button.primary ? { style: "positive" as const } : {}),
  };
}

/** The permission card's buttons again under `text`, titled with the request: the decision did not go through. */
export function reopenedCard(buttons: readonly DecisionButton[], title: string, text: string): OutMessage {
  return noteCard(text, title, buttons.map(decisionButton));
}

/** The disconnect buttons again under `text`: pressing again can help. */
export function disconnectAgainCard(text: string, connectorId: string, title: string, lang: Lang): OutMessage {
  const words = remoteText.in(lang);
  const buttons: ViewButton[] = [
    {
      title: words.disconnect,
      verb: "primusclaw.remote_off",
      data: disconnectData(connectorId, true),
      style: "destructive",
    },
    { title: words.keepIt, verb: "primusclaw.remote_off", data: disconnectData(connectorId, false) },
  ];
  return noteCard(text, title, buttons);
}
