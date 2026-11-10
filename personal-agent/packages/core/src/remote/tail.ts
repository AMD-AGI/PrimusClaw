// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a session's events end now, so a chat that attaches (or sends a message) does not replay them: the id of the last event,
 * what the agent said about its modes, whether it is at work (text or tool events after the last turn end: a turn of this chat's,
 * or the agent going on by itself, which the events do not tell apart), the steps that have begun and not ended since then, and the
 * permission requests nobody has answered yet.
 */
import type { SseEvent } from "../claw/model.js";
import { type RemoteStep } from "./events.js";
import type { JsonObject } from "../json.js";
import { recordOf, textOf } from "./fields.js";
import { noteStep } from "./follow/steps.js";

/** Events read per page of the replay; a shorter page is the last. */
export const TAIL_PAGE = 1000;

export interface SessionTail {
  /** The id of the last event ('' none). */
  readonly cursor: string;
  readonly mode: string | null;
  readonly modes: readonly string[];
  readonly unattended: boolean | null;
  readonly modeFlags: Readonly<Record<string, boolean>> | null;
  /** The session only watches a conversation open in a terminal. */
  readonly readOnly: boolean;
  /** What is sent is typed into a terminal on the machine. */
  readonly terminal: boolean;
  /** Output after the last turn end. */
  readonly active: boolean;
  /** The steps begun and not ended since the last turn end. */
  readonly steps: readonly string[];
  /** The permission requests nobody has answered, while a turn is open. */
  readonly pending: readonly Readonly<Record<string, unknown>>[];
  /** ... their action ids. */
  readonly asked: readonly string[];
}

/** One stored event as the replay lists it. */
export interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
}

/** The event a replayed row is, as the stream would have sent it (a `data` that is no object says nothing). */
export function rowEvent(row: EventRow): SseEvent {
  return { id: row.id, name: row.type, data: { data: (recordOf(row.data) ?? {}) as JsonObject } };
}

/** The rows of a session's events folded into its tail, step by step. */
export class TailFold {
  private cursor = "";
  private mode: string | null = null;
  private modes: readonly string[] | null = null;
  private unattended: boolean | null = null;
  private modeFlags: Readonly<Record<string, boolean>> | null = null;
  private readOnly = false;
  private terminal = false;
  private open = false;
  private readonly asked = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly steps = new Map<string, boolean>();

  /** One row and what it decoded to. A replayed event is not the session's own: it moves nothing, not even the cursor. */
  add(rowId: string, step: RemoteStep): void {
    if (step.replay) return;
    this.noteModes(step);
    if (step.finished) {
      this.open = false;
      this.steps.clear();
    } else if (step.chunk || step.tool || step.plan || filled(step.permission)) {
      this.open = true;
      if (step.tool) noteStep(this.steps, step.tool);
    }
    const asking = filled(step.permission) ? actionIdOf(step.permission) : "";
    if (step.permission && asking) this.asked.set(asking, step.permission);
    if (step.resolved) this.asked.delete(actionIdOf(step.resolved));
    this.cursor = rowId;
  }

  private noteModes(step: RemoteStep): void {
    if (step.started || step.mode !== null) {
      this.mode = step.mode ?? this.mode;
      this.modes = step.modes ?? this.modes;
    }
    if (step.unattended !== null) this.unattended = step.unattended;
    if (step.modeFlags !== null) this.modeFlags = step.modeFlags;
    if (step.readOnly !== null) this.readOnly = step.readOnly;
    if (step.terminal !== null) this.terminal = step.terminal;
  }

  result(): SessionTail {
    return {
      cursor: this.cursor,
      mode: this.mode,
      modes: this.modes ?? [],
      unattended: this.unattended,
      modeFlags: this.modeFlags,
      readOnly: this.readOnly,
      terminal: this.terminal,
      active: this.open,
      steps: [...this.steps.keys()],
      pending: this.open ? [...this.asked.values()] : [],
      asked: this.open ? [...this.asked.keys()] : [],
    };
  }
}

/** An object with at least one field (an empty payload says nothing). */
export function filled(
  payload: Readonly<Record<string, unknown>> | null,
): payload is Readonly<Record<string, unknown>> {
  return payload !== null && Object.keys(payload).length > 0;
}

/** The `actionId` a permission request (or its resolution) names, as text ('' none). */
export function actionIdOf(payload: Readonly<Record<string, unknown>>): string {
  return textOf(payload.actionId);
}

/** Reads a page of a session's stored events after a cursor (null: from the start). */
export type ReadEvents = (after: string | null, limit: number) => Promise<readonly EventRow[]>;

/** The session's tail, read page by page from its start. */
export async function readTail(read: ReadEvents, decode: (event: SseEvent) => RemoteStep): Promise<SessionTail> {
  const fold = new TailFold();
  let after: string | null = null;
  for (;;) {
    const page = await read(after, TAIL_PAGE);
    for (const row of page) fold.add(row.id, decode(rowEvent(row)));
    if (page.length < TAIL_PAGE) return fold.result();
    // The next page starts after the last row read, replayed or not: the tail's cursor stays the session's own last event, but a
    // page of replayed rows alone must not be asked for again (it would be, for ever).
    after = page.at(-1)?.id || after;
  }
}
