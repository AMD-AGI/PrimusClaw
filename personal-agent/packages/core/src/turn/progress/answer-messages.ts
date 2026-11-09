// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { OutMessage, SuggestedReply, UserRef } from "../../ports/surface.js";

export interface FinishOptions {
  /** The parts are an answer: rich text with the markdown converted (the live edits stay plain markdown). */
  readonly rich?: boolean;
  /** The chat's thumbs go under the LAST part, and nowhere else. */
  readonly feedback?: boolean;
  /** The asker of a review in a group: their answer @mentions them, and only them. */
  readonly mention?: UserRef | undefined;
  /** What the agent wrote: the chat's AI label. */
  readonly ai?: boolean;
  /** Suggested replies under the last part. */
  readonly replies?: readonly SuggestedReply[] | undefined;
}

/** A plain markdown message. */
export function plainMessage(text: string, ai = false): OutMessage {
  return { body: { type: "text", text }, ...(ai ? { aiGenerated: true } : {}) };
}

/** What a finished message's text is, whatever its body. */
export function textOfMessage(message: OutMessage): string {
  const body = message.body;
  return body.type === "text" ? body.text : body.type === "rich" ? body.markdown : body.fallbackText;
}

/**
 * The messages that carry `parts`: each rich or markdown and, for an agent's answer, labelled as AI. Its links stay links
 * and never become citations: an address the model wrote is not a source.
 */
export function answerMessages(parts: readonly string[], options: FinishOptions): OutMessage[] {
  const last = parts.length - 1;
  return parts.map((text, n) => ({
    body: options.rich ? { type: "rich", markdown: text, lead: n === 0 } : { type: "text", text },
    ...(options.ai ? { aiGenerated: true } : {}),
    ...(n === last && options.feedback ? { feedback: true } : {}),
    ...(n === last && options.replies?.length ? { suggestions: options.replies } : {}),
    ...(n === 0 && options.mention ? { mentions: [options.mention] } : {}),
  }));
}
