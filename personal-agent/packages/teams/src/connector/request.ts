// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Bot Connector call for one outbound envelope (the same mapping the relay Function applies), for creating a 1:1
 * conversation and for listing a chat's members. Every address is checked by the injected `ServiceUrlPolicy` first: the
 * bot's token is never sent anywhere else.
 */
import { pyStr, pyStrip } from "@primusclaw/personal-agent";
import { isObject, type Json, type JsonObject } from "../cards/json.js";
import { UnaddressableError } from "./errors.js";
import { DEFAULT_CONNECTOR_HOSTS, type ServiceUrlPolicy } from "./hosts.js";
import { pyQuote, pyTruthy, rstripSlash } from "./py-parse.js";

export interface ConnectorRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly url: string;
  /** undefined: the request has no body (a delete, a read). */
  readonly payload: JsonObject | undefined;
}

/** A conversation id in a path: "/", "?" and "#" are data; ":", "@", ";" and "=" stay (threads are `...;messageid=1`). */
const CONVERSATION_SAFE = ":@;=";

function quote(text: string, safe: string): string {
  try {
    return pyQuote(text, safe);
  } catch (error) {
    throw new UnaddressableError("an id in the address is not valid Unicode", { cause: error });
  }
}

function conversationUrl(serviceUrl: string, conversationId: string): string {
  return `${rstripSlash(serviceUrl)}/v3/conversations/${quote(conversationId, CONVERSATION_SAFE)}`;
}

/** `str(value)` of an id that was checked to be truthy. */
function idText(value: Json | undefined): string {
  return quote(pyStr(value), "");
}

interface Addressed {
  readonly reference: JsonObject;
  readonly activity: JsonObject;
  readonly conversation: JsonObject;
  readonly url: string;
}

function address(envelope: JsonObject, policy: ServiceUrlPolicy): Addressed {
  const { reference, activity } = envelope;
  if (!isObject(reference) || !isObject(activity)) {
    throw new UnaddressableError("an outbound envelope needs a reference and an activity");
  }
  const serviceUrl = pyStrip(pyStr(reference["serviceUrl"]));
  const raw = reference["conversation"];
  const conversation: Json = pyTruthy(raw) && raw !== undefined ? raw : {};
  const conversationId = isObject(conversation) ? pyStr(conversation["id"]) : "";
  if (!serviceUrl || !conversationId || !isObject(conversation)) {
    throw new UnaddressableError("the conversation reference has no serviceUrl or conversation id");
  }
  policy.check(serviceUrl);
  return { reference, activity, conversation, url: `${conversationUrl(serviceUrl, conversationId)}/activities` };
}

/** The activity Teams is sent: the envelope's activity addressed from the reference. */
function payloadOf(at: Addressed, operation: string, activityId: Json | undefined): JsonObject {
  const { reference } = at;
  const payload: JsonObject = { ...at.activity };
  if (payload["type"] === undefined) payload["type"] = "message";
  payload["conversation"] = at.conversation;
  payload["from"] = reference["bot"] ?? null;
  payload["recipient"] = reference["user"] ?? null;
  if (pyTruthy(reference["channelId"])) payload["channelId"] = reference["channelId"] ?? null;
  if (pyTruthy(reference["locale"]) && payload["locale"] === undefined) payload["locale"] = reference["locale"] ?? null;
  if (operation === "update") payload["id"] = activityId ?? null;
  return payload;
}

/**
 * The Connector call for one outbox envelope. `send` posts a new activity, `reply` posts into the thread of the
 * reference's activity, `update` replaces the activity `activity_id`, `delete` removes it (no body). Throws
 * UnaddressableError for an envelope that cannot be addressed or a serviceUrl the policy refuses.
 */
export function buildRequest(
  envelope: JsonObject,
  policy: ServiceUrlPolicy = DEFAULT_CONNECTOR_HOSTS,
): ConnectorRequest {
  const operation = (pyStr(envelope["operation"]) || "send").toLowerCase();
  const at = address(envelope, policy);
  const activityId = envelope["activity_id"];
  switch (operation) {
    case "send":
      return { method: "POST", url: at.url, payload: payloadOf(at, operation, activityId) };
    case "reply": {
      const replyTo = at.reference["activityId"];
      const url = pyTruthy(replyTo) ? `${at.url}/${idText(replyTo)}` : at.url;
      return { method: "POST", url, payload: payloadOf(at, operation, activityId) };
    }
    case "update":
      if (!pyTruthy(activityId)) throw new UnaddressableError("an update needs the activity id");
      return { method: "PUT", url: `${at.url}/${idText(activityId)}`, payload: payloadOf(at, operation, activityId) };
    case "delete":
      if (!pyTruthy(activityId)) throw new UnaddressableError("a delete needs the activity id");
      return { method: "DELETE", url: `${at.url}/${idText(activityId)}`, payload: undefined };
    default:
      throw new UnaddressableError(`unknown outbound operation ${JSON.stringify(operation)}`);
  }
}

/**
 * The Connector call that creates (or returns) the bot's 1:1 conversation with one user: POST {serviceUrl}/v3/conversations
 * with the user as the only member. The answer's `id` is the conversation to post into.
 */
export function buildCreateConversation(
  serviceUrl: string,
  userId: string,
  tenantId: string,
  botId: string,
  policy: ServiceUrlPolicy = DEFAULT_CONNECTOR_HOSTS,
): ConnectorRequest {
  if (!(serviceUrl && userId && tenantId && botId)) {
    throw new UnaddressableError("creating a 1:1 conversation needs the serviceUrl, the user, the tenant and the bot");
  }
  policy.check(serviceUrl);
  return {
    method: "POST",
    url: `${rstripSlash(serviceUrl)}/v3/conversations`,
    payload: { isGroup: false, bot: { id: botId }, members: [{ id: userId }], tenantId },
  };
}

/** GET {serviceUrl}/v3/conversations/{id}/members. */
export function buildListMembers(
  serviceUrl: string,
  conversationId: string,
  policy: ServiceUrlPolicy = DEFAULT_CONNECTOR_HOSTS,
): ConnectorRequest {
  if (!(serviceUrl && conversationId)) {
    throw new UnaddressableError("listing members needs the serviceUrl and the conversation");
  }
  policy.check(serviceUrl);
  return { method: "GET", url: `${conversationUrl(serviceUrl, conversationId)}/members`, payload: undefined };
}
