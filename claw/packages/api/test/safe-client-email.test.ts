// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What SaFE's verification says about the account's email becomes `UserInfo.email`
 * only when it is a real, non-empty string. SaFE omits the field when the account
 * has none; a number or an empty string is not an address, and an `email: undefined`
 * key would change what a UserInfo compares equal to (the credential-path and
 * admission suites build them with a deepEqual).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SafeClient } from "../src/auth/safe-client.js";
import { sendJson, startFakeUpstream } from "./support/fake-upstream.js";

process.env.AUTH_INTERNAL_TOKEN = "internal-token-for-tests";

const ANSWERS: Record<string, Record<string, unknown>> = {
  "ak-with": { email: "with@example.com" },
  "ak-empty": { email: "" },
  "ak-number": { email: 42 },
  "ak-null": { email: null },
  "ak-absent": {},
};

test("email is carried when it is a non-empty string and the key is absent otherwise", async () => {
  const up = await startFakeUpstream((req, res) => {
    const { apiKey } = JSON.parse(req.body) as { apiKey: string };
    sendJson(res, 200, { id: "u-1", name: "One", roles: ["default"], virtualKey: "vk", platformKey: "pk", ...ANSWERS[apiKey] });
  });
  try {
    const client = new SafeClient(up.url);
    const base = { userId: "u-1", userName: "One", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
    assert.deepEqual(await client.verifyApiKey("ak-with"), { ...base, email: "with@example.com" });
    for (const key of ["ak-empty", "ak-number", "ak-null", "ak-absent"]) {
      const user = await client.verifyApiKey(key);
      assert.deepEqual(user, base, key);
      assert.equal("email" in user, false, `${key}: no email key at all`);
    }
  } finally {
    await up.close();
  }
});

test("a SaFE that answers 5xx or 2xx-not-JSON is not remembered as a refusal: the next call reaches SaFE again", async () => {
  let n = 0;
  const up = await startFakeUpstream((_req, res) => {
    n++;
    if (n === 1) return sendJson(res, 503, { error: "restarting" });
    if (n === 2) { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>a proxy page</html>"); return; }
    sendJson(res, 200, { id: "u-1", name: "One", roles: ["default"], virtualKey: "vk", platformKey: "pk" });
  });
  try {
    const client = new SafeClient(up.url);
    await assert.rejects(client.verifyApiKey("ak-good"), { name: "SafeUpstreamHttpError" });
    await assert.rejects(client.verifyApiKey("ak-good"), { name: "SafeUpstreamProtocolError" });
    assert.equal((await client.verifyApiKey("ak-good")).userId, "u-1");
    assert.equal(n, 3);
  } finally {
    await up.close();
  }
});
