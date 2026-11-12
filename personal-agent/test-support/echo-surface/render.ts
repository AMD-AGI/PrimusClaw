// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Core's `OutMessage` drawn as an echo message: text and rich bodies as their words, a view by its own renderer when the
 * echo app draws views (`caps.views`) and there is one, and its `fallbackText` otherwise. A button carries core's click
 * protocol as it is: the `primusclaw` field names the handler, and what a press sends back is the button's data with the
 * picked options beside it.
 *
 * Only the views the conformance kit presses are drawn here; a real surface draws every view core declares (`ViewMap`; the
 * Teams package's `Renderers` type makes a missing one a compile error).
 */
import {
  pyStr,
  type JsonObject,
  type OutMessage,
  type SurfaceCaps,
  type View,
  type ViewButton,
} from "@primusclaw/personal-agent";

import type { EchoButton, EchoMessage } from "./wire.js";

/** The verb and the input id of a choice card's Send (core's `assistant_choice` handler reads them). */
export const CHOICE_VERB = "assistant_choice";
export const CHOICE_INPUT = "choice";

type Drawn = Omit<EchoMessage, "mentions">;

function button(b: ViewButton): EchoButton {
  return "url" in b ? { title: b.title, url: b.url } : { title: b.title, data: { ...b.data, primusclaw: b.verb } };
}

function objectOf(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** Approve and Deny of one approval: core's `decision` handler reads these fields. */
function decisionButtons(event: JsonObject): EchoButton[] {
  const approval = objectOf(event["approval"]);
  const data = (action: string) => ({
    primusclaw: "decision",
    session_id: pyStr(event["session_id"]),
    tool: pyStr(approval["tool"]),
    tool_use_id: pyStr(approval["tool_use_id"]),
    action,
  });
  return [
    { title: "Approve", data: data("allow") },
    { title: "Deny", data: data("deny") },
  ];
}

/** The views the echo app draws itself; undefined: show the view's fallback text. */
function drawView(view: View): Drawn | undefined {
  switch (view.name) {
    case "note":
      return { text: view.model.text, buttons: (view.model.buttons ?? []).map(button) };
    case "choiceCard":
      return {
        text: view.model.text,
        buttons: [{ title: "Send", data: { primusclaw: CHOICE_VERB, card: view.model.cardId } }],
        choices: {
          id: CHOICE_INPUT,
          multiple: view.model.multiple,
          options: view.model.options.map((title, i) => ({ title, value: String(i) })),
        },
      };
    case "choiceChosen":
      return { text: `Sent: ${view.model.chosen.join(", ")}`, buttons: [] };
    case "proactiveApproval":
    case "itemApproval": {
      const approval = objectOf(view.model.event["approval"]);
      return {
        text: `Approval needed: ${pyStr(approval["tool"]) || "an action"} ${pyStr(approval["target"])}`.trim(),
        buttons: decisionButtons(view.model.event),
      };
    }
    case "approvalDecided":
      return { text: `${view.model.action === "allow" ? "Approved" : "Denied"}: ${view.model.tool}`, buttons: [] };
    case "runEvent":
      return {
        text: [pyStr(view.model.event["title"]), pyStr(view.model.event["summary"])].filter(Boolean).join("\n"),
        buttons: [],
      };
    default:
      return undefined;
  }
}

/** `message` as the echo app shows it on a surface with `caps`. */
export function render(message: OutMessage, caps: SurfaceCaps): EchoMessage {
  const mentions = (message.mentions ?? []).map((m) => m.channelUserId);
  const body = message.body;
  if (body.type === "text") return { text: body.text, buttons: [], mentions };
  if (body.type === "rich") return { text: body.markdown, buttons: [], mentions };
  const drawn = caps.views ? drawView(body.view) : undefined;
  return drawn === undefined ? { text: body.fallbackText, buttons: [], mentions } : { ...drawn, mentions };
}
