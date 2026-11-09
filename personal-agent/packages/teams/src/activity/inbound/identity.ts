// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who sent an activity, from which client, and where: the sender's directory identity, the tenant, the Teams client
 * platform, and the kind and id of the conversation (the Python worker's `sender_of`, `tenant_of`, `client_platform`,
 * `is_mobile`, `is_personal`, `is_group`, `conversation_id`).
 */
import type { ConversationKind } from "@primusclaw/personal-agent";
import { cpHead, pyStr, pyStrip } from "@primusclaw/personal-agent";
import { entitiesOf, isFields, partOf, type Activity } from "./schema.js";

/** The Teams user behind an activity. */
export interface Sender {
  /** The Entra object id. */
  readonly aadId: string;
  readonly name: string;
  /** Only when the channel supplies it (never looked up); "" otherwise. */
  readonly email: string;
}

/** The Teams user behind an activity, or undefined when it carries no Entra identity. */
export function senderOf(activity: Activity): Sender | undefined {
  const who = partOf(activity, "from");
  const aadId = who["aadObjectId"];
  if (typeof aadId !== "string" || !aadId) return undefined;
  const email = pyStrip(pyStr(who["userPrincipalName"]) || pyStr(who["email"]));
  return { aadId, name: pyStr(who["name"]), email: email.includes("@") ? email : "" };
}

function conversationType(activity: Activity): unknown {
  return partOf(activity, "conversation")["conversationType"];
}

export function isPersonal(activity: Activity): boolean {
  return conversationType(activity) === "personal";
}

export function isGroup(activity: Activity): boolean {
  return conversationType(activity) === "groupChat";
}

/**
 * The kind of the conversation for core: a 1:1 chat, a group chat, or anything else (a team's channel, or a
 * conversation that does not say), which the worker does not serve.
 */
export function conversationKind(activity: Activity): ConversationKind {
  if (isPersonal(activity)) return "personal";
  return isGroup(activity) ? "group" : "channel";
}

export function conversationId(activity: Activity): string {
  return pyStr(partOf(activity, "conversation")["id"]);
}

/** The Microsoft Entra tenant the conversation belongs to (a 1:1 conversation with a member needs it). */
export function tenantOf(activity: Activity): string {
  const channelData = activity.channelData;
  const tenant = isFields(channelData) ? channelData["tenant"] : undefined;
  const fromChannel = isFields(tenant) ? tenant["id"] : undefined;
  return pyStr(partOf(activity, "conversation")["tenantId"]) || pyStr(fromChannel);
}

/** What Teams' clientInfo says on a phone or a tablet (lower case). */
export const MOBILE_PLATFORMS: readonly string[] = ["ios", "ipados", "android"];

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * The Teams client the person wrote from, as the activity's first `clientInfo` entity says it ("Windows", "Mac", "Web",
 * "iOS", "Android"); "" when it carries none. Letters and digits only, at most 16: it comes from the client.
 */
export function clientPlatform(activity: Activity): string {
  const info = entitiesOf(activity).find((entity) => entity["type"] === "clientInfo");
  const platform = info?.["platform"];
  if (typeof platform !== "string") return "";
  return cpHead(
    Array.from(platform)
      .filter((ch) => ALNUM.test(ch))
      .join(""),
    16,
  );
}

/** Teams on a phone or a tablet (its own thumbs under a bot's answer never reach the bot). */
export function isMobile(platform: string): boolean {
  return MOBILE_PLATFORMS.includes(platform.toLowerCase());
}
