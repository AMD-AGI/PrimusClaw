// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The group chats that turned the recent-messages context off: only that switch is stored, per chat. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { Fernet, SqliteStore } from "@primusclaw/personal-agent-runtime";

import { ignoreEvents, openTestStore, tempDir } from "../../../../test-support/index.js";

test("off is kept per chat, on again removes it, and turning it off twice is still off", () => {
  const { store } = openTestStore();
  assert.equal(store.groupContext.contextOff("g-1"), false);
  store.groupContext.setContextOff("g-1", true);
  store.groupContext.setContextOff("g-1", true);
  assert.equal(store.groupContext.contextOff("g-1"), true);
  assert.equal(store.groupContext.contextOff("g-2"), false);
  store.groupContext.setContextOff("g-1", false);
  assert.equal(store.groupContext.contextOff("g-1"), false);
});

test("off survives a restart of the worker (the store reopened)", () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "s.db");
    const keys = [Fernet.generateKey()];
    const first = new SqliteStore({ path, encryptionKeys: keys, securityEvent: ignoreEvents });
    first.groupContext.setContextOff("g-1", true);
    first.close();
    const again = new SqliteStore({ path, encryptionKeys: keys, securityEvent: ignoreEvents });
    assert.equal(again.groupContext.contextOff("g-1"), true);
    again.close();
  } finally {
    dir.remove();
  }
});
