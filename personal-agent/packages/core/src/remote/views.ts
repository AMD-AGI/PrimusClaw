// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cards of remote agents the domain cannot build from `remote-view` alone: the generic note that replaces a tapped card (and
 * the note that brings a card's buttons back), and the session card as the window. The assembly implements them with the note
 * view and the window view; everything else is built in `cards.ts`.
 */
import type { Lang } from "../locales/lang.js";
import type { OutMessage } from "../ports/surface.js";
import type { PermissionOption } from "../remote-view/options.js";
import type { StatusInput } from "../remote-view/status-view.js";
import type { WindowView } from "./window/view.js";

/** An approval the session card offers as buttons. */
export interface WindowApproval {
  readonly actionId: string;
  readonly tool: string;
  readonly expiresAt: number;
  readonly options: readonly PermissionOption[];
}

export interface WindowInput extends StatusInput {
  readonly view: WindowView;
  readonly approvals: readonly WindowApproval[];
  /** The person's time zone (IANA). */
  readonly zone: string;
  /** A group chat bound to a session (its approvals go to the binder's 1:1 chat). */
  readonly group: boolean;
}

export interface RemoteViews {
  /** A short note that replaces a tapped card (under `title` when there is one). */
  note(text: string, title?: string): OutMessage;
  /** The permission card's buttons again under `text`, titled with the request. */
  reopened(
    options: readonly PermissionOption[],
    sessionId: string,
    actionId: string,
    title: string,
    text: string,
    lang: Lang,
  ): OutMessage;
  /** The disconnect buttons again under `text`. */
  disconnectAgain(text: string, connectorId: string, title: string, lang: Lang): OutMessage;
  /** The session card; `takesInput`: it has the text box. */
  window(input: WindowInput): { readonly message: OutMessage; readonly takesInput: boolean };
}
