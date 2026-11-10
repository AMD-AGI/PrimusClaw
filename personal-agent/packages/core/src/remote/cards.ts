// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A view as a message to post. */
import type { OutMessage, View } from "../ports/surface.js";

/** A view as a message; `fallback` is what a client that cannot show it shows. */
export function viewMessage(view: View, fallback: string): OutMessage {
  return { body: { type: "view", view, fallbackText: fallback } };
}
