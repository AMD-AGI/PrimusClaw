// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stored Teams conversation reference back as core's `ConversationRef`. The store keeps the reference exactly as the
 * Python worker wrote it (`activity.reference_of`: serviceUrl, conversation, bot, user, activityId, [channelId], [locale];
 * or the 1:1 reference made after opening a chat with someone, without an activityId); the reference stays the `wire` as
 * it is, unchanged, so it can be stored again byte for byte.
 */
import type { ConversationKind, ConversationRef, JsonObject } from "@primusclaw/personal-agent";
import { z } from "zod";

const StoredReference = z
  .object({
    serviceUrl: z.string().min(1),
    conversation: z
      .object({
        id: z.string().min(1),
        conversationType: z.string().optional(),
        tenantId: z.string().optional(),
      })
      .loose(),
  })
  .loose();

function kindOf(conversationType: string | undefined): ConversationKind {
  if (conversationType === "personal") return "personal";
  return conversationType === "groupChat" ? "group" : "channel";
}

/** The reference `stored` names; undefined when it is not one (no serviceUrl, no conversation id). Never throws. */
export function restoreConversationRef(stored: JsonObject): ConversationRef | undefined {
  const parsed = StoredReference.safeParse(stored);
  if (!parsed.success) return undefined;
  const conversation = parsed.data.conversation;
  return {
    id: conversation.id,
    kind: kindOf(conversation.conversationType),
    tenantId: conversation.tenantId ?? "",
    wire: stored,
  };
}
