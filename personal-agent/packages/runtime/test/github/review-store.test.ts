// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review service's records in a database a release older than them made: a held merge's confirmation from before held
 * reviews existed is still a merge (`test_a_confirmation_stored_before_there_were_held_reviews_is_read_as_a_merge`), and the
 * people the worker has seen get the address column (`test_an_older_database_gets_the_address_column`).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Fernet, SqliteStore } from "@primusclaw/personal-agent-runtime";

import { ignoreEvents, tempDir } from "../../../../test-support/index.js";

function older(sql: readonly string[]): { store: SqliteStore; done: () => void } {
  const dir = tempDir();
  const path = join(dir.path, "old.db");
  const db = new DatabaseSync(path);
  for (const statement of sql) db.exec(statement);
  db.close();
  const store = new SqliteStore({ path, encryptionKeys: [Fernet.generateKey()], securityEvent: ignoreEvents });
  return {
    store,
    done: () => {
      store.close();
      dir.remove();
    },
  };
}

test("a confirmation stored before there were held reviews is read as a merge", () => {
  const { store, done } = older([
    "CREATE TABLE github_confirmations (confirmation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, actor_aad TEXT NOT NULL, " +
      "requester_aad TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL, reference_json TEXT NOT NULL, expires_at REAL NOT NULL, " +
      "state TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL)",
    "INSERT INTO github_confirmations VALUES ('cf-old', 's', 'aad-b', 'aad-a', 'AMD-AGI/Hyperloom', 12, '{}', 9e9, 'pending', 1)",
  ]);
  try {
    const row = store.githubConfirmations.getGithubConfirmation("cf-old");
    assert.deepEqual([row?.kind, row?.event, row?.state], ["merge", "", "pending"]);
    assert.equal(
      store.githubConfirmations.addGithubConfirmation({
        confirmationId: "cf-new",
        sessionId: "s",
        actorId: "aad-b",
        requesterId: "aad-a",
        repo: "AMD-AGI/Hyperloom",
        pr: 12,
        reference: {},
        expiresAt: 9e9,
        kind: "review",
        event: "COMMENT",
      }),
      true,
    );
    const added = store.githubConfirmations.getGithubConfirmation("cf-new");
    assert.deepEqual([added?.kind, added?.event], ["review", "COMMENT"]);
  } finally {
    done();
  }
});

test("an older database gets the address column", () => {
  const { store, done } = older([
    "CREATE TABLE teams_users (teams_id TEXT PRIMARY KEY, aad_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', " +
      "updated_at REAL NOT NULL)",
    "INSERT INTO teams_users VALUES ('29:w', 'aad-w', 'Lin, Mei', 1)",
  ]);
  try {
    assert.deepEqual(store.members.knownMembers(), [{ id: "29:w", objectId: "aad-w", name: "Lin, Mei" }]);
    store.members.rememberMemberEmails([{ id: "29:w", email: "mlin@example.com" }]);
    assert.equal(store.members.knownMembers()[0]?.email, "mlin@example.com");
  } finally {
    done();
  }
});
