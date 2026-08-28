// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Regression tests for cross-tenant session access.
 *
 * Before this guard existed, every `/v1/sessions/:id/files*` route resolved the
 * S3 prefix from the *session's* `user_id` while only requiring that the caller
 * be authenticated, so any logged-in user could list, download, zip and upload
 * into another tenant's workspace.
 *
 * Two predicates now share that job, and the difference between them is the
 * point of these tests:
 *
 * - `canAccessSession` — strict creator-only, no admin bypass. Guards rename,
 *   send-message and delete, which are creator-only by product spec.
 * - `canAccessSessionAsOperator` — same tenant boundary, both admin roles pass.
 *   Guards session metadata, context usage, children and file read.
 * - `canWriteSessionAsOperator` — as above but refuses `system-admin-readonly`.
 *   Guards `upload` and `zip-tasks`, which write under the tenant's prefix.
 *
 * Run with the api package test runner (node:test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canAccessSession,
  canAccessSessionAsOperator,
  canWriteSessionAsOperator,
  isAdmin,
  type UserInfo,
} from "../src/auth/models.js";

function user(userId: string, roles: string[] = ["default"]): UserInfo {
  return { userId, userName: userId, roles, platformKey: "", virtualKey: "" };
}

test("canAccessSession: the creator may access their own session", () => {
  assert.equal(canAccessSession("alice", "alice"), true);
});

test("canAccessSession: another tenant is denied", () => {
  assert.equal(canAccessSession("alice", "bob"), false);
});

test("canAccessSession: an admin does NOT bypass the creator-only operations", () => {
  const admin = user("bob", ["default", "system-admin"]);
  // The role really is admin ...
  assert.equal(isAdmin(admin), true);
  // ... and it still cannot rename / message / delete another tenant's session.
  assert.equal(canAccessSession("alice", admin.userId), false);
});

test("canAccessSession: legacy rows with no owner fail closed", () => {
  assert.equal(canAccessSession(null, "alice"), false);
  assert.equal(canAccessSession(undefined, "alice"), false);
  assert.equal(canAccessSession("", "alice"), false);
});

test("canAccessSession: an unauthenticated caller cannot access an owned session", () => {
  assert.equal(canAccessSession("alice", undefined), false);
  assert.equal(canAccessSession("alice", null), false);
  assert.equal(canAccessSession("alice", ""), false);
});

test("canAccessSession: owner match is exact (no prefix/substring escape)", () => {
  assert.equal(canAccessSession("alice", "alice2"), false);
  assert.equal(canAccessSession("alice", "ALICE"), false);
  assert.equal(canAccessSession("alice", " alice"), false);
});

// --- canAccessSessionAsOperator: same boundary, admins pass ---

test("canAccessSessionAsOperator: the creator may reach their own session", () => {
  assert.equal(canAccessSessionAsOperator("alice", user("alice")), true);
});

test("canAccessSessionAsOperator: an ordinary tenant is still denied", () => {
  // The whole point of the guard: a plain logged-in user cannot cross tenants.
  assert.equal(canAccessSessionAsOperator("alice", user("bob")), false);
});

test("canAccessSessionAsOperator: both admin roles pass as operators", () => {
  assert.equal(canAccessSessionAsOperator("alice", user("bob", ["default", "system-admin"])), true);
  assert.equal(
    canAccessSessionAsOperator("alice", user("bob", ["default", "system-admin-readonly"])),
    true,
  );
});

test("operator predicates: only admins can recover an unowned legacy session", () => {
  assert.equal(canAccessSessionAsOperator(null, user("alice")), false);
  assert.equal(canAccessSessionAsOperator(null, user("admin", ["system-admin"])), true);
  assert.equal(
    canAccessSessionAsOperator(null, user("auditor", ["system-admin-readonly"])),
    true,
  );
  assert.equal(canWriteSessionAsOperator(null, user("alice")), false);
  assert.equal(canWriteSessionAsOperator(null, user("admin", ["system-admin"])), true);
  assert.equal(
    canWriteSessionAsOperator(null, user("auditor", ["system-admin-readonly"])),
    false,
  );
});

test("canAccessSessionAsOperator: an unauthenticated caller is denied", () => {
  assert.equal(canAccessSessionAsOperator("alice", null), false);
  assert.equal(canAccessSessionAsOperator("alice", undefined), false);
});

test("canAccessSessionAsOperator: a non-admin role name does not grant access", () => {
  // Guards against a substring/typo match on the role list.
  assert.equal(canAccessSessionAsOperator("alice", user("bob", ["system-admins"])), false);
  assert.equal(canAccessSessionAsOperator("alice", user("bob", ["System-Admin"])), false);
  assert.equal(canAccessSessionAsOperator("alice", user("bob", ["admin"])), false);
});

// --- canWriteSessionAsOperator: read-only admins must not write ---

test("canWriteSessionAsOperator: the creator may write to their own session", () => {
  assert.equal(canWriteSessionAsOperator("alice", user("alice")), true);
});

test("canWriteSessionAsOperator: a full system-admin may write", () => {
  assert.equal(canWriteSessionAsOperator("alice", user("bob", ["default", "system-admin"])), true);
});

test("canWriteSessionAsOperator: system-admin-readonly may read but NOT write", () => {
  const ro = user("bob", ["default", "system-admin-readonly"]);
  // It is an admin for read purposes ...
  assert.equal(canAccessSessionAsOperator("alice", ro), true);
  // ... but a role named read-only must not mutate a tenant's workspace.
  assert.equal(canWriteSessionAsOperator("alice", ro), false);
});

test("canWriteSessionAsOperator: an ordinary tenant and anonymous are denied", () => {
  assert.equal(canWriteSessionAsOperator("alice", user("bob")), false);
  assert.equal(canWriteSessionAsOperator("alice", null), false);
  assert.equal(canWriteSessionAsOperator("alice", undefined), false);
});

test("canWriteSessionAsOperator: holding both admin roles still allows writes", () => {
  // getUserRole resolves system-admin ahead of the read-only variant, so a user
  // granted both is a full admin rather than being downgraded.
  const both = user("bob", ["system-admin-readonly", "system-admin"]);
  assert.equal(canWriteSessionAsOperator("alice", both), true);
});
