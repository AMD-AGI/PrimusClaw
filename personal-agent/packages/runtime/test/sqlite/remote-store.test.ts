// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What the store remembers about remote agents: where a chat is attached, how far it has read, and the permission cards
// it showed (Python: test_remote_store.py, its store tests).
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { RemoteAttachment, StorePort } from "@primusclaw/personal-agent";
import { Fernet, SqliteStore } from "@primusclaw/personal-agent-runtime";

import { advanceSeconds, openFileTestStore, openTestStore, tempDir } from "../../../../test-support/index.js";

const BASE: RemoteAttachment = {
  sessionId: "s1",
  connectorId: "c1",
  agentId: "codex",
  agentLabel: "⬛ Codex",
  host: "dev-pod",
  cwd: "/repo",
};

function attach(store: StorePort, who = "aad-a", sessionId = "s1", cursor = ""): void {
  store.remoteState.attachRemote(who, { ...BASE, sessionId, cursor });
}

test("a chat is attached to one session, and detaching forgets where it was", () => {
  const { store } = openTestStore();
  const remote = store.remoteState;
  assert.equal(remote.getRemote("aad-a"), null);
  assert.equal(remote.attachedRemote("aad-a"), null);
  attach(store, "aad-a", "s1", "7");
  const state = remote.attachedRemote("aad-a");
  assert.deepEqual(
    [state?.sessionId, state?.connectorId, state?.agentId, state?.agentLabel, state?.host, state?.cwd, state?.cursor],
    ["s1", "c1", "codex", "⬛ Codex", "dev-pod", "/repo", "7"],
  );
  assert.equal(state?.turnOpen, false);
  assert.deepEqual([state.modes, state.listing], [[], []]);
  attach(store, "aad-a", "s2");
  assert.deepEqual([remote.attachedRemote("aad-a")?.sessionId, remote.attachedRemote("aad-a")?.cursor], ["s2", ""]);
  remote.detachRemote("aad-a");
  assert.equal(remote.attachedRemote("aad-a"), null);
  assert.equal(remote.getRemote("aad-a")?.cursor, "");
  assert.equal(remote.attachedRemote("aad-b"), null);
  assert.deepEqual(remote.remoteAttachedUsers(), []);
});

test("the read position only moves forward, and only for the attached session", () => {
  const { store } = openTestStore();
  attach(store);
  for (const [write, expected] of [
    ["5", "5"],
    ["3", "5"],
    ["5", "5"],
    ["12", "12"],
    ["9", "12"],
    ["x", "12"],
    ["", "12"],
    ["-1", "12"],
  ] as const) {
    store.remoteState.setRemoteCursor("aad-a", "s1", write);
    assert.equal(store.remoteState.getRemote("aad-a")?.cursor, expected, write);
  }
  store.remoteState.setRemoteCursor("aad-a", "some-other-session", "99");
  assert.equal(store.remoteState.getRemote("aad-a")?.cursor, "12");
  store.remoteState.setRemoteCursor("aad-b", "s1", "99");
  assert.equal(store.remoteState.getRemote("aad-b"), null);
});

test("ids compare as numbers, not as text", () => {
  const { store } = openTestStore();
  attach(store, "aad-a", "s1", "9");
  store.remoteState.setRemoteCursor("aad-a", "s1", "10");
  assert.equal(store.remoteState.getRemote("aad-a")?.cursor, "10");
});

test("an open turn and the modes belong to the session", () => {
  const { store } = openTestStore();
  const remote = store.remoteState;
  attach(store);
  remote.setRemoteTurn("aad-a", "s1", true);
  remote.setRemoteModes("aad-a", "s1", { mode: "plan", modes: ["default", "plan"] });
  let state = remote.getRemote("aad-a");
  assert.equal(state?.turnOpen, true);
  assert.deepEqual([state.mode, state.modes], ["plan", ["default", "plan"]]);
  remote.setRemoteModes("aad-a", "s1", { mode: "default", modes: null });
  state = remote.getRemote("aad-a");
  assert.deepEqual([state?.mode, state?.modes], ["default", ["default", "plan"]]);
  remote.setRemoteTurn("aad-a", "other", false);
  remote.setRemoteModes("aad-a", "other", { mode: "x", modes: ["x"] });
  assert.deepEqual([remote.getRemote("aad-a")?.turnOpen, remote.getRemote("aad-a")?.mode], [true, "default"]);
  remote.detachRemote("aad-a");
  assert.equal(remote.getRemote("aad-a")?.turnOpen, false);
});

