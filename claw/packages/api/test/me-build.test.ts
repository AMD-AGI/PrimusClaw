// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `buildMe`: the rules that turn SaFE's three answers into the `/v1/me` document,
 * one table row per rule. The route test shows the wiring; these show the rules
 * are the right ones, each with the nearest input that would flip it.
 *
 * The sandbox rules are the web client's (`stores/workspace.ts`, the router's
 * cluster guard) restated, so a row here is a statement about what a user sees.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildMe } from "../src/routes/me.js";

const USER = { userId: "u-1", userName: "One", roles: ["default"] };
const ws = (workspaceId: string, extra: Record<string, unknown> = {}) => ({ workspaceId, workspaceName: workspaceId.toUpperCase(), scopes: ["Train"], ...extra });
const list = (...items: unknown[]) => ({ totalCount: items.length, items });
const READY = list({ clusterId: "c", phase: "Ready" });
const NONE_MANAGED = { managedWorkspaces: [] };

test("sandbox.available needs a Ready cluster AND a Sandbox workspace", () => {
  const sandboxWs = list(ws("w", { scopes: ["Sandbox"] }));
  const trainWs = list(ws("w", { scopes: ["Train"] }));
  const creating = list({ clusterId: "c", phase: "Creating" });
  const rows: [string, unknown, unknown, boolean][] = [
    ["ready + sandbox", sandboxWs, READY, true],
    ["ready + no sandbox scope", trainWs, READY, false],
    ["sandbox but no cluster is Ready", sandboxWs, creating, false],
    ["sandbox but no clusters", sandboxWs, list(), false],
    ["no workspaces, ready cluster", list(), READY, false],
    ["one Ready among several", sandboxWs, list({ phase: "Failed" }, { phase: "Ready" }, { phase: "Deleting" }), true],
    ["phase is matched exactly", sandboxWs, list({ phase: "ready" }, { phase: "NotReady" }), false],
  ];
  for (const [name, w, c, available] of rows) {
    assert.equal(buildMe(USER, w, c, NONE_MANAGED)?.sandbox.available, available, name);
  }
});

test("the default workspace is the first Sandbox workspace in SaFE's order", () => {
  const me = buildMe(
    USER,
    list(
      ws("a-train", { scopes: ["Train"] }),
      ws("b-sandbox", { scopes: ["Train", "Sandbox"], gpuProduct: "MI300X" }),
      ws("c-sandbox", { scopes: ["Sandbox"], gpuProduct: "MI325X" }),
    ),
    READY,
    NONE_MANAGED,
  );
  assert.deepEqual(me?.sandbox, { available: true, defaultWorkspaceId: "b-sandbox", gpuProduct: "MI300X" });
});

test("a default workspace is named whenever a Sandbox workspace exists, available or not", () => {
  const me = buildMe(USER, list(ws("w", { scopes: ["Sandbox"] })), list(), NONE_MANAGED);
  assert.deepEqual(me?.sandbox, { available: false, defaultWorkspaceId: "w" });
});

test("no Sandbox workspace names no default and no GPU product", () => {
  const me = buildMe(USER, list(ws("w", { gpuProduct: "MI300X" })), READY, NONE_MANAGED);
  assert.deepEqual(me?.sandbox, { available: false });
});

test("admin is membership in managedWorkspaces, per workspace", () => {
  const me = buildMe(
    USER,
    list(ws("w1"), ws("w2"), ws("w3")),
    READY,
    { managedWorkspaces: [{ id: "w2" }, { id: "not-listed" }, { name: "no id" }, null] },
  );
  assert.deepEqual(me?.workspaces.map((w) => [w.id, w.admin]), [["w1", false], ["w2", true], ["w3", false]]);
});

test("system admin roles are reported in roles and do not make workspaces admin", () => {
  const me = buildMe({ ...USER, roles: ["system-admin"] }, list(ws("w1")), READY, NONE_MANAGED);
  assert.deepEqual(me?.roles, ["system-admin"]);
  assert.equal(me?.workspaces[0].admin, false);
});

