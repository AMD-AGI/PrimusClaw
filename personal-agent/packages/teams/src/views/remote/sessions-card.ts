// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The sessions card: every session the user has, per machine and agent, as an Adaptive Card. */
import type { remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, header, message, text } from "../../cards/kit.js";
import { actionSet, block, remoteAction, underNote } from "./elements.js";

function row(entry: remoteView.AgentRow): CardElement[] {
  switch (entry.kind) {
    case "session":
      return [
        block(entry.line, { spacing: "Small", id: `row-session-${String(entry.number)}` }),
        actionSet(entry.buttons),
      ];
    case "more":
      return [block(entry.text, { isSubtle: true, size: "Small" })];
    case "conversation":
      return [block(entry.line, { spacing: "Small", id: `row-conv-${String(entry.rowId)}` })];
    case "buttons":
      return [actionSet(entry.buttons)];
    case "note":
      return [underNote(entry.text)];
  }
}

/** The connect steps on a card: each command a monospace line of its own. */
export function connectBlocks(steps: remoteView.ConnectSteps): CardElement[] {
  return [
    text(steps.lead),
    ...steps.commands.map((command) => text(command, { mono: true, spacing: "Small" })),
    text(steps.after, { size: "Small" }),
    text(steps.notes, { subtle: true, size: "Small" }),
  ];
}

function item(entry: remoteView.SessionsItem): CardElement[] {
  switch (entry.kind) {
    case "lead":
      return [block(entry.text)];
    case "badge":
      return [block(entry.text, { weight: "Bolder", color: "attention", id: "badge-waiting" })];
    case "machine":
      return [block(entry.text, { separator: true, ...(entry.online ? { color: "good" } : { isSubtle: true }) })];
    case "versionNote":
      return [text(entry.text, { size: "Small" })];
    case "subtle":
      return [block(entry.text, { isSubtle: true })];
    case "agent":
      return [
        {
          type: "Container",
          id: `row-agent-${String(entry.rowId)}`,
          items: [block(entry.title, { weight: "Bolder", spacing: "Small" }), ...entry.rows.flatMap(row)],
          spacing: "Small",
        },
      ];
    case "connect":
      return connectBlocks(entry.steps);
    case "window":
      return [block(entry.text, { size: "Small", spacing: "Small", separator: true })];
  }
}

/** The sessions card. */
export function sessionsCard(view: remoteView.SessionsView): CardMessage {
  const body = [header(view.title, { emoji: "session" }), ...view.items.flatMap(item)];
  return message(body, view.actions.map(remoteAction));
}
