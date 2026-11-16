// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** SaFE deploy mode with LLM_KEY_SOURCE=virtualKey: LLM calls use the virtual key, and SaFE's verify is asked for it. */
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.CLAW_DEPLOY_MODE;
delete process.env.CLAW_AUTH_PROVIDER;
process.env.LLM_KEY_SOURCE = "virtualKey";
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

test("an explicit LLM_KEY_SOURCE=virtualKey is kept in SaFE deploy mode", () => {
  assert.equal(config.LLM_KEY_SOURCE, "virtualKey");
});

test("SaFE's verify is asked for the platform key and the virtual key", async () => {
  const body = await verifyBodyOf(new SafeClient("http://safe.test"));
  assert.equal(body.includePlatformKey, true);
  assert.equal(body.includeVirtualKey, true);
});
