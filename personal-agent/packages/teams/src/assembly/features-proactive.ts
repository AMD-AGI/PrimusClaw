// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unasked messages (Python `proactive.Proactive`, as `link_api.build_app` and `Agent.__init__` build it): what Claw's events
 * become in the chat, what quiet hours and /pause hold and later release, approval cards sent again, and the two views of it
 * the router and the remote agents read (`ProactiveHold`, `FollowReach`).
 */
import type {
  Conversation,
  ConversationRef,
  FollowReach,
  JsonObject,
  ProactiveHold,
  PublicErrors,
  Router,
  RunFollowUps,
} from "@primusclaw/personal-agent";
import {
  clientLocaleOf,
  errorName,
  fetchChanges,
  looksInternal,
  looksLikeServiceError,
  Proactive,
  publicRunEvent,
  Release,
  remoteDomain,
  SaidMessages,
  SayPlanner,
  turn,
} from "@primusclaw/personal-agent";

import { restoreConversationRef } from "../activity/reference.js";
import { isObject } from "../cards/json.js";
import type { Style } from "../config/style.js";
import type { AssistantParts } from "./features-assistant.js";
import { isExactCommand, remoteAskCard } from "./features-assistant.js";
import type { AssemblyBase } from "./features-base.js";

/** A stored reference as the surface posts to it; one that names no conversation still gets one (its send then fails). */
export function refOf(reference: JsonObject): ConversationRef {
  const restored = restoreConversationRef(reference);
  if (restored !== undefined) return restored;
  const conversation = reference["conversation"];
  const type = isObject(conversation) ? conversation["conversationType"] : undefined;
  return { id: "", kind: type === "groupChat" ? "group" : "personal", tenantId: "", wire: reference };
}

export function conversationFor(base: Pick<AssemblyBase, "surface">): (reference: JsonObject) => Conversation {
  return (reference) => base.surface.conversation(refOf(reference));
}

/** A finished run's answer lost to a restart, and the card of what its session changed (W4b's reads). */
function runFollowUps(base: AssemblyBase, errors: PublicErrors): RunFollowUps {
  const { claw, clock, logger, settings } = base;
  return {
    async lostAnswer(key, sessionId, lead) {
      const answer = await turn.lastAnswer({ claw: claw.sessions, clock, log: logger, errors }, key, sessionId);
      if (answer === undefined) return undefined;
      return turn.answerParts(answer, turn.deepLink(settings.publicBaseUrl, sessionId), false, lead);
    },
    async offerChanges(key, sessionId, conversation) {
      try {
        const changes = await fetchChanges(claw.sessions, key, sessionId, logger);
        if (changes === undefined) return;
        const model = { changes, sessionId, publicBaseUrl: settings.publicBaseUrl };
        await conversation.send(turn.viewMessage("changes", model, "Changes"));
      } catch (error) {
        logger.warn("the changes card of a finished run could not be shown", { error: errorName(error) });
      }
    },
  };
}

export interface ProactiveParts {
  readonly proactive: Proactive;
  readonly release: Release;
}