test("the listing survives attaching and detaching", () => {
  const { store } = openTestStore();
  const remote = store.remoteState;
  remote.setRemoteListing("aad-a", ["s9", "s8"]);
  assert.deepEqual(remote.getRemote("aad-a")?.listing, ["s9", "s8"]);
  assert.equal(remote.attachedRemote("aad-a"), null);
  attach(store);
  assert.deepEqual(remote.getRemote("aad-a")?.listing, ["s9", "s8"]);
  remote.detachRemote("aad-a");
  remote.setRemoteListing("aad-a", ["s1"]);
  assert.deepEqual(remote.getRemote("aad-a")?.listing, ["s1"]);
});

test("a permission row is written once and closed by one caller", () => {
  const { store } = openTestStore();
  const perms = store.remotePermissions;
  const options = [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }];
  const now = store.now();
  const row = { userId: "aad-a", sessionId: "s1", actionId: "act-1", tool: "Edit", options };
  assert.equal(perms.saveRemotePermission({ ...row, expiresAt: now + 600 }), true);
  assert.equal(perms.saveRemotePermission({ ...row, expiresAt: now + 999 }), false);
  const perm = perms.getRemotePermission("s1", "act-1");
  assert.deepEqual(
    [perm?.userId, perm?.tool, perm?.options, perm?.expiresAt, perm?.state],
    ["aad-a", "Edit", options, now + 600, "pending"],
  );
  assert.equal(perms.closeRemotePermission("s1", "act-1", "sending"), true);
  assert.equal(perms.closeRemotePermission("s1", "act-1", "sending"), false);
  assert.equal(perms.closeRemotePermission("s1", "act-1", "pending", { onlyIfPending: false }), true);
  assert.equal(perms.getRemotePermission("s1", "act-1")?.state, "pending");
  assert.equal(perms.getRemotePermission("s1", "act-2"), null);
  assert.equal(perms.getRemotePermission("s2", "act-1"), null);
  assert.deepEqual(
    perms.pendingRemotePermissions("aad-a", "s1").map((p) => p.actionId),
    ["act-1"],
  );
  perms.forgetRemotePermission("s1", "act-1");
  assert.equal(perms.getRemotePermission("s1", "act-1"), null);
});

test("the sessions waiting for a person are those with an open approval card of theirs", () => {
  const { store, clock } = openTestStore();
  const perms = store.remotePermissions;
  const now = store.now();
  const save = (userId: string, sessionId: string, actionId: string, expiresAt: number): void => {
    perms.saveRemotePermission({ userId, sessionId, actionId, tool: "Edit", options: [], expiresAt });
  };
  save("aad-a", "s1", "a1", now + 600);
  save("aad-a", "s1", "a2", now + 600);
  save("aad-a", "s2", "a1", now + 600);
  save("aad-a", "s3", "a1", now + 5);
  save("aad-b", "sb", "a1", now + 600);
  assert.deepEqual(perms.waitingRemoteSessions("aad-a"), new Set(["s1", "s2", "s3"]));
  assert.ok(perms.closeRemotePermission("s2", "a1", "allowed"));
  advanceSeconds(clock, 10);
  assert.deepEqual(perms.waitingRemoteSessions("aad-a"), new Set(["s1"]));
  assert.deepEqual(perms.waitingRemoteSessions("aad-b"), new Set(["sb"]));
  assert.deepEqual(perms.waitingRemoteSessions("aad-c"), new Set());
});

test("an old permission row is dropped after a week", () => {
  const { store, clock } = openTestStore();
  const save = (actionId: string): boolean =>
    store.remotePermissions.saveRemotePermission({
      userId: "aad-a",
      sessionId: "s1",
      actionId,
      tool: "x",
      options: [],
      expiresAt: store.now() + 10,
    });
  save("old");
  advanceSeconds(clock, 8 * 24 * 3600);
  save("new");
  assert.equal(store.remotePermissions.getRemotePermission("s1", "old"), null);
  assert.notEqual(store.remotePermissions.getRemotePermission("s1", "new"), null);
});

