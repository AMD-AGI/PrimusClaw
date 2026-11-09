// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A short note, under an optional headline, with the buttons that go with it: what replaces a card the person just
 * clicked (the outcome of the click, and the buttons again when it has to be repeated), and any other "a line and a
 * button" message (render.py's note_card). Every line uses this view for that shape.
 */

import type { JsonObject } from "../json.js";
import type { OutMessage } from "../ports/surface.js";

/**
 * A button of a view: one that sends its `verb` and `data` back to the worker (the worker's own click protocol), or one
 * that opens `url`. `style` marks the primary (or a destructive) choice. INTERIM here until W0-b adds it to the ports.
 */
export type ViewButton =
  | { readonly title: string; readonly verb: string; readonly data: JsonObject; readonly style?: ButtonStyle }
  | { readonly title: string; readonly url: string; readonly style?: ButtonStyle };

export type ButtonStyle = "positive" | "destructive";

/** How the note's headline reads: its colour and its emoji. */
export type NoteTone = "default" | "good" | "attention" | "warning" | "accent";

export interface NoteModel {
  readonly text: string;
  /** A headline over the note (none: the note alone). */
  readonly title?: string;
  readonly tone?: NoteTone;
  readonly buttons?: readonly ViewButton[];
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
