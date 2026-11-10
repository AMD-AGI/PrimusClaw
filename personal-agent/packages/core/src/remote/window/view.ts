// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The session card as the window: a chat attached to a remote session shows it on ONE card that is kept up to date, its name,
 * machine and agent, what it is doing, the end of its output, its pending approvals as buttons, and (while the session is idle)
 * a text box with Send.
 *
 * Where the chat box goes is the person's choice (`/agent mode card|chat`): in `card` mode the chat box goes to the assistant and
 * the card's box (or a reply that quotes the card) to the session; in `chat` mode everything typed goes to the session.
 *
 * A phone does not reliably redraw an edited message. The card is edited in place for small changes and posted again at the
 * bottom when its output changed a lot, a new approval waits, a turn ended, or after a number of edits (`shouldRepost`). What the
 * person types into the card's box is never lost: the box is on the card only while the session is idle (`takesInput`), and a card
 * with a box is edited or removed only as the answer to the person's own act.
 *
 * This module is what one chat's window shows in this process and when it is posted again; the card itself is a view
 * (`remote-view`), and posting it is the remote agents' (`remote/window/board.ts`).
 */
import { cpLength, cpSlice } from "../../text/py-text.js";
import { inertAnswer } from "../links/answer.js";

export const WINDOW_MODES = ["card", "chat"] as const;
export type WindowMode = (typeof WINDOW_MODES)[number];

export function isWindowMode(value: string): value is WindowMode {
  return (WINDOW_MODES as readonly string[]).includes(value);
}

/** The output of the current (or last) turn kept for "完整输出". */
export const FULL_KEEP_CHARS = 60_000;
/** The card's text box. */
export const INPUT_MAX = 4000;
/** The id of that box in what a tap carries. */
export const INPUT_ID = "window_text";
/** An edit more than this many times since the card was posted: it is posted again at the bottom. */
export const REPOST_EDITS = 6;
/** ... while a turn streams into it (an edit every EDIT_SECONDS: about a minute). */
export const REPOST_EDITS_STREAMING = 20;
/** Characters of output new since the card was posted that make it worth posting again. */
export const REPOST_GROWTH = 400;
/** At most one edit of the card per this long while a turn streams into it. */
export const EDIT_SECONDS = 3.0;

/** Where what was last sent to the session was typed: the card's box, a reply quoting the card, the chat box. */
export type SentFrom = "card" | "quote" | "chat" | "";

/**
 * What one attached chat's window shows of its session's output, in this process (it starts empty after a restart: the next turn
 * fills it). `text` is the output of the current turn, or of the last one; `postedLen` how much of it the card showed when it was
 * last posted (not edited); `edits` the edits since then.
 */
export class WindowView {
  sessionId = "";
  text = "";
  /** The step the agent is running now ('' none). */
  step = "";
  /** Why a message waits for the terminal ('' it does not). */
  queued = "";
  /** The last message that went to the session from this chat. */
  sent = "";
  sentFrom: SentFrom = "";
  /** What the card's box held when the person last tapped a button on it other than Send (shown in it again). */
  draft = "";
  /** The card the chat shows now has the text box. */
  boxed = false;
  /** Older cards with a box, left for the person's next act. */
  kept: string[] = [];
  /** One line of ours under the output (how a turn ended, a refusal). */
  note = "";
  postedLen = 0;
  edits = 0;
  approvalsSeen = new Set<string>();
  /** A turn ended and the card has not been refreshed since (the next refresh reads it once). */
  ended = false;

  /** A view of another session starts empty. */
  reset(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.text = this.step = this.queued = this.sent = this.note = "";
    this.postedLen = this.edits = 0;
    this.approvalsSeen = new Set();
    this.ended = false;
    this.sentFrom = "";
    this.draft = "";
  }

  /**
   * The output now. A text that is not the continuation of the one shown (a new turn, a new burst) is measured from nothing: what
   * the card showed when it was posted was another output, and only how much of this one there is counts (`shouldRepost`).
   */
  setText(text: string): void {
    // (an agent's words, whichever way they came: its links and addresses are words)
    const kept = cpSlice(inertAnswer(text), -FULL_KEEP_CHARS);
    const before = cpSlice(this.text, 0, Math.min(cpLength(this.text), 200));
    if (!kept.startsWith(before) || cpLength(kept) < cpLength(this.text)) this.postedLen = 0;
    this.text = kept;
  }
}

/**
 * Whether the next refresh of the window posts it again at the bottom (and removes the old one) rather than editing it in place.
 * `streaming`: an edit while a turn streams into the card, posted again only for an approval or after many edits. A turn's end
 * always posts it again: the card said "running" until then, and a phone that does not redraw the edit would keep saying so.
 */
export function shouldRepost(
  view: WindowView,
  approvals: readonly string[],
  ended = false,
  streaming = false,
): boolean {
  const grown = cpLength(view.text) - view.postedLen;
  const newApproval = approvals.some((a) => !view.approvalsSeen.has(a));
  if (streaming) return newApproval || view.edits >= REPOST_EDITS_STREAMING;
  return newApproval || grown >= REPOST_GROWTH || ended || view.edits >= REPOST_EDITS;
}

export function markPosted(view: WindowView, approvals: readonly string[]): void {
  view.postedLen = cpLength(view.text);
  view.edits = 0;
  view.approvalsSeen = new Set(approvals);
}

export function markEdited(view: WindowView): void {
  view.edits += 1;
}

/**
 * Whether the card in this phase has the text box: only while the session is idle. A running turn's card is edited every
 * EDIT_SECONDS and posted again at the turn's end, and Teams keeps nothing typed into a card across an edit or a delete.
 */
export function takesInput(phase: string): boolean {
  return phase === "idle";
}

/**
 * The message is a reply that quotes one of this chat's session cards (the channel names the quoted message's id): in `card` mode
 * it goes to the session, like the card's own box.
 */
export function quotesWindow(quotedIds: readonly string[], cardIds: readonly string[]): boolean {
  const ids = new Set(cardIds.filter(Boolean));
  return ids.size > 0 && quotedIds.some((id) => ids.has(id));
}
