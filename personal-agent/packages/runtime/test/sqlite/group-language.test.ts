// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The language each group chat is answered in: kept per chat, asked once, and set again by anyone. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { Fernet, SqliteStore } from "@primusclaw/personal-agent-runtime";

import { ignoreEvents, openTestStore, tempDir } from "../../../../test-support/index.js";

test("a chat is asked once: the first mark records it, the next does not, and a choice is kept per chat", () => {
  const { store } = openTestStore();
  const repo = store.groupLanguage;
  assert.equal(repo.groupLanguage("g-1"), null);
  assert.equal(repo.markGroupLanguageAsked("g-1"), true);
  assert.equal(repo.markGroupLanguageAsked("g-1"), false, "two mentions at once put one card");
  assert.equal(repo.groupLanguage("g-1"), "");
  repo.setGroupLanguage("g-1", "en");
  assert.equal(repo.groupLanguage("g-1"), "en");
  assert.equal(repo.groupLanguage("g-2"), null);
  repo.setGroupLanguage("g-1", "zh");
  assert.equal(repo.groupLanguage("g-1"), "zh");
  repo.setGroupLanguage("g-1", "auto");
  assert.equal(repo.groupLanguage("g-1"), "auto");
  // A chat set before it was ever asked is never asked.
  repo.setGroupLanguage("g-3", "en");
  assert.equal(repo.markGroupLanguageAsked("g-3"), false);
});

test("a card that did not go out is asked again; once chosen, an unmark undoes nothing", () => {
  const { store } = openTestStore();
  const repo = store.groupLanguage;
  assert.equal(repo.markGroupLanguageAsked("g-1"), true);
  repo.unmarkGroupLanguageAsked("g-1");
  assert.equal(repo.groupLanguage("g-1"), null);
  assert.equal(repo.markGroupLanguageAsked("g-1"), true);
  repo.setGroupLanguage("g-1", "en");
  repo.unmarkGroupLanguageAsked("g-1");
  assert.equal(repo.groupLanguage("g-1"), "en");
});

test("the language survives a restart of the worker (the store reopened)", () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "s.db");
    const keys = [Fernet.generateKey()];
    const first = new SqliteStore({ path, encryptionKeys: keys, securityEvent: ignoreEvents });
    first.groupLanguage.setGroupLanguage("g-1", "en");
    first.groupLanguage.markGroupLanguageAsked("g-2");
    first.close();
    const again = new SqliteStore({ path, encryptionKeys: keys, securityEvent: ignoreEvents });
    assert.equal(again.groupLanguage.groupLanguage("g-1"), "en");
    assert.equal(again.groupLanguage.groupLanguage("g-2"), "");
    again.close();
  } finally {
    dir.remove();
  }
});
