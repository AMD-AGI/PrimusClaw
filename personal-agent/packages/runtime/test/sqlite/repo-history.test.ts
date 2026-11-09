// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What /repo and /sessions remember (Python: test_repo_sessions.py, its store tests).
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { PENDING_REPO_TTL_SECONDS, RECENT_REPOS, SESSION_HISTORY_KEEP, SESSION_LIST } from "@primusclaw/personal-agent";
import { Fernet, SqliteStore } from "@primusclaw/personal-agent-runtime";

import { advanceSeconds, openFileTestStore, openTestStore, tempDir } from "../../../../test-support/index.js";

const repos = (store: SqliteStore, who = "aad-a"): string[] => store.repoHistory.recentRepos(who).map((r) => r.repo);
const pick = (store: SqliteStore, repo: string, branch = "", who = "aad-a"): void => {
  store.repoHistory.touchRecentRepo(who, { repo, branch });
};

test("the last five repositories, newest first; a repeat moves to the top", () => {
  const { store } = openTestStore();
  for (let n = 0; n < 7; n++) pick(store, `o/r${String(n)}`);
  assert.deepEqual(repos(store), ["o/r6", "o/r5", "o/r4", "o/r3", "o/r2"]);
  assert.equal(RECENT_REPOS, 5);
  pick(store, "o/r3");
  assert.deepEqual(repos(store), ["o/r3", "o/r6", "o/r5", "o/r4", "o/r2"]);
  pick(store, "o/r9");
  assert.deepEqual(repos(store), ["o/r9", "o/r3", "o/r6", "o/r5", "o/r4"]);
});

test("the same repository on another branch is another entry, and case does not matter", () => {
  const { store } = openTestStore();
  pick(store, "AMD-AGI/PrimusClaw", "main");
  pick(store, "AMD-AGI/PrimusClaw", "dev");
  pick(store, "amd-agi/primusclaw", "main");
  assert.deepEqual(store.repoHistory.recentRepos("aad-a"), [
    { repo: "amd-agi/primusclaw", branch: "main" },
    { repo: "AMD-AGI/PrimusClaw", branch: "dev" },
  ]);
  pick(store, "AMD-AGI/PrimusClaw");
  assert.equal(store.repoHistory.recentRepos("aad-a").length, 3);
});

test("two picks in the same second keep their order", () => {
  const { store, clock } = openTestStore();
  clock.setEpochMs(5_000_000);
  pick(store, "o/first");
  pick(store, "o/second");
  assert.deepEqual(repos(store), ["o/second", "o/first"]);
});

test("what is remembered is per person, and forgotten on unlink and on a link to another account", () => {
  const { store } = openTestStore();
  const history = store.repoHistory;
  pick(store, "o/mine");
  pick(store, "o/his", "", "aad-b");
  history.setPendingRepo("aad-a", { repo: "o/mine", branch: "dev" });
  history.noteSession("aad-a", "s1", { title: "title" });
  assert.deepEqual(history.recentRepos("aad-b"), [{ repo: "o/his", branch: "" }]);
  assert.equal(history.getPendingRepo("aad-b"), null);
  assert.deepEqual(history.sessionHistory("aad-b"), []);
  store.links.unlink("aad-a");
  assert.deepEqual(
    [history.recentRepos("aad-a"), history.getPendingRepo("aad-a"), history.sessionHistory("aad-a")],
    [[], null, []],
  );
  assert.deepEqual(history.recentRepos("aad-b"), [{ repo: "o/his", branch: "" }]);
  pick(store, "o/again");
  assert.equal(store.links.redeemPending("aad-a", "Alice", store.links.stashPending("ak-other")), "ok");
  assert.deepEqual(history.recentRepos("aad-a"), []);
});

test("the pending repository is replaced by the next pick and runs out", () => {
  const { store, clock } = openTestStore();
  const history = store.repoHistory;
  history.setPendingRepo("aad-a", { repo: "o/one", branch: "main" });
  history.setPendingRepo("aad-a", { repo: "o/two", branch: "" });
  assert.deepEqual(history.getPendingRepo("aad-a"), { repo: "o/two", branch: "" });
  advanceSeconds(clock, PENDING_REPO_TTL_SECONDS - 1);
  assert.deepEqual(history.getPendingRepo("aad-a"), { repo: "o/two", branch: "" });
  advanceSeconds(clock, 1);
  assert.equal(history.getPendingRepo("aad-a"), null);
  history.setPendingRepo("aad-a", { repo: "o/three", branch: "" });
  history.clearPendingRepo("aad-a");
  assert.equal(history.getPendingRepo("aad-a"), null);
});

