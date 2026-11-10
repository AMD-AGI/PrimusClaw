// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The session card as the window, as an Adaptive Card. */
import { pyStrip, type remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, header, message, note, text } from "../../cards/kit.js";
import { block, decisionAction, remoteAction, warningNote } from "./elements.js";

/** The window's own buttons may each stay one tap away: Send, Stop, Back and Switch. */
const WINDOW_BUTTONS_MAX = 4;

function mono(lines: readonly string[]): CardElement[] {
  return lines.map((line) => ({
    type: "TextBlock",
    text: pyStrip(line) ? line : "\u{00a0}", // (a blank line holds a no-break space, as the Python worker's card does)
    wrap: true,
    fontType: "Monospace",
    size: "Small",
    spacing: "None",
  }));
}

function outputBlocks(output: remoteView.WindowOutput): CardElement[] {
  const shown = output.empty === null ? mono(output.lines) : [text(output.empty, { subtle: true, size: "Small" })];
  const blocks: CardElement[] = [
    { type: "Container", style: "emphasis", spacing: "Small", items: shown, id: "window_tail" },
  ];
  const row: CardElement[] = [];
  if (output.more) {
    blocks.push({
      type: "Container",
      style: "emphasis",
      id: "window_more",
      isVisible: false,
      spacing: "None",
      items: mono(output.more),
    });
    row.push({ type: "Action.ToggleVisibility", title: output.moreToggle, targetElements: ["window_more"] });
  }
  row.push(...output.buttons.map(remoteAction));
  if (row.length > 0) blocks.push({ type: "ActionSet", actions: row, spacing: "None" });
  return blocks;
}

function waitingBlocks(view: remoteView.WindowCardView): CardElement[] {
  const blocks: CardElement[] = view.approvals.map((approval) => ({
    type: "Container",
    style: "attention",
    spacing: "Medium",
    items: [
      text(approval.text, { weight: "Bolder", size: "Small" }),
      { type: "ActionSet", actions: approval.buttons.map(decisionAction) },
    ],
  }));
  if (view.moreApprovals) blocks.push(note(view.moreApprovals));
  if (view.groupNote) blocks.push(note(view.groupNote));
  return blocks;
}

function boxBlocks(view: remoteView.WindowCardView): CardElement[] {
  if (view.box) {
    const box: CardElement = {
      type: "Input.Text",
      id: view.box.id,
      isMultiline: true,
      maxLength: view.box.maxLength,
      spacing: "Medium",
      placeholder: view.box.placeholder,
    };
    // (what the box held at the person's last tap: Teams does not keep it across the card's refresh)
    if (view.box.value) box["value"] = view.box.value;
    return [box];
  }
  return view.boxNote ? [note(view.boxNote)] : [];
}

function headBlocks(view: remoteView.WindowCardView): CardElement[] {
  const blocks: CardElement[] = view.lead ? [text(view.lead)] : [];
  blocks.push(header(view.title, { tone: view.waiting ? "attention" : "accent", emoji: "connect" }));
  if (view.sub) blocks.push(text(view.sub, { subtle: true, size: "Small", spacing: "None" }));
  blocks.push(text(view.state, { weight: "Bolder", spacing: "Small" }));
  if (view.unattended) blocks.push(warningNote(view.unattended, (v) => text(v, { size: "Small" })));
  if (view.sent) blocks.push(text(view.sent, { subtle: true, size: "Small", spacing: "Small" }));
  return blocks;
}

/** The session card. */
export function windowCard(view: remoteView.WindowCardView): CardMessage {
  const body: CardElement[] = [...headBlocks(view), ...outputBlocks(view.output)];
  if (view.note) body.push(text(view.note, { subtle: true, size: "Small", spacing: "Small" }));
  body.push(...waitingBlocks(view), ...boxBlocks(view), note(view.chatBox));
  if (view.page) body.push(block(view.page, { size: "Small", spacing: "Small" }));
  body.push(block(view.updated, { isSubtle: true, size: "Small", spacing: "None" }));
  return message(body, view.actions.map(remoteAction), WINDOW_BUTTONS_MAX);
}