test("optional fields are omitted when absent or empty, and kept when false", () => {
  const me = buildMe(
    USER,
    list(
      { workspaceId: "bare" },
      { workspaceId: "empties", workspaceName: "", scopes: "nope", gpuProduct: "", flavorId: "", clusterId: "", isDefault: "yes" },
      ws("flags", { isDefault: false, flavorId: "f", clusterId: "c", gpuProduct: "G" }),
    ),
    READY,
    NONE_MANAGED,
  );
  assert.deepEqual(me?.workspaces, [
    { id: "bare", name: "bare", scopes: [], admin: false },
    { id: "empties", name: "empties", scopes: [], admin: false },
    { id: "flags", name: "FLAGS", scopes: ["Train"], flavorId: "f", clusterId: "c", gpuProduct: "G", isDefault: false, admin: false },
  ]);
});

test("a field of the wrong type is treated as absent, not coerced", () => {
  const me = buildMe(
    USER,
    list({ workspaceId: 7 }, { workspaceId: "n", workspaceName: 5, gpuProduct: 5, flavorId: {}, clusterId: ["c"] }),
    READY,
    { managedWorkspaces: [{ id: 7 }, { id: "n" }] },
  );
  assert.deepEqual(me?.workspaces, [{ id: "n", name: "n", scopes: [], admin: true }]);
});

test("scopes keep strings only, in order", () => {
  const me = buildMe(USER, list(ws("w", { scopes: ["Train", 3, null, "Sandbox", {}] })), READY, NONE_MANAGED);
  assert.deepEqual(me?.workspaces[0].scopes, ["Train", "Sandbox"]);
});

test("entries without a workspace id are skipped", () => {
  const me = buildMe(USER, list({ workspaceName: "orphan" }, ws("w"), { workspaceId: "" }, 7, null, []), READY, NONE_MANAGED);
  assert.deepEqual(me?.workspaces.map((w) => w.id), ["w"]);
});

test("identity: email is included when present and omitted when absent or empty", () => {
  const withEmail = buildMe({ ...USER, email: "one@example.com" }, list(), READY, NONE_MANAGED);
  assert.equal(withEmail?.email, "one@example.com");
  for (const email of [undefined, ""]) {
    const me = buildMe({ ...USER, email }, list(), READY, NONE_MANAGED);
    assert.equal(me !== null && "email" in me, false, `email ${JSON.stringify(email)}`);
  }
});

test("identity: name is omitted when empty, roles are a copy", () => {
  const roles = ["default"];
  const me = buildMe({ userId: "u", userName: "", roles }, list(), READY, NONE_MANAGED);
  assert.deepEqual(Object.keys(me ?? {}).sort(), ["roles", "sandbox", "userId", "workspaces"]);
  assert.notEqual(me?.roles, roles);
  roles.push("later");
  assert.deepEqual(me?.roles, ["default"]);
});

test("null items and a null managedWorkspaces are empty lists, as SaFE sends them", () => {
  const me = buildMe(USER, { totalCount: 0, items: null }, { items: null }, { managedWorkspaces: null });
  assert.deepEqual(me, { userId: "u-1", name: "One", roles: ["default"], sandbox: { available: false }, workspaces: [] });
  assert.deepEqual(buildMe(USER, {}, {}, {})?.workspaces, []);
});

test("an answer that is not the documented shape is refused, not guessed at", () => {
  const ok = [list(), READY, NONE_MANAGED] as const;
  const rows: [string, [unknown, unknown, unknown]][] = [
    ["workspaces is an array", [[], ok[1], ok[2]]],
    ["workspaces is null", [null, ok[1], ok[2]]],
    ["workspaces items is a string", [{ items: "x" }, ok[1], ok[2]]],
    ["workspaces items is an object", [{ items: {} }, ok[1], ok[2]]],
    ["clusters is a string", [ok[0], "x", ok[2]]],
    ["clusters items is a number", [ok[0], { items: 3 }, ok[2]]],
    ["user record is null", [ok[0], ok[1], null]],
    ["user record is an array", [ok[0], ok[1], []]],
    ["managedWorkspaces is a string", [ok[0], ok[1], { managedWorkspaces: "w" }]],
    ["managedWorkspaces is an object", [ok[0], ok[1], { managedWorkspaces: {} }]],
  ];
  for (const [name, [w, c, u]] of rows) assert.equal(buildMe(USER, w, c, u), null, name);
});
