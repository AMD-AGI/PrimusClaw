// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The inbound Bot Framework activity as the readers in this directory see it: a loose zod schema (every field the
 * worker reads, and every other field kept as it came) and the small accessors the readers share.
 *
 * The schema is as tolerant as the Python worker's `activity.get(...) or {}` reads: a field may be missing or null, an
 * entity or an attachment that is not an object is skipped by each reader. What the Python worker could not read at all
 * (a `from` that is a string, `entities` that is not a list: it raised) is refused here as invalid input.
 */
import { parseInput, pyStr, type InvalidInput, type Result } from "@primusclaw/personal-agent";
import { z } from "zod";

const party = z.looseObject({}).nullish();

export const activitySchema = z.looseObject({
  type: z.unknown().optional(),
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  text: z.unknown().optional(),
  serviceUrl: z.unknown().optional(),
  channelId: z.unknown().optional(),
  locale: z.unknown().optional(),
  from: party,
  recipient: party,
  conversation: party,
  entities: z.array(z.unknown()).nullish(),
  attachments: z.array(z.unknown()).nullish(),
  replyToId: z.unknown().optional(),
  value: z.unknown().optional(),
  channelData: z.unknown().optional(),
});

/** An inbound activity, validated. */
export type Activity = z.output<typeof activitySchema>;

/** A JSON object of an activity (an entity, an attachment, a card), read field by field. */
export type Fields = Readonly<Record<string, unknown>>;

/** Validates what the channel delivered. */
export function parseActivity(raw: unknown): Result<Activity, InvalidInput> {
  return parseInput("teams.activity", activitySchema, raw);
}

export function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `activity.get(key) or {}` for one of its objects (`from`, `recipient`, `conversation`). */
export function partOf(activity: Activity, key: "from" | "recipient" | "conversation"): Fields {
  return activity[key] ?? {};
}

/** The activity's entities that are objects. */
export function entitiesOf(activity: Activity): Fields[] {
  return (activity.entities ?? []).filter(isFields);
}

/** The activity's attachments that are objects. */
export function attachmentsOf(activity: Activity): Fields[] {
  return (activity.attachments ?? []).filter(isFields);
}

/** The bot's own id in this conversation (`recipient.id`), "" when not said. */
export function botIdOf(activity: Activity): string {
  return pyStr(partOf(activity, "recipient")["id"]);
}

/** Python's truthiness, for the `x or y` reads of a JSON value. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isFields(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}
