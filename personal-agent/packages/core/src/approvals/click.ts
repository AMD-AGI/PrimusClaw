// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What a card press handler of this feature reads of the router's click (W4's `ClickRoute`). */
import type { ClickRoute } from "../ports/routing.js";
import type { OutMessage, View } from "../ports/surface.js";

export type CardClick = Pick<ClickRoute, "sender" | "conversation" | "scope" | "lang" | "settle"> & {
  readonly action: Pick<ClickRoute["action"], "data">;
};

/** A view as a message, with the line a client that cannot show it shows. */
export function viewMessage(view: View, fallbackText = ""): OutMessage {
  return { body: { type: "view", view, fallbackText } };
}
