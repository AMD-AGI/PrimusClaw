// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import type { UserInfo } from "../src/auth/models.js";
import { canExecuteTaskDag, canReadTaskDag } from "../src/tasks/dags/authz.js";

function user(userId: string, roles: string[] = ["default"]): UserInfo {
  return { userId, userName: userId, roles, platformKey: "", virtualKey: "" };
}

const publicDag = { owner_user_id: "alice", is_public: true };
const privateDag = { owner_user_id: "alice", is_public: false };
const unownedDag = { owner_user_id: null, is_public: false };

test("public DAGs are readable and executable by authenticated tenants", () => {
  assert.equal(canReadTaskDag(publicDag, user("bob")), true);
  assert.equal(canExecuteTaskDag(publicDag, user("bob")), true);
});

test("private DAG owner can read and execute", () => {
  assert.equal(canReadTaskDag(privateDag, user("alice")), true);
  assert.equal(canExecuteTaskDag(privateDag, user("alice")), true);
});

test("ordinary non-owner cannot read or execute a private DAG", () => {
  assert.equal(canReadTaskDag(privateDag, user("bob")), false);
  assert.equal(canExecuteTaskDag(privateDag, user("bob")), false);
});

test("readonly admin may inspect but cannot execute cross-tenant DAGs", () => {
  const auditor = user("auditor", ["system-admin-readonly"]);
  assert.equal(canReadTaskDag(privateDag, auditor), true);
  assert.equal(canExecuteTaskDag(privateDag, auditor), false);
});

test("full admin may read, execute, and recover unowned private DAGs", () => {
  const admin = user("admin", ["system-admin"]);
  assert.equal(canReadTaskDag(privateDag, admin), true);
  assert.equal(canExecuteTaskDag(privateDag, admin), true);
  assert.equal(canReadTaskDag(unownedDag, admin), true);
  assert.equal(canExecuteTaskDag(unownedDag, admin), true);
});

test("unowned private DAGs fail closed for ordinary and readonly callers", () => {
  assert.equal(canReadTaskDag(unownedDag, user("bob")), false);
  assert.equal(canExecuteTaskDag(unownedDag, user("bob")), false);
  assert.equal(canExecuteTaskDag(unownedDag, user("auditor", ["system-admin-readonly"])), false);
});
