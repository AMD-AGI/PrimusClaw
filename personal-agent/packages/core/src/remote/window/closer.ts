// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a tap on the session card ends (an approval, Send, Full output): the tapped card becomes the window again, with the outcome
 * as its note. An outcome that is a line must reach a phone, which may not redraw the edit: the window is then posted again at the
 * bottom with that line on it, rather than the line being a message of its own above the card. What the card's box held comes
 * back in it. A tap on an older session card ends with that card closed down to a line and the window refreshed; with the chat no
 * longer in a window, it ends as the click otherwise would.
 */
import { remoteAgentText } from "../../locales/remote-agents.js";
import { type Conversation, type OutMessage, textMessage } from "../../ports/surface.js";
import type { StatusBoard } from "../board.js";
import type { RemoteContext } from "../context.js";
import type { Settle } from "../permissions.js";
import type { ChatState } from "../state.js";
import { noteCard } from "../views.js";
import { INPUT_ID, INPUT_MAX, markEdited } from "./view.js";
import { cpSlice } from "../../text/py-text.js";

/** The tap a settle answers: the card it was on, and the data it carried. */
export interface Tap {
  readonly chatKey: string;
  readonly to: Conversation;
  /** The message that holds the tapped card ("" not said). */
  readonly tapped: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export function windowCloser(
  ctx: RemoteContext,
  state: ChatState,
  board: StatusBoard,
  tap: Tap,
  settle: Settle,
): Settle {
  return async (card: OutMessage | string, options = {}) => {
    const text = typeof card === "string" ? card : (options.fallback ?? "");
    const attached = state.attached(tap.chatKey);
    const stored = ctx.remoteState.getRemote(tap.chatKey);
    if (attached === null || attached.window !== "card" || stored === null) return settle(card, options);
    const view = state.view(tap.chatKey, attached);
    view.note = text;
    const typed = tap.data[INPUT_ID];
    if (tap.data["op"] !== "send" && typeof typed === "string") view.draft = cpSlice(typed, 0, INPUT_MAX);
    const said = Boolean(text) && options.announce !== false; // (the line reaches the phone as the card itself, again at the bottom)
    if (tap.tapped === stored.statusCard) return onTheWindow({ ctx, state, board, tap, settle }, text, said);
    const note = noteCard(text || remoteAgentText.in(state.lang(tap.chatKey)).changedElsewhere);
    const done = await settle(note, { announce: false });
    if (!(await board.refreshWindow(tap.chatKey, tap.to, { byPerson: true, repost: said })) && said) {
      await tap.to.send(textMessage(text));
    }
    return done;
  };
}

interface Closing {
  readonly ctx: RemoteContext;
  readonly state: ChatState;
  readonly board: StatusBoard;
  readonly tap: Tap;
  readonly settle: Settle;
}

/** The tap was on the window the chat shows now: posted again with the line on it, else the tapped card becomes the window. */
async function onTheWindow(c: Closing, text: string, said: boolean): Promise<boolean> {
  if (said && (await c.board.refreshWindow(c.tap.chatKey, c.tap.to, { byPerson: true, repost: true }))) return true;
  const attached = c.state.attached(c.tap.chatKey);
  if (attached === null) return c.settle(text);
  const window = c.board.statusOf(c.tap.chatKey, attached, c.state.phase(c.tap.chatKey));
  // (no new card: the line as a message)
  const done = await c.settle(window.message, { ...(text ? { fallback: text } : {}), announce: said });
  if (done) {
    const view = c.state.view(c.tap.chatKey, attached);
    markEdited(view);
    view.boxed = window.takesInput;
  }
  await c.board.dropKept(c.tap.chatKey, c.tap.to);
  return done;
}
