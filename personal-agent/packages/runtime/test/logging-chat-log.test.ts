// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { silentLogger } from "@primusclaw/personal-agent";

import { ChatLog } from "../src/logging/chat-log.js";

test("log lines are kept per chat and only for the worker and the last thirty", async () => {
  const log = new ChatLog(
    (t) => t,
    () => 1_000_000,
  );
  const worker = log.logger(silentLogger, "agent");
  const chat = { userId: "aad-a", conversationId: "conv-a" };
  for (let i = 0; i < 40; i += 1)
    log.withChat(chat, () => {
      worker.info(`line ${String(i)}`);
    });
  log.withChat({ userId: "aad-b", conversationId: "conv-b" }, () => {
    worker.info("another chat");
  });
  worker.info("no chat at all");
  await log.withChat(chat, async () => {
    await Promise.resolve();
    worker.child({ module: "x" }).warn("after an await", { n: 1 }); // a task it started keeps the chat
  });
  log.withChat(chat, () => {
    worker.debug("too low a level");
  });
  const lines = log.tail("aad-a", "conv-a");
  assert.equal(lines.length, 30);
  assert.equal(lines[0], "1970-01-12T13:46:40Z INFO agent line 11");
  assert.equal(lines.at(-1), "1970-01-12T13:46:40Z WARNING agent after an await n=1");
  assert.deepEqual(log.tail("aad-b", "conv-b"), ["1970-01-12T13:46:40Z INFO agent another chat"]);
  assert.deepEqual(log.tail("aad-c", "conv-c"), []);
});

test("the inner logger gets every line and the buffer keeps at most its capacity", () => {
  const seen: string[] = [];
  const inner = { ...silentLogger, info: (m: string) => void seen.push(m), child: () => inner };
  const log = new ChatLog(
    (t) => t,
    () => 0,
    3,
  );
  const worker = log.logger(inner, "agent");
  for (let i = 0; i < 5; i += 1)
    log.withChat({ userId: "u", conversationId: "c" }, () => {
      worker.info(`l${String(i)}`);
    });
  worker.info("outside");
  assert.deepEqual(seen, ["l0", "l1", "l2", "l3", "l4", "outside"]);
  assert.equal(log.tail("u", "c").length, 3);
  assert.ok(log.tail("u", "c")[0]?.endsWith("l2"));
});
