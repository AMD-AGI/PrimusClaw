// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which event types and sources a person's subscription asks for, best first (teams_agent/subscriptions.py `_wanted`), and the
 * `types_version` each is recorded as.
 */
import { ASSISTANT_EVENT_TYPES, NOTIFICATION_RUN_EVENT_TYPES, NOTIFICATION_SOURCES } from "../protocol.js";

/** The event types Claw gives a subscription that asks for none in particular. */
export const SUBSCRIPTION_BASE_TYPES: readonly string[] = NOTIFICATION_RUN_EVENT_TYPES.filter((t) =>
  t.startsWith("run."),
);
/** `approval.requested`: a run, or a work item's worker, waits for the person's decision or answer. */
export const APPROVAL_EVENT = NOTIFICATION_RUN_EVENT_TYPES[2];
/** The assistant asks the chat to carry out one of the actions a message declared. */
export const ASSISTANT_ACTION = ASSISTANT_EVENT_TYPES[2];
/** What the assistant says, and a work item that needs the person: the events this worker shows as the assistant's words. */
export const ASSISTANT_SAID_TYPES: readonly string[] = ASSISTANT_EVENT_TYPES.filter((t) => t !== ASSISTANT_ACTION);
/** The sources Claw gives a subscription that asks for none in particular (a trigger's runs, a long one's). */
export const RUN_SOURCES: readonly string[] = NOTIFICATION_SOURCES.slice(0, 2);
/** The source of an `approval.requested` a work item holds for its person. */
export const ITEM_SOURCE = NOTIFICATION_SOURCES[2];
export const APPROVAL_SOURCES: readonly string[] = [...RUN_SOURCES, ITEM_SOURCE];

export const ASSISTANT_SUBSCRIPTION_TYPES: readonly string[] = [...SUBSCRIPTION_BASE_TYPES, ...ASSISTANT_SAID_TYPES];
/** `types_version` of a subscription with the assistant's types; 0 is the base types. */
export const ASSISTANT_TYPES_VERSION = 1;
/** `types_version` of a subscription that also has the approvals of work items. */
export const APPROVALS_TYPES_VERSION = 2;

/** One rung of what a subscription asks for: its types, its sources (undefined: whatever it has) and the version recorded. */
export interface WantedTypes {
  readonly types: readonly string[];
  readonly sources: readonly string[] | undefined;
  readonly version: number;
}

function same(a: WantedTypes, b: WantedTypes): boolean {
  return (
    a.version === b.version &&
    a.types.join("\n") === b.types.join("\n") &&
    (a.sources ?? []).join("\n") === (b.sources ?? []).join("\n") &&
    (a.sources === undefined) === (b.sources === undefined)
  );
}

/**
 * What a subscription asks for with the assistant on, best first; the next is taken when Claw refuses one (400): a Claw from before
 * the work items' approvals, or before `assistant.action` (asked only for people whose every message the assistant understands).
 */
export function wantedTypes(understood: boolean): WantedTypes[] {
  const action = understood ? [ASSISTANT_ACTION] : [];
  const ladder: WantedTypes[] = [
    {
      types: [...ASSISTANT_SUBSCRIPTION_TYPES, ...action, APPROVAL_EVENT],
      sources: APPROVAL_SOURCES,
      version: APPROVALS_TYPES_VERSION,
    },
    {
      types: [...ASSISTANT_SUBSCRIPTION_TYPES, APPROVAL_EVENT],
      sources: APPROVAL_SOURCES,
      version: APPROVALS_TYPES_VERSION,
    },
    { types: [...ASSISTANT_SUBSCRIPTION_TYPES, ...action], sources: undefined, version: ASSISTANT_TYPES_VERSION },
    { types: [...ASSISTANT_SUBSCRIPTION_TYPES], sources: undefined, version: ASSISTANT_TYPES_VERSION },
  ];
  return ladder.filter((rung, k) => !ladder.slice(0, k).some((earlier) => same(earlier, rung)));
}
