// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Core's view buttons as the card kit's actions: one that comes back to the worker (Action.Execute) or opens a link. */
import type { ViewButton } from "@primusclaw/personal-agent";

import type { CardElement, JsonObject } from "./json.js";
import { execute, openUrl } from "./kit.js";

export function viewButton(button: ViewButton): CardElement {
  const action =
    "url" in button
      ? openUrl(button.title, button.url)
      : execute(button.title, button.verb, { ...button.data } as JsonObject);
  return button.style ? { ...action, style: button.style } : action;
}
