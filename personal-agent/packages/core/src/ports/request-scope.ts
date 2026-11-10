// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the worker is handling right now: the inbound activity a piece of work was started by, so that what runs on its
 * behalf (an answer's language, an audit record, a log line kept for /feedback) knows it without every call passing it
 * on. The router enters it once per inbound event, after the duplicate check and before routing (Python agent.py
 * `Agent.handle`: LOG_SCOPE, CLIENT_LOCALE and ACTIVITY_ID set around `_route`). Work started inside keeps it after the
 * router has returned, as an asyncio task copies its context; work started outside any event (a timer, a pushed
 * notification, start-up recovery) reads none.
 */

/** The inbound event's context (Python: CLIENT_LOCALE, ACTIVITY_ID, and LOG_SCOPE's aad id and conversation id). */
export interface RequestContext {
  /** The client's locale as the channel said it ("" when it did not). */
  readonly clientLocale: string;
  /** The inbound activity's id ("" when it has none). */
  readonly activityId: string;
  /** The sender's id. */
  readonly userId: string;
  /** The conversation's id. */
  readonly conversationId: string;
}

export interface RequestScope {
  /** Runs `fn` inside `context` (and what it starts, for as long as that runs); the outer context is back after it. */
  run<T>(context: RequestContext, fn: () => T): T;
  /** The context of the event being handled; undefined outside any. */
  current(): RequestContext | undefined;
}

/** A scope that keeps nothing: `run` only runs, `current` is always undefined (what a worker without one reads). */
export const noRequestScope: RequestScope = {
  run: (_context, fn) => fn(),
  current: () => undefined,
};

/** The client locale of the event being handled ("" outside any: Python CLIENT_LOCALE's default). */
export function clientLocaleOf(scope: RequestScope): string {
  return scope.current()?.clientLocale ?? "";
}

/** The id of the activity being handled ("" outside any: Python ACTIVITY_ID's default, None). */
export function activityIdOf(scope: RequestScope): string {
  return scope.current()?.activityId ?? "";
}
