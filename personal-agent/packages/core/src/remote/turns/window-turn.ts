// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A remote agent's turn shown in the chat's session card (the window), in place of the chat's stream: what the agent writes fills
 * the card's output (an edit at most every EDIT_SECONDS), the step it runs and a message waiting for the terminal are its state,
 * and the end of the turn refreshes it (posted again at the bottom: a phone may not redraw an edit). Nothing else is posted.
 */
import type { Conversation } from "../../ports/surface.js";
import { type RemoteStep } from "../events.js";
import { pyRstrip, pyStrip } from "../../text/py-text.js";
import { redactText } from "../../security/redact.js";
import type { StatusBoard } from "../board.js";
import type { ChatState } from "../state.js";
import type { TurnDisplay } from "./display.js";

export class WindowTurn implements TurnDisplay {
  tail = "";
  private readonly segments: string[] = [];
  private newSegment = true;
  private closed = false;

  constructor(
    private readonly chatKey: string,
    private readonly to: Conversation,
    private readonly state: ChatState,
    private readonly board: StatusBoard,
    private readonly cutError: (text: string) => string,
  ) {}

  private get view(): ReturnType<ChatState["view"]> {
    return this.state.view(this.chatKey);
  }

  private said(): string {
    const text = this.segments
      .map((s) => pyStrip(s))
      .filter(Boolean)
      .join("\n\n");
    return pyRstrip(this.cutError(redactText(text).text));
  }

  begin(): void {
    const view = this.view;
    view.setText("");
    view.step = view.queued = view.note = "";
    this.board.scheduleWindow(this.chatKey, this.to);
  }

  progress(step: RemoteStep): void {
    if (this.closed) return;
    const view = this.view;
    let changed = false;
    if (step.chunk?.kind === "message") {
      if (this.newSegment || this.segments.length === 0) {
        this.segments.push("");
        this.newSegment = false;
      }
      const last = this.segments.length - 1;
      this.segments[last] = (this.segments[last] ?? "") + step.chunk.text;
      view.setText(this.said());
      view.queued = "";
      changed = true;
    } else if (step.tool) {
      this.newSegment = true;
      view.step = step.tool.status === "completed" || step.tool.status === "failed" ? "" : step.tool.title;
      changed = true;
    }
    if (step.queued !== null) {
      view.queued = step.note ?? step.queued;
      changed = true;
    }
    if (changed) this.board.scheduleWindow(this.chatKey, this.to);
  }

  close(): void {
    this.closed = true;
    this.board.cancelWindowEdit(this.chatKey);
  }

  /** (the window has no labels or replies: the options are the chat's) */
  finish(parts: readonly string[]): Promise<void> {
    this.close();
    const view = this.view;
    const said = this.said();
    view.step = view.queued = "";
    if (said) {
      view.setText(said);
      view.note = this.tail;
    } else {
      view.note = pyStrip(parts.filter(Boolean).join("\n\n")); // (no words of the agent: how it ended is the note)
    }
    // Shown by the refresh made once the turn is let go of: now the card would still say "running".
    view.ended = true;
    return Promise.resolve();
  }
}
