// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reply style's decorations of an outbound activity: Teams' "AI generated" label and citations (both in ONE schema.org
 * Message root entity: an activity with two is refused, 400 "Multiple root message entities"), and suggested replies; and
 * the same activity without them, for a second try when Teams refused them.
 */
import { isObject, type Json, type JsonObject } from "../cards/json.js";

export const ROOT_ENTITY_TYPE = "https://schema.org/Message";
export const AI_GENERATED = "AIGeneratedContent";
/** Teams shows at most 20 citations on a message. */
export const CITATIONS_MAX = 20;
/** Teams shows the first three suggested replies only. */
export const SUGGESTIONS_MAX = 3;

const FIXED_ROOT_KEYS = new Set(["type", "@type", "@context", "@id"]);

function isRoot(entity: unknown): entity is JsonObject {
  return isObject(entity) && entity["type"] === ROOT_ENTITY_TYPE;
}

/** The activity's entities that are JSON objects (anything else in the list is dropped, as the Python worker did). */
export function entitiesOf(activity: JsonObject): JsonObject[] {
  const entities = activity["entities"];
  return Array.isArray(entities) ? entities.filter(isObject) : [];
}

function mergeRoots(roots: readonly JsonObject[]): JsonObject {
  const merged: JsonObject = {
    type: ROOT_ENTITY_TYPE,
    "@type": "Message",
    "@context": "https://schema.org",
    "@id": "",
  };
  const kinds: string[] = [];
  const citations: JsonObject[] = [];
  for (const root of roots) {
    for (const [key, value] of Object.entries(root)) {
      if (key === "additionalType") {
        for (const kind of Array.isArray(value) ? value : [value]) {
          if (typeof kind === "string" && !kinds.includes(kind)) kinds.push(kind);
        }
      } else if (key === "citation") {
        if (Array.isArray(value)) citations.push(...value.filter(isObject));
      } else if (!FIXED_ROOT_KEYS.has(key)) {
        // (an own property whatever its name, as a Python dict key: `merged["__proto__"] = v` would set the prototype)
        Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  if (kinds.length) merged["additionalType"] = kinds;
  if (citations.length) merged["citation"] = citations.slice(0, CITATIONS_MAX);
  return merged;
}

/**
 * A copy of `activity` whose one root entity also has `fields` (an `additionalType` list is added to, a `citation` list
 * appended to; anything else is set). Every other entity is kept, in its place; several roots are merged into the first's.
 */
export function withRootEntity(activity: JsonObject, fields: JsonObject): JsonObject {
  const entities = entitiesOf(activity);
  const root = mergeRoots([...entities.filter(isRoot), fields]);
  const out: JsonObject[] = [];
  let placed = false;
  for (const entity of entities) {
    if (!isRoot(entity)) out.push(entity);
    else if (!placed) {
      out.push(root);
      placed = true;
    }
  }
  if (!placed) out.push(root);
  return { ...activity, entities: out };
}

/** A copy of `activity` that Teams shows with its "AI generated" label. */
export function withAiLabel(activity: JsonObject): JsonObject {
  return withRootEntity(activity, { additionalType: [AI_GENERATED] });
}

/** The schema.org Message root entities of an activity (Teams takes at most one). */
export function rootEntities(activity: JsonObject): JsonObject[] {
  const entities = activity["entities"];
  return Array.isArray(entities) ? entities.filter(isRoot) : [];
}

/** A copy of `activity` with `citations` in its one root entity (the activity itself when there are none). */
export function withCitationEntities(activity: JsonObject, citations: readonly JsonObject[]): JsonObject {
  return citations.length ? withRootEntity(activity, { citation: [...citations] }) : activity;
}

/** One suggested reply: the title shown, and the text sent as the person's message. */
export interface Suggestion {
  readonly title: string;
  readonly value: string;
}

/**
 * A copy of `activity` with Teams' suggested replies under it, at most SUGGESTIONS_MAX. Teams shows them only on a
 * message without attachments (the activity itself is returned for one with attachments, or when none is left).
 */
export function withSuggestedReplies(activity: JsonObject, replies: readonly Suggestion[]): JsonObject {
  const actions: Json[] = replies
    .slice(0, SUGGESTIONS_MAX)
    .filter((r) => r.title && r.value)
    .map((r) => ({ type: "imBack", title: r.title, value: r.value }));
  const attachments = activity["attachments"];
  if (!actions.length || (Array.isArray(attachments) && attachments.length > 0)) return activity;
  return { ...activity, suggestedActions: { actions } };
}

function hasSuggestions(activity: JsonObject): boolean {
  const suggested = activity["suggestedActions"];
  if (Array.isArray(suggested)) return suggested.length > 0;
  if (isObject(suggested)) return Object.keys(suggested).length > 0;
  return Boolean(suggested);
}

/**
 * `activity` without what only Teams' newer clients understand (the root entity with the AI label and citations, the
 * suggested replies), for a second try when Teams refused the activity with them (400). undefined: it has none of them.
 */
export function plainDecorations(activity: JsonObject): JsonObject | undefined {
  const entities = Array.isArray(activity["entities"]) ? activity["entities"] : [];
  if (!(hasSuggestions(activity) || entities.some(isRoot))) return undefined;
  const out: JsonObject = Object.fromEntries(Object.entries(activity).filter(([key]) => key !== "suggestedActions"));
  const kept = entities.filter((e) => !isRoot(e));
  if (kept.length) return { ...out, entities: kept };
  return Object.fromEntries(Object.entries(out).filter(([key]) => key !== "entities"));
}
