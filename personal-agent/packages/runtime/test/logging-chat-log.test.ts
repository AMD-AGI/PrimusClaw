// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { silentLogger, type RequestContext, type RequestScope } from "@primusclaw/personal-agent";

import { ChatLog } from "../src/logging/chat-log.js";

/** A request scope without async_hooks: a stack, entered and left around `fn`. */
function fakeScope(): RequestScope & { enter(userId: string, conversationId: string, fn: () => void): void } {
  const stack: RequestContext[] = [];
  const scope: RequestScope = {
    run: (ctx, fn) => {
      stack.push(ctx);
      try {
        return fn();
      } finally {
        stack.pop();
      }
    },
    current: () => stack.at(-1),
  };
  return {
    ...scope,
    enter: (userId, conversationId, fn) => {
      scope.run({ clientLocale: "", activityId: "act-1", userId, conversationId }, fn);
    },
  };
}

test("log lines are kept per chat and only for the worker and the last thirty", () => {
  const scope = fakeScope();
  const log = new ChatLog(
    scope,
    (t) => t,
    () => 1_000_000,
  );
  const worker = log.logger(silentLogger, "agent");
  for (let i = 0; i < 40; i += 1)
    scope.enter("aad-a", "conv-a", () => {
      worker.info(`line ${String(i)}`);
    });
  scope.enter("aad-b", "conv-b", () => {
    worker.info("another chat");
  });
  worker.info("no chat at all");
  scope.enter("aad-a", "conv-a", () => {
    worker.child({ module: "x" }).warn("from a child", { n: 1 }); // a child logger keeps the chat
  });
  scope.enter("aad-a", "conv-a", () => {
    worker.debug("too low a level");
  });
  const lines = log.tail("aad-a", "conv-a");
  assert.equal(lines.length, 30);
  assert.equal(lines[0], "1970-01-12T13:46:40Z INFO agent line 11");
  assert.equal(lines.at(-1), "1970-01-12T13:46:40Z WARNING agent from a child n=1");
  assert.deepEqual(log.tail("aad-b", "conv-b"), ["1970-01-12T13:46:40Z INFO agent another chat"]);
  assert.deepEqual(log.tail("aad-c", "conv-c"), []);
});

test("a request with no user is still kept under its conversation, as Python keeps a LOG_SCOPE whose aad_id is empty", () => {
  const scope = fakeScope();
  const log = new ChatLog(
    scope,
    (t) => t,
    () => 0,
  );
  const worker = log.logger(silentLogger, "agent");
  scope.enter("", "conv-x", () => {
    worker.info("kept");
  });
  assert.deepEqual(log.tail("", "conv-x"), ["1970-01-01T00:00:00Z INFO agent kept"]);
});

test("the inner logger gets every line and the buffer keeps at most its capacity", () => {
  const scope = fakeScope();
  const seen: string[] = [];
  const inner = { ...silentLogger, info: (m: string) => void seen.push(m), child: () => inner };
  const log = new ChatLog(
    scope,
    (t) => t,
    () => 0,
    3,
  );
  const worker = log.logger(inner, "agent");
  for (let i = 0; i < 5; i += 1)
    scope.enter("u", "c", () => {
      worker.info(`l${String(i)}`);
    });
  worker.info("outside");
  assert.deepEqual(seen, ["l0", "l1", "l2", "l3", "l4", "outside"]);
  assert.equal(log.tail("u", "c").length, 3);
  assert.ok(log.tail("u", "c")[0]?.endsWith("l2"));
});
