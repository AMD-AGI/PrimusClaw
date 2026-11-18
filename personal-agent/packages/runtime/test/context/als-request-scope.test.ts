// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { activityIdOf, clientLocaleOf, type RequestContext } from "@primusclaw/personal-agent";
import { alsRequestScope } from "../../src/index.js";

function ctx(activityId: string, clientLocale = "zh-CN"): RequestContext {
  return { clientLocale, activityId, userId: `user-${activityId}`, conversationId: `conv-${activityId}` };
}

test("outside any event the scope reads nothing, and the defaults are Python's", () => {
  const scope = alsRequestScope();
  assert.equal(scope.current(), undefined);
  assert.equal(clientLocaleOf(scope), "");
  assert.equal(activityIdOf(scope), "");
});

test("run returns what fn returns, and the context is there inside and gone after", () => {
  const scope = alsRequestScope();
  const inside = scope.run(ctx("a1"), () => ({ current: scope.current(), locale: clientLocaleOf(scope) }));
  assert.deepEqual(inside, { current: ctx("a1"), locale: "zh-CN" });
  assert.equal(scope.current(), undefined);
});

test("the context survives an await, and a nested run gives the outer one back after it", async () => {
  const scope = alsRequestScope();
  const seen: string[] = [];
  await scope.run(ctx("outer"), async () => {
    await tick();
    seen.push(activityIdOf(scope));
    await scope.run(ctx("inner", "en-US"), async () => {
      await tick();
      seen.push(`${activityIdOf(scope)}/${clientLocaleOf(scope)}`);
    });
    seen.push(activityIdOf(scope));
  });
  assert.deepEqual(seen, ["outer", "inner/en-US", "outer"]);
  assert.equal(scope.current(), undefined);
});

test("a timer and a background task started in run keep its context after run has returned", async () => {
  const scope = alsRequestScope();
  let resolveTimer!: (id: string) => void;
  const timer = new Promise<string>((resolve) => (resolveTimer = resolve));
  let background!: Promise<string>;
  scope.run(ctx("a2"), () => {
    setTimeout(() => {
      resolveTimer(activityIdOf(scope));
    }, 5);
    background = (async () => {
      await delay(10);
      return activityIdOf(scope);
    })();
  });
  assert.equal(scope.current(), undefined);
  assert.equal(await timer, "a2");
  assert.equal(await background, "a2");
});

test("two events handled at once each see their own context", async () => {
  const scope = alsRequestScope();
  const handle = (id: string, waits: number[]): Promise<string[]> =>
    scope.run(ctx(id), async () => {
      const seen: string[] = [];
      for (const ms of waits) {
        await delay(ms);
        seen.push(scope.current()?.conversationId ?? "none");
      }
      return seen;
    });
  const [a, b] = await Promise.all([handle("a", [1, 8, 1]), handle("b", [5, 1, 6])]);
  assert.deepEqual(a, ["conv-a", "conv-a", "conv-a"]);
  assert.deepEqual(b, ["conv-b", "conv-b", "conv-b"]);
});

test("a timer set outside any event reads nothing even while an event is being handled", async () => {
  const scope = alsRequestScope();
  const outside = new Promise<RequestContext | undefined>((resolve) => {
    setTimeout(() => {
      resolve(scope.current());
    }, 5);
  });
  const during = scope.run(ctx("a3"), async () => {
    await delay(10);
    return activityIdOf(scope);
  });
  assert.equal(await outside, undefined);
  assert.equal(await during, "a3");
});

test("two scopes do not see each other's contexts", () => {
  const one = alsRequestScope();
  const two = alsRequestScope();
  one.run(ctx("a4"), () => {
    assert.equal(activityIdOf(one), "a4");
    assert.equal(two.current(), undefined);
  });
});