test("the session list is newest first, keeps title and repository, and is capped", () => {
  const { store, clock } = openTestStore();
  const history = store.repoHistory;
  for (let n = 0; n < SESSION_HISTORY_KEEP + 3; n++) {
    advanceSeconds(clock, 10);
    history.noteSession("aad-a", `s${String(n)}`, {
      title: `title ${String(n)}`,
      repo: n === 5 ? "o/r" : "",
      branch: n === 5 ? "dev" : "",
    });
  }
  const expected = Array.from({ length: 5 }, (_, i) => `s${String(SESSION_HISTORY_KEEP + 2 - i)}`);
  assert.deepEqual(
    history.sessionHistory("aad-a").map((r) => r.sessionId),
    expected,
  );
  assert.equal(SESSION_LIST, 5);
  const all = history.sessionHistory("aad-a", 100);
  assert.equal(all.length, SESSION_HISTORY_KEEP);
  assert.equal(all.at(-1)?.sessionId, "s3");
  advanceSeconds(clock, 10);
  history.noteSession("aad-a", "s5", { title: "", repo: "", branch: "" });
  assert.deepEqual(history.sessionHistory("aad-a")[0], {
    sessionId: "s5",
    title: "title 5",
    repo: "o/r",
    branch: "dev",
    lastAt: store.now(),
  });
});

test("a session remembered without a title gets it when it becomes known, and never loses it again", () => {
  const { store } = openTestStore();
  const history = store.repoHistory;
  history.noteSession("aad-a", "s1");
  history.noteSession("aad-a", "s1", { title: "the first message", repo: "o/r", branch: "main" });
  history.noteSession("aad-a", "s1", { title: "something else", repo: "p/q", branch: "dev" });
  const rows = history.sessionHistory("aad-a");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.title, rows[0]?.repo, rows[0]?.branch], ["the first message", "o/r", "main"]);
});

test("the limits are these numbers, and they are what is kept, not only what is listed", () => {
  // Written out, not taken from the constants: a test that reads its oracle from the code cannot see the code change.
  assert.deepEqual([RECENT_REPOS, SESSION_LIST, SESSION_HISTORY_KEEP, PENDING_REPO_TTL_SECONDS], [5, 5, 20, 86400]);
  const f = openFileTestStore();
  try {
    for (let n = 0; n < 30; n++) {
      pick(f.store, `o/r${String(n)}`);
      f.store.repoHistory.noteSession("aad-a", `s${String(n)}`, { title: `t${String(n)}` });
    }
    const rows = (table: string): unknown =>
      f.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE aad_id = 'aad-a'`).get()?.["n"];
    assert.deepEqual([rows("recent_repos"), rows("session_history")], [5, 20]);
    assert.equal(f.store.repoHistory.recentRepos("aad-a").length, 5);
    assert.equal(f.store.repoHistory.sessionHistory("aad-a", 100).length, 20);
  } finally {
    f.close();
  }
});

test("a forgotten session is off the list", () => {
  const { store } = openTestStore();
  const history = store.repoHistory;
  history.noteSession("aad-a", "s1");
  history.noteSession("aad-a", "s2");
  history.noteSession("aad-b", "s1");
  history.forgetSession("aad-a", "s1");
  assert.deepEqual(
    history.sessionHistory("aad-a").map((r) => r.sessionId),
    ["s2"],
  );
  assert.equal(history.sessionHistory("aad-b").length, 1);
  history.forgetRepos("aad-b");
  assert.deepEqual(history.sessionHistory("aad-b"), []);
});

test("a database from before this feature gets the tables and keeps its session", () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "old.db");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE sessions (aad_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, " +
        "updated_at REAL NOT NULL, plugin_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', PRIMARY KEY (aad_id, scope))",
    );
    db.exec("INSERT INTO sessions VALUES ('aad-a', '', 's-old', 1, '', '')");
    db.close();
    const store = new SqliteStore({ path, encryptionKeys: [Fernet.generateKey()] });
    assert.equal(store.sessions.getSession("aad-a"), "s-old");
    assert.deepEqual(store.repoHistory.recentRepos("aad-a"), []);
    assert.deepEqual(store.repoHistory.sessionHistory("aad-a"), []);
    store.close();
  } finally {
    dir.remove();
  }
});