test("unlinking forgets the attachment and the cards, and the group chats bound to them", () => {
  const { store } = openTestStore();
  attach(store);
  attach(store, "aad-b", "sb");
  attach(store, "aad-a#group-1", "sg");
  for (const [userId, sessionId] of [
    ["aad-a", "s1"],
    ["aad-b", "sb"],
    ["aad-a#group-1", "sg"],
  ] as const) {
    store.remotePermissions.saveRemotePermission({
      userId,
      sessionId,
      actionId: "a",
      tool: "x",
      options: [],
      expiresAt: store.now() + 10,
    });
  }
  store.links.unlink("aad-a");
  assert.equal(store.remoteState.getRemote("aad-a"), null);
  assert.equal(store.remotePermissions.getRemotePermission("s1", "a"), null);
  assert.equal(store.remoteState.getRemote("aad-a#group-1"), null);
  assert.equal(store.remotePermissions.getRemotePermission("sg", "a"), null);
  assert.notEqual(store.remoteState.attachedRemote("aad-b"), null);
  assert.notEqual(store.remotePermissions.getRemotePermission("sb", "a"), null);
});

test("a database made before remote agents gets the tables on start, and keeps them over a restart", () => {
  const dir = tempDir();
  try {
    const path = join(dir.path, "old.db");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE links (aad_id TEXT PRIMARY KEY, name TEXT NOT NULL, key_enc BLOB NOT NULL, created_at REAL NOT NULL)",
    );
    db.close();
    const key = Fernet.generateKey();
    const store = new SqliteStore({ path, encryptionKeys: [key] });
    attach(store);
    assert.equal(store.remoteState.attachedRemote("aad-a")?.sessionId, "s1");
    store.close();
    const again = new SqliteStore({ path, encryptionKeys: [key] });
    assert.equal(again.remoteState.attachedRemote("aad-a")?.sessionId, "s1");
    again.close();
  } finally {
    dir.remove();
  }
});

test("what the agent said about asking is kept apart from not having said", () => {
  const { store } = openTestStore();
  const remote = store.remoteState;
  attach(store);
  let state = remote.attachedRemote("aad-a");
  assert.deepEqual([state?.unattended, state?.modeFlags], [null, {}]);
  remote.setRemoteModes("aad-a", "s1", {
    mode: "default",
    modes: ["default", "bypass"],
    unattended: false,
    modeFlags: { default: false, bypass: true },
  });
  state = remote.attachedRemote("aad-a");
  assert.deepEqual([state?.unattended, state?.modeFlags], [false, { default: false, bypass: true }]);
  remote.setRemoteModes("aad-a", "s1", { mode: "bypass", unattended: true });
  state = remote.attachedRemote("aad-a");
  assert.deepEqual(
    [state?.mode, state?.unattended, state?.modeFlags],
    ["bypass", true, { default: false, bypass: true }],
  );
  remote.setRemoteModes("aad-a", "s1", { mode: "plan", unattended: null, modeFlags: null });
  assert.equal(remote.attachedRemote("aad-a")?.unattended, true);
  remote.setRemoteModes("aad-a", "other-session", { unattended: false, modeFlags: { x: true } });
  assert.deepEqual(
    [remote.attachedRemote("aad-a")?.unattended, remote.attachedRemote("aad-a")?.modeFlags],
    [true, { default: false, bypass: true }],
  );
  remote.attachRemote("aad-a", {
    ...BASE,
    sessionId: "s2",
    mode: "plan",
    modes: ["plan"],
    unattended: true,
    modeFlags: { plan: false },
  });
  assert.deepEqual(
    [remote.attachedRemote("aad-a")?.unattended, remote.attachedRemote("aad-a")?.modeFlags],
    [true, { plan: false }],
  );
  attach(store, "aad-a", "s3");
  assert.deepEqual([remote.attachedRemote("aad-a")?.unattended, remote.attachedRemote("aad-a")?.modeFlags], [null, {}]);
});

