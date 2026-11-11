// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The outbound trigger's pieces that hold no state: where a Bot Connector call goes, the activity it posts, and what a
 * Connector answer says. The trigger itself is Ingress.outbound.
 */
import { type ServiceUrlPolicy } from "@primusclaw/personal-agent-teams/connector-hosts";

import {
  EMPTY,
  get,
  isObject,
  type Json,
  type JsonObject,
  or,
  PyValueError,
  quote,
  rstripChars,
  str,
  strip,
  truthy,
} from "./py.js";
import { loads, plain, type PyValue } from "./py-json.js";

/**
 * The worker matches this type when it picks the activity id of a posted message out of the inbound queue (the
 * worker's DELIVERED).
 */
export const ACK_TYPE = "primusclaw.delivered";

const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A Python AttributeError: `.get()` on something that is not a dict. */
export class AttributeError extends Error {
  override name = "AttributeError";
}

/** `value.get(key)` as Python runs it: AttributeError unless `value` is a dict. */
export function dictGet(value: Json | undefined, key: string): Json | undefined {
  if (!isObject(value)) throw new AttributeError(`'${typeName(value)}' object has no attribute 'get'`);
  return get(value, key);
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (Array.isArray(value)) return "list";
  return "dict";
}

/** A fetch Response that has been read, so `.json()` can be asked twice like requests' Response. */
export interface ConnectorResponse {
  status: number;
  ok: boolean;
  text: string;
}

/** requests' `.json()`: the document, plain and as parsed; PyValueError for a body that is not JSON. */
export function responseJson(resp: ConnectorResponse): { value: Json; node: PyValue } {
  const node = loads(resp.text);
  return { value: plain(node), node };
}

/** The `error.code` of a Bot Connector refusal when it is identifier-shaped, else "-". */
export function connectorErrorCode(resp: ConnectorResponse): string {
  let error: Json | undefined;
  try {
    error = dictGet(or(responseJson(resp).value, EMPTY), "error");
  } catch (e) {
    if (e instanceof PyValueError || e instanceof AttributeError) return "-";
    throw e;
  }
  const code = isObject(error) ? get(error, "code") : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "-";
}

/** The activity to post: the envelope's, addressed from the conversation reference. */
export function withReference(activity: JsonObject, reference: JsonObject): JsonObject {
  const body: JsonObject = {};
  for (const [k, v] of Object.entries(activity)) {
    Object.defineProperty(body, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  if (!Object.hasOwn(body, "type")) body["type"] = "message";
  body["conversation"] = or(get(reference, "conversation"), EMPTY) ?? {};
  body["from"] = get(reference, "bot") ?? null;
  body["recipient"] = get(reference, "user") ?? null;
  const channelId = get(reference, "channelId");
  if (truthy(channelId) && channelId !== undefined) body["channelId"] = channelId;
  const locale = get(reference, "locale");
  if (truthy(locale) && locale !== undefined && !Object.hasOwn(body, "locale")) body["locale"] = locale;
  return body;
}

/**
 * The Bot Connector URL of one outbound operation: `send` (new activity), `reply` (into the thread of
 * `reference.activityId`) or `update` (PUT over `activityId`). The serviceUrl of an outbound envelope comes from a
 * conversation reference, and the bot's token must never go to a host that is not Microsoft's: `hosts` is the same
 * allow-list as inbound, which is the worker's rule.
 */
export function connectorUrl(
  hosts: ServiceUrlPolicy,
  reference: JsonObject,
  operation: string,
  activityId: unknown,
): string {
  const serviceUrl = rstripChars(strip(str(or(get(reference, "serviceUrl"), ""))), "/");
  const conversation = get(reference, "conversation");
  const conversationId = isObject(conversation) ? str(or(get(conversation, "id"), "")) : "";
  if (!serviceUrl || !conversationId) throw new PyValueError("conversation reference is missing serviceUrl or id");
  hosts.check(serviceUrl);
  const base = `${serviceUrl}/v3/conversations/${quote(conversationId, ":@;=")}/activities`;
  if (operation === "reply") {
    const replyTo = get(reference, "activityId");
    return truthy(replyTo) ? `${base}/${quote(str(replyTo), "")}` : base;
  }
  if (operation === "update") {
    if (!truthy(activityId)) throw new PyValueError("update needs activity_id");
    return `${base}/${quote(str(activityId), "")}`;
  }
  if (operation !== "send") throw new PyValueError(`unknown outbound operation '${operation}'`);
  return base;
}
