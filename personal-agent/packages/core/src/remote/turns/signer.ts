// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a chat that is the agent's window itself (direct chat) signs what the agent wrote: the head of its first message and of each
 * later one, and the suggested replies under the last. A line of the agent's that would read as a head is escaped.
 */
import { agentHead, continuedHead, guardHeads, signed } from "../../direct-chat/direct-chat.js";
import type { Lang } from "../../locales/lang.js";
import type { SuggestedReply } from "../../ports/surface.js";

export class Signer {
  constructor(
    readonly label: string,
    readonly host: string,
    readonly lang: Lang,
    readonly replies: readonly SuggestedReply[] = [],
    readonly suffix = "",
  ) {}

  /** The agent's words (already masked) under its head. */
  first(text: string): string {
    return signed(agentHead(this.label, this.host) + this.suffix, guardHeads(text));
  }

  /** `parts` as messages `first`, `first`+1, ... of one answer (1: the first one has the full head). */
  later(parts: readonly string[], first = 1): string[] {
    const total = first - 1 + parts.length;
    return parts.map((part, i) => {
      const n = first + i;
      return n === 1 ? this.first(part) : signed(continuedHead(this.label, n, total, this.lang), guardHeads(part));
    });
  }
}
