// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a group chat's own activities change in the recent messages the worker keeps of it (core's `GroupContext`): the
 * bot removed from the chat (`installationUpdate` remove, or the bot among `membersRemoved`) drops all of the chat's; a
 * deleted message (`messageDelete`, or a `messageUpdate` of a soft delete) is no longer shown; an edited one shows its
 * new words. None of them is answered, and none is read for anything else.
 */
import { pyStr } from "@primusclaw/personal-agent";

import { isGroup } from "./identity.js";
import { botIdOf, isFields, parseActivity, partOf, type Activity } from "./schema.js";

/** The part of core's `GroupContext` these activities change. */
export interface GroupContextChanges {
  forget(chatId: string): void;
  remove(chatId: string, messageId: string): void;
  edit(chatId: string, messageId: string, text: string): void;
}

/** The activity's `channelData.eventType` ("" when not said). */
function eventTypeOf(activity: Activity): string {
  const data = activity.channelData;
  return isFields(data) ? pyStr(data["eventType"]) : "";
}

function botRemoved(activity: Activity): boolean {
  if (activity.type === "installationUpdate") return pyStr(activity["action"]).startsWith("remove");
  if (activity.type !== "conversationUpdate") return false;
  const bot = botIdOf(activity);
  const removed: unknown = activity["membersRemoved"];
  return bot !== "" && Array.isArray(removed) && removed.some((m) => isFields(m) && m["id"] === bot);
}

/**
 * Applies a group chat's removal, delete or edit to `context`. `textOf` reads an edited message's words as a message's
 * are read (undefined: not a message from a person). True when the activity was one of these.
 */
export function applyGroupChange(
  raw: unknown,
  context: GroupContextChanges,
  textOf: (activity: Activity) => string | undefined,
): boolean {
  const parsed = parseActivity(raw);
  if (!parsed.ok || !isGroup(parsed.value)) return false;
  const activity = parsed.value;
  const chatId = pyStr(partOf(activity, "conversation")["id"]);
  const messageId = pyStr(activity.id);
  if (!chatId) return false;
  if (botRemoved(activity)) {
    context.forget(chatId);
    return true;
  }
  const event = eventTypeOf(activity);
  if (activity.type === "messageDelete" || (activity.type === "messageUpdate" && event === "softDeleteMessage")) {
    context.remove(chatId, messageId);
    return true;
  }
  if (activity.type !== "messageUpdate" || event !== "editMessage") return false;
  const text = textOf(activity);
  if (text === undefined) context.remove(chatId, messageId);
  else context.edit(chatId, messageId, text);
  return true;
}
