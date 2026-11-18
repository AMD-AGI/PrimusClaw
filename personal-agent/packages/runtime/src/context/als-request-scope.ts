// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * core's `RequestScope` on Node's `AsyncLocalStorage`: the one asynchronous context the worker keeps. What `run`
 * starts (an awaited call, a promise, a timer, a background turn) keeps the context it was started in after `run` has
 * returned, as a Python asyncio task copies its context when it is created; two events handled at once never see each
 * other's. The router enters it once per inbound event; an answer's language, an audit record's activity id and the
 * log lines kept for /feedback read it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext, RequestScope } from "@primusclaw/personal-agent";

/** A scope of its own: contexts entered in one are not seen through another. */
export function alsRequestScope(): RequestScope {
  const storage = new AsyncLocalStorage<RequestContext>();
  return {
    run: (context, fn) => storage.run(context, fn),
    current: () => storage.getStore(),
  };
}
