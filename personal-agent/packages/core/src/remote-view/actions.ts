// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The buttons of the remote-agent cards, as what they do: an operation (`op`) and the fields it carries. The data a button
 * carries is wire format (it comes back with the click): `{primusclaw: "remote", op, ...fields}`, which the worker checks against
 * Claw's own lists, never trusting the card. The channel decides how a button looks.
 */

/** What the agents card, the sessions card, the status card and their follow-ups do. */
export type RemoteOp =
  | "new"
  | "list"
  | "attach"
  | "detach"
  | "close"
  | "switch"
  | "row"
  | "stop"
  | "mode"
  | "set_mode"
  | "pair"
  | "takeover";

/** A button's look: the primary act (`positive`), a primary act that stops or removes (`destructive`), or plain. */
export type ButtonStyle = "positive" | "destructive" | "default";

export type ButtonFields = Readonly<Record<string, string | number | boolean>>;

export interface RemoteButton {
  readonly title: string;
  readonly op: RemoteOp;
  /** null: no style of its own. */
  readonly style: ButtonStyle | null;
  /** In the order they go into the data. */
  readonly fields: ButtonFields;
}

export function remoteButton(
  title: string,
  op: RemoteOp,
  style: ButtonStyle | null = null,
  fields: ButtonFields = {},
): RemoteButton {
  return { title, op, style, fields };
}

/** What a button of the agents card, the action row and their follow-ups carries; `op` says which handler. */
export function remoteData(op: RemoteOp, fields: ButtonFields = {}): Record<string, string | number | boolean> {
  return { primusclaw: "remote", op, ...fields };
}

/** A button on a permission card: the option the agent offered, by its own id. */
export interface DecisionButton {
  readonly title: string;
  readonly sessionId: string;
  readonly actionId: string;
  readonly optionId: string;
  /** The one primary button (allow once). */
  readonly primary: boolean;
}

/** What a decision button carries (wire format: the worker reads it back). */
export function decisionData(button: DecisionButton): Record<string, string> {
  return {
    primusclaw: "remote_decision",
    session_id: button.sessionId,
    action_id: button.actionId,
    option_id: button.optionId,
  };
}

/** What a button of the disconnect card carries (wire format). */
export function disconnectData(connectorId: string, confirm: boolean): Record<string, string | boolean> {
  return { primusclaw: "remote_off", connector_id: connectorId, confirm };
}
