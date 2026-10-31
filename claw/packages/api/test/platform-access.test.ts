// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform-role requirement (auth/platform-access.ts), as a decision table.
 *
 *   PA1  the setting is parsed as a set of exact names: separators, blanks, repeats
 *   PA2  empty means no requirement: every caller, every method, every roles list passes
 *   PA3  with a requirement, only a SaFE-verified credential whose roles include one of
 *        the names passes; a credential SaFE did not verify has unknown roles and
 *        never does, whatever roles the caller was built with
 *   PA4  the refusal is the one a client can show, and does not name a role
 *   PA5  SaFE's `roles` field is read as an array of strings and nothing else
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORM_ACCESS_MESSAGE,
  PLATFORM_ACCESS_REQUIRED,
  REQUIRED_PLATFORM_ROLES_ENV,
  platformAccessRefusal,
  requiredPlatformRoles,
  type PlatformAccessRefusalReason,
} from "../src/auth/platform-access.js";
import { SafeClient } from "../src/auth/safe-client.js";
import type { UserInfo } from "../src/auth/models.js";
import { sendJson, startFakeUpstream } from "./support/fake-upstream.js";

const userWith = (roles: string[]): UserInfo => ({ userId: "u-1", userName: "One", roles, platformKey: "", virtualKey: "" });

test("PA1: the setting is a set of exact names", () => {
  const cases: Array<[string | undefined, string[]]> = [
    [undefined, []],
    ["", []],
    ["   ", []],
    [",,", []],
    ["default", ["default"]],
    ["default,system-admin", ["default", "system-admin"]],
    [" default ,, system-admin ", ["default", "system-admin"]],
    ["default system-admin", ["default", "system-admin"]],
    ["default\n\tsystem-admin", ["default", "system-admin"]],
    ["default,default", ["default"]],
    // Compared exactly: SaFE's role names are case-sensitive, so this is a different role.
    ["Default", ["Default"]],
  ];
  for (const [raw, want] of cases) {
    assert.deepEqual(requiredPlatformRoles({ [REQUIRED_PLATFORM_ROLES_ENV]: raw }), want, JSON.stringify(raw));
  }
  assert.deepEqual(requiredPlatformRoles({}), []);
});

test("PA1: the process environment is read on each use", () => {
  const before = process.env[REQUIRED_PLATFORM_ROLES_ENV];
  try {
    delete process.env[REQUIRED_PLATFORM_ROLES_ENV];
    assert.deepEqual(requiredPlatformRoles(), []);
    process.env[REQUIRED_PLATFORM_ROLES_ENV] = "a,b";
    assert.deepEqual(requiredPlatformRoles(), ["a", "b"]);
    assert.equal(platformAccessRefusal(userWith(["c"]), "cookie")?.reason, "role_missing");
    delete process.env[REQUIRED_PLATFORM_ROLES_ENV];
    assert.equal(platformAccessRefusal(userWith(["c"]), "cookie"), null);
  } finally {
    if (before === undefined) delete process.env[REQUIRED_PLATFORM_ROLES_ENV];
    else process.env[REQUIRED_PLATFORM_ROLES_ENV] = before;
  }
});

const SAFE_METHODS = ["cookie", "query_token", "api_key", "x_api_key"];
const OTHER_METHODS = ["identity_token", "connector_token", "byok", "", "something_new"];

test("PA2: with no requirement nobody is refused, whatever the method or roles", () => {
  for (const method of [...SAFE_METHODS, ...OTHER_METHODS]) {
    for (const roles of [[], ["default"], ["pending"], ["system-admin"], ["x", "y"]]) {
      assert.equal(platformAccessRefusal(userWith(roles), method, []), null, `${method} ${JSON.stringify(roles)}`);
    }
  }
});

type Row = { required: string[]; roles: string[]; method: string; want: PlatformAccessRefusalReason | null };

