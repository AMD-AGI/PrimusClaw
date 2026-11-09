// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A short note, under an optional headline, with the buttons that go with it: what replaces a card the person just
 * clicked (the outcome of the click, and the buttons again when it has to be repeated), and any other "a line and a
 * button" message (render.py's note_card). Every line uses this view for that shape.
 */

import type { OutMessage, ViewButton } from "../ports/surface.js";

/** A view's button, marked as the primary (or a destructive) choice when it is one. INTERIM: `style` until W0-b has it. */
export type NoteButton = ViewButton & { readonly style?: ButtonStyle };

export type ButtonStyle = "positive" | "destructive";

/** How the note's headline reads: its colour and its emoji. */
export type NoteTone = "default" | "good" | "attention" | "warning" | "accent";

export interface NoteModel {
  readonly text: string;
  /** A headline over the note (none: the note alone). */
  readonly title?: string;
  readonly tone?: NoteTone;
  readonly buttons?: readonly NoteButton[];
}

declare module "../ports/surface.js" {
  interface ViewMap {
    note: NoteModel;
  }
}

/** The note as a message; a client that cannot draw it shows its text. */
export function noteMessage(model: NoteModel): OutMessage {
  return { body: { type: "view", view: { name: "note", model }, fallbackText: model.text } };
}
