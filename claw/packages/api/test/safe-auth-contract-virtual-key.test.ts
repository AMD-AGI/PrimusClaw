// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SaFE deploy mode with CLAW_AUTH_PROVIDER unset and LLM_KEY_SOURCE=virtualKey: every
 * credential SaFE verifies gives the same request user and the same `GET /v1/me` as claw-v0.5.8 did, field for field
 * (email, name, id, roles, platform and virtual key), and SaFE is asked the same question. The expected values were
 * recorded from the claw-v0.5.8 code; see support/safe-auth-contract.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.CLAW_DEPLOY_MODE;
delete process.env.CLAW_AUTH_PROVIDER;
delete process.env.CLAW_INSECURE_DEV_AUTH;
delete process.env.CLAW_PLATFORM_ACCESS_ROLES;
delete process.env.SANDBOX_CPU_NAMESPACE;
process.env.SANDBOX_NAMESPACE = "ws-sandbox";
process.env.LLM_KEY_SOURCE = "virtualKey";
process.env.APP_ENV = "production";

const { runContract, expectedOrRecord, CONTRACT_CASES } = await import("./support/safe-auth-contract.js");

const observed = await runContract();
const expected = expectedOrRecord("virtualKey", observed);

for (const c of CONTRACT_CASES) {
  test(`${c.name}: SaFE is asked what 0.5.8 asked`, () => {
    assert.deepEqual(observed.cases[c.name].verifyRequests, expected.cases[c.name].verifyRequests);
  });
  test(`${c.name}: the request user is 0.5.8's, field for field`, () => {
    assert.deepEqual(observed.cases[c.name].user, expected.cases[c.name].user);
  });
  test(`${c.name}: GET /v1/me is 0.5.8's, field for field`, () => {
    assert.deepEqual(observed.cases[c.name].me, expected.cases[c.name].me);
  });
}

for (const name of Object.keys(expected.client)) {
  test(`SafeClient.${name}: same verify request and same UserInfo as 0.5.8`, () => {
    assert.deepEqual(observed.client[name], expected.client[name]);
  });
}

test("the recorded outcome is the one a SaFE-verified caller with an email on record had: the email is there", () => {
  const user = expected.cases["bearer ak- key, user with email"].user.body as { email?: string };
  const me = expected.cases["bearer ak- key, user with email"].me.body as { email?: string };
  assert.equal(user.email, "eval-bot@example.invalid");
  assert.equal(me.email, "eval-bot@example.invalid");
});
