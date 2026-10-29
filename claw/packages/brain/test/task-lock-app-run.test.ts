// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// An app run and the session's conversation do not queue on one another.
//
// The gate key says which runs write the same files. An app run writes none of the
// session's: it lives in its own sandbox, for hours. When it took `ws.<workspace>`
// like a chat turn, every foreground turn sent while it ran was naked on that key
// (`task.lock_not_acquired.nak`, delivery 1..19, back-off up to ~285 s) and would
// have been resolved as a failed "timed out waiting" at the poison threshold.
//
// Coverage:
//   A1 an app run and a chat turn over one workspace take different keys
//   A2 the chat turn gets its lock while the app run holds its own
//   A3 chat turns over one workspace still queue on one key (serial semantics kept)
//   A4 the app key is per run: a second handler of the same run is refused
import test from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";

const { pickLockKey, acquireTaskLock, bindTaskLockKv } = await import("../src/tasks/lock.js");

function req(over: Record<string, unknown> = {}): ExecuteRequest {
  return {
    session_id: "sess-1", message_id: "msg-1", prompt: "hello", history: [], user_id: "u1",
    files_workspace_id: "kws_1", ...over,
  } as unknown as ExecuteRequest;
}
const app = (taskId = "ktsk_app") => req({ mode: "app", task_id: taskId });
const chat = (taskId = "ktsk_chat") => req({ task_id: taskId });

/** `create` fails when the key exists, as the NATS KV does. */
function memoryKv(): KV {
  const store = new Map<string, Uint8Array>();
  let rev = 1;
  return {
    create: async (key: string, value: Uint8Array) => {
      if (store.has(key)) throw new Error("wrong last sequence");
      store.set(key, value);
      return rev++;
    },
    get: async (key: string) => (store.has(key) ? { key, value: store.get(key)!, operation: "PUT" } : null),
    update: async () => rev++,
  } as unknown as KV;
}

test("A1 an app run and a chat turn over one workspace take different keys", () => {
  assert.equal(pickLockKey(chat()), "ws.kws_1");
  assert.equal(pickLockKey(app()), "app.ktsk_app");
});

test("A2 the chat turn gets its lock while the app run holds its own", async () => {
  bindTaskLockKv(memoryKv());
  assert.equal(await acquireTaskLock(pickLockKey(app()), 1), true, "the app run is running");
  assert.equal(await acquireTaskLock(pickLockKey(chat()), 2), true, "and the conversation is not queued behind it");
});

test("A3 chat turns over one workspace still queue on one key", async () => {
  bindTaskLockKv(memoryKv());
  assert.equal(pickLockKey(chat("t1")), pickLockKey(chat("t2")));
  assert.equal(await acquireTaskLock(pickLockKey(chat("t1")), 1), true);
  assert.equal(await acquireTaskLock(pickLockKey(chat("t2")), 2), false, "the second turn waits for the first");
});

test("A4 the app key is per run: a second handler of the same run is refused", async () => {
  bindTaskLockKv(memoryKv());
  assert.equal(await acquireTaskLock(pickLockKey(app("r1")), 1), true);
  assert.equal(await acquireTaskLock(pickLockKey(app("r1")), 2), false);
  assert.equal(await acquireTaskLock(pickLockKey(app("r2")), 3), true, "another run is its own");
});
