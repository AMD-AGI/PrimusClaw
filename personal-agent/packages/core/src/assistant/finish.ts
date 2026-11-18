// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a press on one of the assistant's cards ends (teams_agent/assistant.py `_finish`): the pressed card is replaced by `edited`
 * (a note when it is text), and `said` (by default the same text) is said as a new message, since Teams on a phone does not redraw
 * an edited card. `said` may be a card of its own, which can be pressed again.
 */
import type { CardClick } from "../approvals/click.js";
import type { OutMessage } from "../ports/surface.js";

export async function finish(click: CardClick, edited: OutMessage | string, said?: OutMessage | string): Promise<void> {
  const line = said ?? (typeof edited === "string" ? edited : undefined);
  if (line === undefined || typeof line === "string") {
    await click.settle(edited, line === undefined ? {} : { fallback: line });
    return;
  }
  await click.settle(edited, { announce: false });
  await click.conversation.send(line);
}