test("a database from before the unattended columns gets them and keeps its rows", () => {
  const f = openFileTestStore();
  try {
    f.store.remoteState.attachRemote("aad-a", { ...BASE, cursor: "7", mode: "default", modes: ["default"] });
    f.store.close();
    f.raw.exec(`
        ALTER TABLE remote_state RENAME TO remote_state_new;
        CREATE TABLE remote_state (aad_id TEXT PRIMARY KEY, session_id TEXT, connector_id TEXT NOT NULL DEFAULT '',
          agent_id TEXT NOT NULL DEFAULT '', agent_label TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL DEFAULT '', cursor TEXT NOT NULL DEFAULT '', turn_open INTEGER NOT NULL DEFAULT 0,
          mode TEXT NOT NULL DEFAULT '', modes_json TEXT NOT NULL DEFAULT '[]', listing_json TEXT NOT NULL DEFAULT '[]',
          updated_at REAL NOT NULL);
        INSERT INTO remote_state SELECT aad_id, session_id, connector_id, agent_id, agent_label, host, cwd, cursor, turn_open, mode,
          modes_json, listing_json, updated_at FROM remote_state_new;
        DROP TABLE remote_state_new;
    `);
    const store = f.reopen();
    const state = store.remoteState.attachedRemote("aad-a");
    assert.deepEqual([state?.sessionId, state?.cursor, state?.mode, state?.modes], ["s1", "7", "default", ["default"]]);
    assert.deepEqual([state?.unattended, state?.modeFlags], [null, {}]);
    store.remoteState.setRemoteModes("aad-a", "s1", { unattended: true, modeFlags: { default: false } });
    assert.equal(store.remoteState.attachedRemote("aad-a")?.unattended, true);
  } finally {
    f.close();
  }
});

test("the chat box, the status card and the replaced session cards of an attachment", () => {
  const { store } = openTestStore();
  const remote = store.remoteState;
  remote.setRemoteStatusCard("aad-a", "status-1");
  remote.attachRemote("aad-a", { ...BASE, window: "card" });
  let state = remote.attachedRemote("aad-a");
  assert.deepEqual([state?.statusCard, state?.window, state?.attachedAt], ["status-1", "card", store.now()]);
  remote.setRemoteWindow("aad-a", "nonsense");
  assert.equal(remote.getRemote("aad-a")?.window, "card");
  remote.setRemoteWindow("aad-a", "chat");
  assert.equal(remote.getRemote("aad-a")?.window, "chat");
  for (const id of ["c1", "c2", "c1", "", "c3"]) remote.noteWindowCard("aad-a", id, 2);
  assert.deepEqual(remote.getRemote("aad-a")?.windowCards, ["c1", "c3"]);
  for (let i = 0; i < 10; i++) remote.noteWindowCard("aad-a", `w${String(i)}`);
  assert.equal(remote.getRemote("aad-a")?.windowCards.length, 8);
  remote.attachRemote("aad-a", { ...BASE, window: "other", conversation: "Fix it", conversationRef: "ref-1" });
  state = remote.getRemote("aad-a");
  assert.deepEqual(
    [state?.window, state?.windowCards, state?.conversation, state?.conversationRef],
    ["chat", [], "Fix it", "ref-1"],
  );
  assert.deepEqual(remote.remoteAttachedUsers(), ["aad-a"]);
});

test("names of the remote sessions a chat started: a title is given once, an acp id when said", () => {
  const { store } = openTestStore();
  const names = store.remoteSessionNames;
  names.nameRemoteSession("aad-a", "s1");
  names.nameRemoteSession("aad-a", "s2", { title: "Taken over", conversationRef: "conv-2" });
  names.nameRemoteSession("aad-b", "s3");
  names.titleRemoteSession("s1", "first words");
  names.titleRemoteSession("s1", "later words");
  names.titleRemoteSession("s2", "not this");
  names.setRemoteSessionAcp("s1", "acp-1");
  assert.deepEqual(
    names.remoteSessionNames("aad-a"),
    new Map([
      ["s1", { title: "first words", conversationRef: "" }],
      ["s2", { title: "Taken over", conversationRef: "conv-2" }],
    ]),
  );
  assert.deepEqual(names.remoteSessionAcps("aad-a"), new Map([["s1", "acp-1"]]));
  assert.deepEqual(names.remoteSessionAcps("aad-b"), new Map());
});
