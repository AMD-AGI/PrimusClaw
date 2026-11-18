// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the messaging endpoint answers: the status, the exact body bytes and the Content-Type the Python one sent. */
import { dumps } from "./py-json.js";

export interface Reply {
  status: number;
  body: Buffer;
  contentType: string;
}

// What Teams shows in place of a clicked card until the worker replaces it. Teams on a phone does not redraw the edit,
// so this card can stay for good: it is static (a ring would spin forever) and promises only the message the worker
// posts for the click, not that this card changes.
export const PLACEHOLDER_CARD = {
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.5",
  body: [{ type: "TextBlock", text: "Got it — the result appears below.", wrap: true }],
};

export const UNAVAILABLE_CARD = {
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.5",
  body: [
    {
      type: "TextBlock",
      text: "The agent is temporarily unavailable. Please try again shortly.",
      wrap: true,
      color: "Attention",
    },
  ],
};

const EMPTY_TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json";

export function empty(status: number): Reply {
  return { status, body: Buffer.alloc(0), contentType: EMPTY_TEXT };
}

export function jsonReply(body: unknown): Reply {
  return { status: 200, body: Buffer.from(dumps(body), "utf8"), contentType: JSON_TYPE };
}

export function cardResponse(card: unknown): Reply {
  return jsonReply({ statusCode: 200, type: "application/vnd.microsoft.card.adaptive", value: card });
}

/** The empty answer to an invoke that cannot be deferred (Teams is holding a spinner). */
export const EMPTY_INVOKE_RESULT = { composeExtension: { type: "result", attachments: [] } };
