// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The router enters the event's context once, after the duplicate check and before routing (Python agent.py
// Agent.handle sets LOG_SCOPE, CLIENT_LOCALE and ACTIVITY_ID around _route, after store.seen).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityIdOf,
  clientLocaleOf,
  noRequestScope,
  type RequestContext,
  type RequestScope,
} from "../../src/ports/request-scope.js";
import { ALICE } from "./fixtures.js";
import { link, message, world } from "./world.js";

/** A synchronous stack of contexts: what the scope holds now is the innermost `run`'s. */
class StackScope implements RequestScope {
  readonly entered: RequestContext[] = [];
  private readonly stack: RequestContext[] = [];

  run<T>(context: RequestContext, fn: () => T): T {
    this.entered.push(context);
    this.stack.push(context);
    try {
      const out = fn();
      if (out instanceof Promise) return out.finally(() => this.stack.pop()) as T;
      this.stack.pop();
      return out;
    } catch (error) {
      this.stack.pop();
      throw error;
    }
  }

  current(): RequestContext | undefined {
    return this.stack.at(-1);
  }
}

function scoped() {
  const scope = new StackScope();
  const seen: (RequestContext | undefined)[] = [];
  const w = world({
    requestScope: scope,
    handlers: {
      personalInterceptors: [
        {
          name: "reads the scope",
          intercept: () => {
            seen.push(scope.current());
            return Promise.resolve(true);
          },
        },
      ],
    },
  });
  link(w, ALICE.id, "ak");
  return { w, scope, seen };
}

test("what a handler runs reads the event's locale, id, sender and conversation", async () => {
  const { w, scope, seen } = scoped();
  await w.router.handle(message("hello", { id: "act-77", locale: "zh-CN" }));
  assert.deepEqual(seen, [
    { clientLocale: "zh-CN", activityId: "act-77", userId: ALICE.id, conversationId: "dm-aad-a" },
  ]);
  assert.equal(clientLocaleOf(scope), "", "outside the event there is none");
  assert.equal(scope.current(), undefined);
});

test("an event seen before enters no context and reaches no handler", async () => {
  const { w, scope, seen } = scoped();
  await w.router.handle(message("hello", { id: "act-1" }));
  await w.router.handle(message("hello again", { id: "act-1" }));
  assert.equal(scope.entered.length, 1);
  assert.equal(seen.length, 1);
});

test("outside any event, and without a scope, the locale and the activity id are empty", () => {
  assert.equal(clientLocaleOf(noRequestScope), "");
  assert.equal(activityIdOf(noRequestScope), "");
  assert.equal(
    noRequestScope.run({ clientLocale: "zh", activityId: "a", userId: "u", conversationId: "c" }, () => 7),
    7,
  );
  assert.equal(noRequestScope.current(), undefined);
  const scope = new StackScope();
  scope.run({ clientLocale: "zh-CN", activityId: "a-1", userId: "u", conversationId: "c" }, () => {
    assert.equal(clientLocaleOf(scope), "zh-CN");
    assert.equal(activityIdOf(scope), "a-1");
  });
});
