// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform services in place of the neutral plugins (Python `main.run` and `Agent`): whose key it is comes from SaFE's
 * `/users/self` (asked with the key itself), a report is filed as a GitHub issue when FEEDBACK_REPO and a credential are set,
 * and a plugin a deployment replaced is kept.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  neutralPlugins,
  noFeedbackSink,
  silentLogger,
  type IdentityLookup,
  type SecretName,
} from "@primusclaw/personal-agent";
import { readSettings } from "@primusclaw/personal-agent-runtime";

import { FakeHttpServer } from "../../../test-support/http-server.js";
import { platformPlugins, type PlatformDeps } from "../src/plugins.js";

let safe: FakeHttpServer;
let dir: string;

before(async () => {
  safe = await FakeHttpServer.start([
    {
      method: "GET",
      path: "/api/v1/users/self",
      handle: () => ({ status: 200, json: { id: "u-alice", name: "alice" } }),
    },
    { method: "GET", path: "/api/v1/apikeys/current", handle: () => ({ status: 200, json: { id: 42 } }) },
    { method: "DELETE", path: "/api/v1/apikeys/42", handle: () => ({ status: 204, text: "" }) },
  ]);
  dir = mkdtempSync(join(tmpdir(), "w3b-plugins-"));
});

after(async () => {
  await safe.close();
  rmSync(dir, { recursive: true, force: true });
});

function deps(env: Record<string, string> = {}, secrets = new Map<SecretName, string>()): PlatformDeps {
  const settings = readSettings({
    TEAMS_ENCRYPTION_KEYS: "k",
    CLAW_API_URL: "http://claw.invalid",
    SAFE_API_URL: `${safe.url}/api/v1`,
    PUBLIC_BASE_URL: "https://claw.example.com",
  });
  return { env, settings, secrets, fetch: globalThis.fetch, now: () => Date.now() / 1000, logger: silentLogger };
}

it("with the neutral identity lookup, whose key it is is asked of SaFE's /users/self with the key itself", async () => {
  const plugins = platformPlugins(neutralPlugins(), deps());
  const owner = await plugins.identityLookup.ownerOfKey("ak-alice");
  assert.equal(owner?.id, "u-alice");
  const asked = safe.requests.at(-1);
  assert.equal(asked?.path, "/api/v1/users/self");
  assert.equal(asked.headers["authorization"], "Bearer ak-alice");
});

it("with the neutral key revoker, a key given up is deleted at SaFE with the key itself", async () => {
  const plugins = platformPlugins(neutralPlugins(), deps());
  assert.equal(await plugins.keyRevoker.revoke("ak-alice"), true);
  const asked = safe.requests.slice(-2).map((r) => [r.method, r.path, r.headers["authorization"]]);
  assert.deepEqual(asked, [
    ["GET", "/api/v1/apikeys/current", "Bearer ak-alice"],
    ["DELETE", "/api/v1/apikeys/42", "Bearer ak-alice"],
  ]);
});

it("an identity lookup a deployment replaced is kept", () => {
  const own: IdentityLookup = { ownerOfKey: () => Promise.resolve(undefined) };
  assert.equal(platformPlugins(neutralPlugins({ identityLookup: own }), deps()).identityLookup, own);
});

it("reports go to GitHub issues only when FEEDBACK_REPO and a credential are set", () => {
  assert.equal(platformPlugins(neutralPlugins(), deps()).feedbackSink, noFeedbackSink);
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "t");
  const filed = platformPlugins(
    neutralPlugins(),
    deps({ FEEDBACK_REPO: "acme/feedback", FEEDBACK_GITHUB_TOKEN_FILE: tokenFile }),
  );
  assert.notEqual(filed.feedbackSink, noFeedbackSink);
  assert.throws(
    () => platformPlugins(neutralPlugins(), deps({ FEEDBACK_GITHUB_TOKEN_FILE: tokenFile })),
    /FEEDBACK_REPO/,
  );
});
