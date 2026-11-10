// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The hidden conversations of one machine, as an Adaptive Card. */
import type { remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, header, message } from "../../cards/kit.js";
import { actionSet, block, remoteAction } from "./elements.js";

export function hiddenCard(view: remoteView.HiddenView): CardMessage {
  const body: CardElement[] = [header(view.title, { emoji: "session" })];
  for (const entry of view.entries) {
    body.push(
      block(entry.title, { spacing: "Small" }),
      block(entry.where, { isSubtle: true, size: "Small", spacing: "None" }),
      actionSet([entry.unhide]),
    );
  }
  if (view.nothing) body.push(block(view.nothing));
  return message(body, view.actions.map(remoteAction));
}
