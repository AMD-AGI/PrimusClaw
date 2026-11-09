// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the review service talks: every line it sends is masked for credential shapes (a group, and a reviewer's own chat,
 * get what a group gets), and a person's 1:1 chat is the one the store knows or one the channel opens.
 */

import { errorName } from "../../errors.js";
import { type Conversation, type ConversationRef, type OutMessage, textMessage } from "../../ports/surface.js";
import type { ReviewDeps } from "./deps.js";

export async function say(deps: ReviewDeps, conversation: Conversation, text: string): Promise<void> {
  await conversation.send(textMessage(deps.mask(text)));
}

/** `say`, logging instead of failing: for a line that must not end the flow that sends it. */
export async function sayQuietly(
  deps: ReviewDeps,
  conversation: Conversation,
  text: string,
  what: string,
): Promise<boolean> {
  try {
    await say(deps, conversation, text);
    return true;
  } catch (err) {
    deps.logger.warn("a review message could not be sent", { what, error: errorName(err) });
    return false;
  }
}

export async function send(conversation: Conversation, message: OutMessage): Promise<void> {
  await conversation.send(message);
}

/** The conversation a stored reference points at, or undefined when it cannot be read. */
export function stored(deps: ReviewDeps, reference: unknown): Conversation | undefined {
  if (typeof reference !== "object" || reference === null || Array.isArray(reference)) return undefined;
  const ref = deps.restoreRef(reference as never);
  return ref === undefined ? undefined : deps.surface.conversation(ref);
}

/** Who a person is, to reach their own chat. */
export interface Reachable {
  readonly userId: string;
  readonly channelUserId: string;
}

/**
 * A conversation into this person's 1:1 chat with the bot: the one the store knows, else one the channel opens through
 * `via` (a conversation both are in). undefined when neither works.
 */
export async function personalChat(
  deps: ReviewDeps,
  person: Reachable,
  via: ConversationRef | undefined,
): Promise<Conversation | undefined> {
  const known = deps.store.references.getReference(person.userId);
  const conversation = known === null ? undefined : stored(deps, known);
  if (conversation !== undefined) return conversation;
  if (via === undefined || !person.channelUserId) return undefined;
  try {
    return await deps.surface.openPersonal(via, person);
  } catch (err) {
    deps.logger.warn("a 1:1 chat with a person a review needs could not be opened", { error: errorName(err) });
    return undefined;
  }
}
