// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The views a turn shows besides its text: a delivered file, and what the session changed. */

import type { OutMessage } from "../ports/surface.js";
import type { Changes } from "./changes.js";
import type { Delivery } from "./deliveries.js";

/** A file the agent delivered, in a 1:1 chat: its name, size, caption, a small image, and Download. */
export interface DeliveryModel {
  readonly delivery: Delivery;
  readonly url: string;
}

/** What the session changed, under a finished answer: Create PR and Open diff in Claw. */
export interface ChangesModel {
  readonly changes: Changes;
  readonly sessionId: string;
  readonly publicBaseUrl: string;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    delivery: DeliveryModel;
    changes: ChangesModel;
  }
}

/** A message that is one view, with the text a client that cannot draw it shows. */
export function viewMessage<K extends keyof import("../ports/surface.js").ViewMap>(
  name: K,
  model: import("../ports/surface.js").ViewMap[K],
  fallbackText: string,
): OutMessage {
  return { body: { type: "view", view: { name, model } as import("../ports/surface.js").View, fallbackText } };
}