export function proactiveParts(
  base: AssemblyBase,
  style: Style,
  assistant: Pick<AssistantParts, "receipts" | "directChat">,
  errors: PublicErrors,
  router?: () => Router,
): ProactiveParts {
  const { store, claw, surface, settings } = base;
  const deps = {
    store,
    conversationFor: conversationFor(base),
    deliverStored: (envelope: JsonObject) =>
      surface.conversation(refOf((envelope["reference"] ?? {}) as JsonObject)).deliver(envelope),
    messageIds: surface.caps.messageIds,
    say: new SayPlanner({
      store,
      exactCommand: isExactCommand,
      style: () => ({ citations: style.citations, suggestedReplies: style.suggestedReplies }),
      clientLocale: () => clientLocaleOf(base.requestScope),
    }),
    receipts: assistant.receipts,
    directChat: assistant.directChat,
    said: new SaidMessages(),
    deliveryLink: (sessionId: string, deliveryId: string) => claw.sessions.deliveryLink(sessionId, deliveryId),
    claw: claw.workItems,
    remote: {
      options: (raw: unknown): readonly unknown[] => remoteDomain.parseOptions(raw),
      askCard: remoteAskCard,
      saidParts: (label: string, text: string) => remoteDomain.unsolicitedParts(label, text),
    },
    runs: runFollowUps(base, errors),
    publicBaseUrl: settings.publicBaseUrl,
    replyWindowSeconds: settings.assistant.replyWindowSeconds,
    clock: base.clock,
    logger: base.logger,
    publicEvent: (event: JsonObject) =>
      publicRunEvent(event, errors, (text) => looksLikeServiceError(text) || looksInternal(text)),
    botName: "Clawy",
    ...(router === undefined ? {} : { identityAfterRefusal: identityAfterRefusal(base, router) }),
  };
  // (`showsAttached` stays false: the Python worker's /claw-events path runs its own Proactive, on which it is never set)
  const proactive = new Proactive(deps);
  return { proactive, release: new Release(deps, proactive) };
}

/**
 * The card that confirms a person's identity after an assistant message refused for want of it (`needs_identity`), in their own
 * chat: at most once per person in 24 hours and none once they confirmed (`Credentials.identityAfterRefusal`), and never twice
 * for one turn (an event claim per person and turn, so a later say of the same turn, the same event delivered again, or two
 * says of one turn delivered at once, send none).
 */
function identityAfterRefusal(
  base: Pick<AssemblyBase, "store" | "logger">,
  router: () => Router,
): (userId: string, conversation: Conversation, turn: string) => Promise<void> {
  return async (userId, conversation, turn) => {
    const { store } = base;
    const once = `${IDENTITY_REFUSED_PREFIX}${userId}:${turn}`;
    if (!turn) return;
    // (claimed before the card is asked for, so two says of one turn delivered at once send one card; released when none was
    // sent, so a later say of the turn may still offer it)
    const claim = store.idempotency.claimEvent(once);
    if (claim.state !== "claimed") return;
    let sent = false;
    try {
      const person = {
        id: userId,
        channelUserId: store.members.channelIdOf(userId) ?? "",
        name: store.members.memberName(userId) ?? "",
        email: "",
      };
      const r = router();
      sent = await r.ctx.credentials.identityAfterRefusal(r.chat(person, conversation));
    } finally {
      if (sent) store.idempotency.finishEvent(once);
      else store.idempotency.releaseEvent(once, claim.holder);
    }
  };
}

/** The event claim key prefix of a turn whose identity card was sent (`identityAfterRefusal`). */
export const IDENTITY_REFUSED_PREFIX = "identity-refused:";

/** What the router reads of quiet hours and /pause (`muted` as a word or null, `release` on /resume). */
export function proactiveHold(parts: ProactiveParts): ProactiveHold {
  return {
    muted: (userId) => parts.proactive.muted(userId) ?? null,
    release: (userId) => parts.release.release(userId),
  };
}

/**
 * What the remote agents' follower reads of it. Python's follower hands Proactive its chat key as the person (`self.aad_id`
 * is the chat key: the person for a 1:1 chat, `<person>#<group>` for a group binding), so the same key is passed on here
 * unchanged; the event id of a held message is a fresh uuid4 hex, as Python's `hold_remote` makes it.
 */
export function followReach(parts: ProactiveParts, base: Pick<AssemblyBase, "random">): FollowReach {
  return {
    reachable: (chatKey) => parts.proactive.reachable(chatKey),
    muted: (chatKey) => parts.proactive.muted(chatKey) ?? null,
    holdRemote: (chatKey, label, text) => {
      parts.proactive.holdRemote(chatKey, label, text, base.random.hexId());
    },
  };
}
