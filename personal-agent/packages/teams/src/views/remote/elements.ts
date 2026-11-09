// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The Adaptive Card elements the remote-agent cards are built of: a plain TextBlock, an ActionSet, and their buttons. */
import { remoteView } from "@primusclaw/personal-agent";

import type { CardElement, JsonObject } from "../../cards/json.js";

type RemoteButton = remoteView.RemoteButton;
type DecisionButton = remoteView.DecisionButton;

/** A wrapped TextBlock of text that is already what it should say (no punctuation is changed). */
export function block(text: string, extra: JsonObject = {}): CardElement {
  return { type: "TextBlock", text, wrap: true, ...extra };
}

/** A small subtle line right under the line above it. */
export function underNote(text: string): CardElement {
  return block(text, { isSubtle: true, size: "Small", spacing: "None" });
}

/** The Action.Execute of a remote-agent button: its verb names the operation, its data is what the worker reads back. */
export function remoteAction(button: RemoteButton): CardElement {
  const action: CardElement = {
    type: "Action.Execute",
    title: button.title,
    verb: `primusclaw.remote_${button.op}`,
    data: remoteView.remoteData(button.op, button.fields),
  };
  if (button.style) action["style"] = button.style;
  return action;
}

/** A row of buttons inside the card's body. */
export function actionSet(buttons: readonly RemoteButton[]): CardElement {
  return { type: "ActionSet", actions: buttons.map(remoteAction) };
}

/** A permission card's button: the option the agent offered, by its own id. */
export function decisionAction(button: DecisionButton): CardElement {
  const action: CardElement = {
    type: "Action.Execute",
    title: button.title,
    verb: "primusclaw.remote_decision",
    data: remoteView.decisionData(button),
  };
  if (button.primary) action["style"] = "positive";
  return action;
}

/** A warning band around one small line (an unattended session). */
export function warningNote(text: string, words: (value: string) => CardElement): CardElement {
  return { type: "Container", style: "warning", items: [words(text)] };
}
