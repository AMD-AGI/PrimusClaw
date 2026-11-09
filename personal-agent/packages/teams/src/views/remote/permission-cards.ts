// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A remote agent's permission request as a card, the push of one that waits on the user, and what either becomes once answered. */
import { approvalView, type remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, header, headerItems, message, note, text } from "../../cards/kit.js";
import { approvalBody } from "../approval/index.js";
import { block, decisionAction } from "./elements.js";

/** The body of a permission card (the action, its key arguments as facts, the raw call folded): the approval card's own. */
function remoteApprovalBody(view: remoteView.PermissionView): CardElement[] {
  return approvalBody(approvalView({ tool: view.action, toolInput: view.input, lang: view.lang, group: false }));
}

/** The options are the agent's own: each must stay reachable, so these cards alone may carry four buttons. */
const OPTIONS_MAX = 4;

/** The card for one `permissionRequest`, on the approval card's body. */
export function permissionCard(view: remoteView.PermissionView): CardMessage {
  const body = remoteApprovalBody(view);
  const top = body[0];
  if (top) headerItems(top).push(text(view.asking, { subtle: true, size: "Small", spacing: "None" }));
  return message([...body, ...view.notes.map((n) => note(n))], view.buttons.map(decisionAction), OPTIONS_MAX);
}

/** The push for an agent on the user's machine that waits on them. */
export function remoteAskCard(view: remoteView.RemoteAskView): CardMessage {
  const body = [
    header(view.title, { tone: "attention", emoji: "needs_you" }),
    block(view.tool),
    block(view.waits, { isSubtle: true, spacing: "Small" }),
    ...view.notes.map((n) => note(n)),
  ];
  return message(body, view.buttons.map(decisionAction), OPTIONS_MAX);
}

/** What a permission card becomes once answered. */
export function decidedCard(view: remoteView.DecidedView): CardMessage {
  return message([
    header(view.title, { tone: view.allowed ? "good" : "attention", emoji: view.allowed ? "good" : "denied" }),
  ]);
}
