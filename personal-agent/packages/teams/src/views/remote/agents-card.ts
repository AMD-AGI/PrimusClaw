// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The agents card (`/agents`) and the conversations an agent offers, as an Adaptive Card. */
import type { remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, header, message, text } from "../../cards/kit.js";
import { actionSet, block, remoteAction, underNote, warningNote } from "./elements.js";

/** The conversations of an agent block (also used where a conversation list is shown alone). */
export function conversationBlocks(items: readonly remoteView.ConversationItem[]): CardElement[] {
  return items.flatMap((item): CardElement[] => {
    switch (item.kind) {
      case "conversation":
        return [
          block(item.title, { spacing: "Small" }),
          block(item.where, { isSubtle: true, size: "Small", spacing: "None" }),
        ];
      case "note":
        return [underNote(item.text)];
      case "buttons":
        return [actionSet(item.buttons)];
      case "group":
        return [block(item.text, { isSubtle: true, size: "Small", separator: item.separator })];
      case "more":
        return [block(item.text, { isSubtle: true, size: "Small" })];
    }
  });
}

function startBlocks(slot: number, start: NonNullable<remoteView.AgentBlock["start"]>): CardElement[] {
  const items: CardElement[] = [];
  const folder = start.folder;
  const input = (id: string, field: remoteView.FolderInput): CardElement => ({
    type: "Input.Text",
    id,
    label: field.label,
    placeholder: field.placeholder,
    maxLength: field.maxLength,
  });
  if (folder.kind === "roots") {
    items.push({
      type: "Input.ChoiceSet",
      id: `root${String(slot)}`,
      label: folder.label,
      style: "compact",
      value: folder.roots[0]?.value ?? "",
      choices: folder.roots.map((r) => ({ title: r.title, value: r.value })),
    });
    items.push(input(`dir${String(slot)}`, folder.subfolder));
  } else {
    items.push(input(`dir${String(slot)}`, folder.input));
  }
  if (start.approval) items.push(approvalBlock(start.approval));
  items.push(actionSet([start.button]));
  return items;
}

/** The choice between asking for approval and not. */
export function approvalBlock(choice: remoteView.ApprovalInput): CardElement {
  return {
    type: "Input.ChoiceSet",
    id: choice.id,
    label: choice.label,
    style: "compact",
    value: choice.value,
    choices: choice.choices.map((c) => ({ title: c.title, value: c.value })),
  };
}

function agentContainer(agent: remoteView.AgentBlock): CardElement {
  const items: CardElement[] = [block(agent.title, { weight: "Bolder" })];
  if (agent.unattendedNote) items.push(warningNote(agent.unattendedNote, (v) => text(v, { size: "Small" })));
  if (agent.start) items.push(...startBlocks(agent.slot, agent.start));
  items.push(...conversationBlocks(agent.conversations));
  if (agent.nothingToTakeOver) items.push(block(agent.nothingToTakeOver, { isSubtle: true }));
  return { type: "Container", id: `row-agent-${String(agent.slot)}`, items, separator: true, spacing: "Medium" };
}

function item(view: remoteView.AgentsView, entry: remoteView.AgentsItem): CardElement {
  switch (entry.kind) {
    case "lead":
    case "plain":
      return block(entry.text);
    case "machine":
      return block(entry.text, { separator: entry.separator });
    case "versionNote":
      return text(entry.text, { size: "Small" });
    case "problems":
      return {
        type: "Container",
        style: "warning",
        spacing: "Small",
        items: entry.lines.map((line) => text(line, { size: "Small" })),
      };
    case "subtle":
      return block(entry.text, { isSubtle: true });
    case "agent":
      return agentContainer(entry);
    case "heading":
      return block(entry.text, { separator: true });
    case "session":
      return {
        type: "Container",
        separator: entry.number > 1 || !view.machines,
        items: [block(entry.line), actionSet(entry.buttons)],
      };
    case "footer":
      return block(entry.text, { isSubtle: true, size: "Small", separator: true });
  }
}

/** The agents card. */
export function agentsCard(view: remoteView.AgentsView): CardMessage {
  const body = [
    header(view.title, { emoji: view.machines ? "machine" : "session" }),
    ...view.items.map((entry) => item(view, entry)),
  ];
  return message(body, view.actions.map(remoteAction));
}
