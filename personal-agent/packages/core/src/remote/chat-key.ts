// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A group chat's binding to a session is its own chat state, kept apart from the person's 1:1 chat: every per-chat record of
 * remote agents (the attached session, its status card, the reader that follows it) is keyed by a "chat key", the binder's user
 * id and the group conversation. Only the binder's own messages in that group read it, so another member's words never reach
 * the session. A 1:1 chat's key is the person's id itself. The stored keys keep this exact shape (`remote_state.aad_id`).
 */

/** Joins the binder and the group conversation (a user id is a GUID: it never holds one). */
export const GROUP_KEY_SEP = "#";

/** The chat key of `userId`'s binding in the group conversation `conversationId`. */
export function groupChatKey(userId: string, conversationId: string): string {
  return `${userId}${GROUP_KEY_SEP}${conversationId}`;
}

/** The person a chat key belongs to: the key itself for a 1:1 chat, the binder for a group's. */
export function personOf(chatKey: string): string {
  const at = chatKey.indexOf(GROUP_KEY_SEP);
  return at < 0 ? chatKey : chatKey.slice(0, at);
}

export function isGroupKey(chatKey: string): boolean {
  return chatKey.includes(GROUP_KEY_SEP);
}
