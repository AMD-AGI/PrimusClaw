// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Connector access tokens with remote agents left off, which is the default, and
 * the table of which routes are connector-side. Needs no database.
 *
 * `CLAW_REMOTE_AGENTS_ENABLED` is read once when the config loads, so the flag
 * being off is a property of this process, and this file must never turn it on.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";

const nowSec = () => Math.floor(Date.now() / 1000);

describe("connector access tokens, remote agents off", () => {
  let fake: FakeIdentity;
  let token = "";

  before(async () => {
    delete process.env.CLAW_REMOTE_AGENTS_ENABLED;
    fake = await FakeIdentity.start();
    const es = testKey("ES256", "k1");
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    token = signJwt({
      key: es,
      claims: { iss: fake.issuer, aud: "claw-api", sub: "u1", scope: "claw.connector", jti: randomUUID(), exp: nowSec() + 300 },
    });
    Object.assign(process.env, {
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
    });
    const { startIdentityClient, identityClient } = await import("../src/auth/identity.js");
    startIdentityClient({ info() {}, warn() {}, error() {} });
    assert.ok(identityClient(), "the identity client is on, so only the remote agents flag can be what abstains");
    // The client reads discovery and keys in the background when it starts.
    await new Promise((r) => setTimeout(r, 200));
  });
  after(async () => { await fake?.close(); });

  test("a valid token on a connector route is not looked at: the request is judged as it was before", async () => {
    const { verifyConnectorToken } = await import("../src/auth/connector-token.js");
    const asked = fake.requests.length;
    const out = await verifyConnectorToken(
      { method: "POST", headers: { authorization: `Bearer ${token}` } } as any, "/v1/remote-agents/connectors",
    );
    assert.deepEqual(out, { status: "absent" });
    assert.equal(fake.requests.length, asked, "the provider was not asked anything");
  });

  test("the flag is read from the process, and it is off here", async () => {
    const { CLAW_REMOTE_AGENTS_ENABLED } = await import("../src/config.js");
    assert.equal(CLAW_REMOTE_AGENTS_ENABLED, false);
  });
});

describe("which routes are connector-side", () => {
  const CID = "6f1c1b53-7a55-4b1f-9a52-5a8e1f2c9d10";
  const table: Array<[string, string, boolean]> = [
    ["POST", "/v1/remote-agents/connectors", true],
    ["POST", `/v1/remote-agents/connectors/${CID}/heartbeat`, true],
    ["POST", `/v1/remote-agents/connectors/${CID}/events`, true],
    ["GET", `/v1/remote-agents/connectors/${CID}/commands`, true],
    // The user's half, and near misses of the connector's.
    ["GET", "/v1/remote-agents/connectors", false],
    ["DELETE", `/v1/remote-agents/connectors/${CID}`, false],
    ["GET", `/v1/remote-agents/connectors/${CID}/heartbeat`, false],
    ["POST", `/v1/remote-agents/connectors/${CID}/commands`, false],
    ["GET", `/v1/remote-agents/connectors/${CID}/events`, false],
    ["HEAD", `/v1/remote-agents/connectors/${CID}/commands`, false],
    ["POST", `/v1/remote-agents/connectors/${CID}/heartbeat/`, false],
    ["POST", `/v1/remote-agents/connectors/${CID}/heartbeat/more`, false],
    ["POST", `/v1/remote-agents/connectors//heartbeat`, false],
    ["POST", `/v1/remote-agents/connectors/${CID}/a/heartbeat`, false],
    ["POST", `/x/v1/remote-agents/connectors`, false],
    ["POST", `/v1/remote-agents/connectors/`, false],
    ["POST", `/v1/remote-agents/connectorsX`, false],
    ["POST", `/v1/remote-agents/sessions`, false],
    ["POST", `/v1/remote-agents/sessions/${CID}/commands`, false],
    ["GET", `/v1/remote-agents/sessions/${CID}/events`, false],
    ["GET", "/v1/remote-agents/audit", false],
    ["POST", "/v1/sessions", false],
    ["get", `/v1/remote-agents/connectors/${CID}/commands`, false],
  ];
  for (const [method, path, expected] of table) {
    test(`${method} ${path.replace(CID, ":cid")} is ${expected ? "" : "not "}connector-side`, async () => {
      const { isConnectorSideRoute } = await import("../src/remote-agents/connector-routes.js");
      assert.equal(isConnectorSideRoute(method, path), expected);
    });
  }
});
