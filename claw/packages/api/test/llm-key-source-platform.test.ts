// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SaFE deploy mode with LLM_KEY_SOURCE=platformKey: LLM calls use the platform key, and SaFE's verify is still asked
 * for the virtual key, as in every mode: that request is also what makes SaFE report the email of an `ak-` key's owner.
 */
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.CLAW_DEPLOY_MODE;
delete process.env.CLAW_AUTH_PROVIDER;
process.env.LLM_KEY_SOURCE = "platformKey";
process.env.APP_ENV = "production";
process.env.AUTH_INTERNAL_TOKEN = "test-internal-token";

const config = await import("../src/config.js");
const { SafeClient } = await import("../src/auth/safe-client.js");

/** The body SafeClient sends to SaFE's verify for an API key. */
async function verifyBodyOf(client: InstanceType<typeof SafeClient>): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "u-1", name: "u", platformKey: "ak-u-1" }), { status: 200 });
  }) as typeof fetch;
  try {
    await client.verifyApiKey("ak-u-1");
  } finally {
    globalThis.fetch = original;
  }
  return body;
}

test("an explicit LLM_KEY_SOURCE=platformKey is kept in SaFE deploy mode", () => {
  assert.equal(config.LLM_KEY_SOURCE, "platformKey");
});

test("SaFE's verify is asked for both keys, so it reports the owner's email", async () => {
  const body = await verifyBodyOf(new SafeClient("http://safe.test"));
  assert.equal(body.includePlatformKey, true);
  assert.equal(body.includeVirtualKey, true);
});
