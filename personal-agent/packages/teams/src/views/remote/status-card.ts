// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The status card of a chat attached to a remote session, as an Adaptive Card. */
import type { remoteView } from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import { type CardMessage, header, message, text } from "../../cards/kit.js";
import { block, remoteAction, warningNote } from "./elements.js";

function line(item: remoteView.StatusLine): CardElement {
  switch (item.kind) {
    case "lead":
      return block(item.text);
    case "where":
      return block(item.text, { size: "Small", spacing: "None" });
    case "phase":
      return block(item.text, { spacing: "Small" });
    case "unattended":
      return warningNote(item.text, (value) => text(value, { size: "Small" }));
    case "assistant":
      return block(item.text, { isSubtle: true, size: "Small", spacing: "Small" });
    case "lastSession":
    case "folder":
    case "updated":
      return block(item.text, { isSubtle: true, size: "Small", spacing: "None" });
  }
}

/** The status card: the lead (when there is one) above the header, then its lines, then the system operations. */
export function statusCard(view: remoteView.StatusView): CardMessage {
  const top = header(view.title, { tone: view.tone, emoji: "connect" });
  const lines = view.lines.map(line);
  const lead = view.lines[0]?.kind === "lead" ? lines.splice(0, 1) : [];
  return message([...lead, top, ...lines], view.buttons.map(remoteAction), view.buttonsMax);
}
