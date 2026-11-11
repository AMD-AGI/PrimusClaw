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

/** The most a terminal's card may weigh as sent: Teams takes about 28 KB, and this leaves room for the activity around it. */
export const TERMINAL_CARD_SAFE_BYTES = 24_000;

const cardBytes = (card: CardMessage): number => new TextEncoder().encode(JSON.stringify(card)).length;

/**
 * The card of a question a terminal asks: who asks, what, the content whole (or the notice that it is not), then the options.
 * Whatever the request, the card goes out: one heavier than TERMINAL_CARD_SAFE_BYTES is sent cut short instead (only the options
 * that turn it down), and if even that is too heavy, with its title, the notice to approve at the terminal and those options.
 */
export function terminalAskCard(view: remoteView.TerminalAskView): CardMessage {
  const full = terminalAskBody(view);
  if (cardBytes(full) <= TERMINAL_CARD_SAFE_BYTES || view.fallback === undefined) return full;
  const cut = terminalAskBody(view.fallback);
  if (cardBytes(cut) <= TERMINAL_CARD_SAFE_BYTES) return cut;
  return terminalAskBody({ ...view.fallback, who: "", asks: "", sections: [], notes: view.fallback.notes.slice(-2) });
}

function terminalAskBody(view: remoteView.TerminalAskView): CardMessage {
  const body: CardElement[] = [header(view.title, { tone: "attention", emoji: "needs_you" })];
  if (view.who) body.push(block(view.who, { isSubtle: true, spacing: "Small" }));
  if (view.asks) body.push(block(view.asks, { spacing: "Small" }));
  for (const s of view.sections) {
    if (s.type === "code") body.push(text(s.text, { mono: true, spacing: "Small" }));
    else if (s.type === "words") body.push(block(s.text, { spacing: "Small" }));
    else if (s.type === "option")
      body.push(block(s.description ? `**${s.label}** — ${s.description}` : `**${s.label}**`, { spacing: "Small" }));
    else body.push(block(s.text, { isSubtle: true, spacing: "Small" }));
  }
  body.push(...view.notes.map((n) => note(n)));
  return message(body, view.buttons.map(decisionAction), OPTIONS_MAX);
}

/** What a permission card becomes once answered. */
export function decidedCard(view: remoteView.DecidedView): CardMessage {
  return message([
    header(view.title, { tone: view.allowed ? "good" : "attention", emoji: view.allowed ? "good" : "denied" }),
  ]);
}
