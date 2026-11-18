// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The per-person limit is the person's, whichever chat it is used from (review of #636; Python's `_PersonGuard`): a group
// binding's chat key is person#conversation, and binding another group must not be a new allowance.
import assert from "node:assert/strict";
import { test } from "node:test";

import { groupChatKey } from "../../../src/remote/chat-key.js";
import type { RemoteGuard } from "../../../src/remote/context.js";
import { remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD } from "./helpers.js";

const LIMIT = 10; // remote_agent: 10 an hour (guardrails/operations.ts)

test("one person in two group chats uses one allowance", () =>
  remoteWorld((w) => {
    // (the guard every part of the remote agents counts with)
    const guard = (w.remote as unknown as { ctx: { guard: RemoteGuard } }).ctx.guard;
    const first = groupChatKey(AAD, "19:first@thread.v2");
    const second = groupChatKey(AAD, "19:second@thread.v2");
    for (let i = 0; i < LIMIT; i += 1)
      assert.equal(guard.take(first, "remote_agent", {}), null, `take ${String(i + 1)}`);
    assert.notEqual(guard.take(second, "remote_agent", {}), null); // the same person, another group: no new allowance
    assert.notEqual(guard.take(AAD, "remote_agent", {}), null); // nor in the 1:1 chat
    return Promise.resolve();
  }));
