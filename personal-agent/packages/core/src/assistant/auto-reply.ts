// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Before a card shows automatic replies as on, Claw is asked whether the item still has a watch that answers unasked (the chat can
 * turn it off, and the item's end ends it), and it is forgotten here when not (teams_agent/assistant.py `refresh_auto_reply`).
 * Nothing is asked for an item this worker never turned it on for; when Claw cannot be read, what was recorded stands.
 */
import { errorName } from "../errors.js";
import type { ClawWorkItemsPort } from "../ports/claw/index.js";
import type { Logger } from "../ports/logger.js";
import type { AssistantCardRepository } from "../ports/store/index.js";
import { onlyClawFailures } from "./failures.js";

/** A watch Claw lists that still answers new comments unasked. */
export function answersUnasked(watch: Readonly<Record<string, unknown>>): boolean {
  return watch["state"] === "active" && watch["reply_allowed"] === true;
}

export async function refreshAutoReply(
  deps: {
    readonly cards: Pick<AssistantCardRepository, "autoReply" | "clearAutoReply">;
    readonly claw: Pick<ClawWorkItemsPort, "watches"> | undefined;
    readonly logger: Logger;
  },
  call: { readonly userId: string; readonly itemId: string; readonly key: string | null },
): Promise<void> {
  if (!call.key || deps.claw === undefined || deps.cards.autoReply(call.userId, call.itemId) === null) return;
  let watches: readonly Readonly<Record<string, unknown>>[];
  try {
    watches = await deps.claw.watches(call.key, call.itemId);
  } catch (error) {
    onlyClawFailures(error);
    deps.logger.info("could not read whether auto-reply is still on", { error: errorName(error) });
    return;
  }
  if (!watches.some(answersUnasked)) deps.cards.clearAutoReply(call.userId, call.itemId);
}