test("PA3: a requirement is met by a role SaFE reported, and only by that", () => {
  const rows: Row[] = [];
  for (const method of SAFE_METHODS) {
    rows.push(
      { required: ["default"], roles: ["default"], method, want: null },
      { required: ["default"], roles: ["default", "system-admin"], method, want: null },
      { required: ["default"], roles: ["pending"], method, want: "role_missing" },
      { required: ["default"], roles: [], method, want: "role_missing" },
      // Any one of the named roles is enough.
      { required: ["default", "system-admin"], roles: ["system-admin"], method, want: null },
      { required: ["default", "system-admin"], roles: ["pending", "other"], method, want: "role_missing" },
      // Exact names: neither a prefix, a longer name nor another case is the role.
      { required: ["default"], roles: ["default-readonly"], method, want: "role_missing" },
      { required: ["default"], roles: ["Default"], method, want: "role_missing" },
      { required: ["default"], roles: ["def"], method, want: "role_missing" },
      // A role SaFE has not defined matches nobody, and is not an error.
      { required: ["no-such-role"], roles: ["default", "system-admin"], method, want: "role_missing" },
    );
  }
  for (const method of OTHER_METHODS) {
    rows.push(
      // The `default` these paths give their caller is Claw's marker, not SaFE's word.
      { required: ["default"], roles: ["default"], method, want: "roles_unknown" },
      // Not even a role the provider confirmed (identity-token.ts adopts system-admin) is SaFE's report.
      { required: ["system-admin"], roles: ["default", "system-admin"], method, want: "roles_unknown" },
      { required: ["default", "system-admin"], roles: ["default", "system-admin"], method, want: "roles_unknown" },
    );
  }
  for (const r of rows) {
    const got = platformAccessRefusal(userWith(r.roles), r.method, r.required);
    assert.equal(got === null ? null : got.reason, r.want, JSON.stringify(r));
  }
});

test("PA4: the refusal is a 403 a client can recognise, and says nothing about roles", () => {
  const refusal = platformAccessRefusal(userWith(["pending"]), "cookie", ["secret-role-name"]);
  assert.ok(refusal);
  assert.equal(refusal.status, 403);
  assert.equal(refusal.legacyError, "platform_access_required");
  assert.equal(PLATFORM_ACCESS_REQUIRED, "platform_access_required");
  assert.equal(refusal.anthropicType, "permission_error");
  assert.equal(refusal.message, PLATFORM_ACCESS_MESSAGE);
  assert.equal(refusal.message, "no access yet - ask an administrator");
  for (const text of [refusal.message, refusal.legacyError]) {
    assert.equal(text.includes("secret-role-name"), false);
    assert.equal(text.includes("pending"), false);
  }
});

test("PA5: SaFE's roles field counts only as an array of strings", async () => {
  const answers: Record<string, unknown> = {
    "ak-array": ["default", "other"],
    "ak-mixed": ["default", 7, null, { r: "x" }],
    "ak-absent": undefined,
    "ak-null": null,
    "ak-string": "default",
    "ak-object": { default: true },
    "ak-number": 1,
    "ak-empty": [],
  };
  const up = await startFakeUpstream((req, res) => {
    const { apiKey } = JSON.parse(req.body) as { apiKey: string };
    const roles = answers[apiKey];
    sendJson(res, 200, { id: "u-1", name: "One", ...(roles !== undefined ? { roles } : {}), virtualKey: "vk", platformKey: "pk" });
  });
  process.env.AUTH_INTERNAL_TOKEN = "internal-token-for-tests";
  try {
    const client = new SafeClient(up.url);
    const want: Record<string, string[]> = {
      "ak-array": ["default", "other"],
      "ak-mixed": ["default"],
      "ak-absent": [],
      "ak-null": [],
      "ak-string": [],
      "ak-object": [],
      "ak-number": [],
      "ak-empty": [],
    };
    for (const [key, roles] of Object.entries(want)) {
      assert.deepEqual((await client.verifyApiKey(key)).roles, roles, key);
    }
    // And the requirement refuses every one that came back with none of the named role.
    const required = ["default"];
    for (const key of ["ak-absent", "ak-null", "ak-string", "ak-object", "ak-number", "ak-empty"]) {
      assert.equal(platformAccessRefusal(await client.verifyApiKey(key), "api_key", required)?.reason, "role_missing", key);
    }
    assert.equal(platformAccessRefusal(await client.verifyApiKey("ak-array"), "api_key", required), null);
  } finally {
    await up.close();
  }
});
