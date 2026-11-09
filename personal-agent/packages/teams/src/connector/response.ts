// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the Bot Connector's answers are read for: the `id` of a posted activity (or created conversation), the error
 * code of a refusal (never its message), a member list, and a Retry-After header in seconds.
 */
import { z } from "zod";
import { cpHead, pyStr } from "@primusclaw/personal-agent";
import { isObject, type JsonObject } from "../cards/json.js";
import { pyFloat } from "./py-parse.js";

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // not JSON: the answer has nothing to read, which each caller treats as "none"
  }
}

const WithId = z.object({ id: z.unknown().optional() });
const WithError = z.object({ error: z.object({ code: z.unknown().optional() }) });

/** The `id` of an answer, or undefined when it has none. */
export function answerId(text: string): string | undefined {
  const parsed = WithId.safeParse(json(text));
  return parsed.success ? pyStr(parsed.data.id) || undefined : undefined;
}

/** The Connector's error code (for example BotNotInConversationRoster), at most 60 characters; "" when there is none. */
export function errorCode(text: string): string {
  const parsed = WithError.safeParse(json(text));
  return parsed.success ? cpHead(pyStr(parsed.data.error.code), 60) : "";
}

/** A Retry-After in milliseconds; undefined for none, an HTTP date or junk (the backoff then applies). */
export function retryAfterMs(header: string | null): number | undefined {
  const seconds = pyFloat(header ?? "");
  return seconds !== undefined && seconds >= 0 ? seconds * 1000 : undefined;
}

/** The member objects of a member list answer; undefined when it is not JSON. */
export function memberList(text: string): JsonObject[] | undefined {
  const parsed = json(text);
  if (parsed === undefined) return undefined;
  return Array.isArray(parsed) ? parsed.filter(isObject) : [];
}
