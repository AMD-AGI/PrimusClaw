// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session's keys are kept sealed in `claw_sessions.config`, against a real Postgres with the production
 * schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   R1  the reader opens the sealed keys, still reads the plain fields of an older build, and prefers them
 *   R2  the reader trusts nothing without the marker, and a blob that will not open reads as no keys
 *   W1  a stamp seals the keys and removes the plain fields an older build wrote, keeping the rest of config
 *   B1  the backfill seals every stamped row that holds plain keys, leaves the others alone, and is idempotent
 *   B2  initDb runs the backfill
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("sealed session credentials", { skip }, () => {
  let h: AdmissionCluster;
  let mod: typeof import("../src/auth/sealed-session-credentials.js");
  let stamp: typeof import("../src/auth/session-credentials.js")["stampSessionCredentials"];

  before(async () => {
    h = await startAdmissionCluster({ CLAW_DEPLOY_MODE: "safe" });
    mod = await import("../src/auth/sealed-session-credentials.js");
    stamp = (await import("../src/auth/session-credentials.js")).stampSessionCredentials;
  });
  after(async () => { await h?.stop(); });
  beforeEach(async () => { await q("TRUNCATE claw_sessions CASCADE"); });

  const q = async (text: string, params: unknown[] = []) =>
    (await h.app.db.db.query(text, params)).rows as Array<Record<string, any>>;
  const seed = (sid: string, config: Record<string, unknown>) =>
    q("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ($1, 'u1', $2::jsonb)", [sid, JSON.stringify(config)]);
  const config = async (sid: string) =>
    (await q("SELECT config FROM claw_sessions WHERE session_id = $1", [sid]))[0].config as Record<string, unknown>;
  const raw = async (sid: string) =>
    (await q("SELECT config::text AS t FROM claw_sessions WHERE session_id = $1", [sid]))[0].t as string;
  const sealed = (platformKey: string, llmApiKey: string) => mod.sealedCredentialFields({ platformKey, llmApiKey });

  test("R1 the reader opens the sealed keys, reads an older build's plain fields, and prefers those", () => {
    const read = mod.readTrustedSessionCredentials;
    assert.deepEqual(read(sealed("pk-a", "vk-a")), { platformKey: "pk-a", llmApiKey: "vk-a" });
    assert.deepEqual(read({ platform_key: "pk-b", llm_api_key: "vk-b", _server_managed_credentials: true }),
      { platformKey: "pk-b", llmApiKey: "vk-b" });
    assert.deepEqual(read({ virtual_key: "vk-c", _server_managed_credentials: true }), { platformKey: "", llmApiKey: "vk-c" });
    // A replica of the previous build stamped after this one: its plain fields are the newer keys.
    assert.deepEqual(read({ ...sealed("pk-old", "vk-old"), platform_key: "pk-new", llm_api_key: "vk-new" }),
      { platformKey: "pk-new", llmApiKey: "vk-new" });
  });

  test("R2 nothing is trusted without the marker, and a blob that will not open reads as no keys", () => {
    const read = mod.readTrustedSessionCredentials;
    const none = { platformKey: "", llmApiKey: "" };
    const { _server_managed_credentials: _m, ...unmarked } = sealed("pk-a", "vk-a");
    assert.deepEqual(read(unmarked), none);
    assert.deepEqual(read({ ...unmarked, _server_managed_credentials: "true" }), none);
    assert.deepEqual(read({ sealed_credentials: "AAAA", _server_managed_credentials: true }), none);
    assert.deepEqual(read({ sealed_credentials: 7, _server_managed_credentials: true }), none);
  });

  test("W1 a stamp seals the keys, removes the plain fields, and keeps the rest of config", async () => {
    await seed("s1", { model: "m", repo: { url: "https://example.invalid/r.git" }, platform_key: "pk-old", llm_api_key: "vk-old", virtual_key: "vk-older", _server_managed_credentials: true });
    await stamp("s1", { userId: "u1", userName: "u1", roles: [], platformKey: "pk-new", virtualKey: "vk-new" });
    const cfg = await config("s1");
    assert.deepEqual(Object.keys(cfg).sort(), ["_server_managed_credentials", "model", "repo", "sealed_credentials"]);
    assert.deepEqual(mod.readTrustedSessionCredentials(cfg), { platformKey: "pk-new", llmApiKey: "vk-new" });
    for (const key of ["pk-old", "vk-old", "vk-older", "pk-new", "vk-new"]) assert.equal((await raw("s1")).includes(key), false, key);
  });

  test("B1 the backfill seals every stamped row with plain keys, leaves the rest, and is idempotent", async () => {
    await seed("a", { model: "m", platform_key: "pk-a", llm_api_key: "vk-a", _server_managed_credentials: true });
    await seed("b", { virtual_key: "vk-b", _server_managed_credentials: true });
    await seed("c", { platform_key: null, llm_api_key: null, _server_managed_credentials: true });
    await seed("d", { ...sealed("pk-d-old", "vk-d-old"), platform_key: "pk-d", _server_managed_credentials: true });
    await seed("e", { platform_key: "caller-supplied" });
    await seed("f", sealed("pk-f", "vk-f"));
    await q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = 'b'");
    const untouched = { e: await raw("e"), f: await raw("f") };
    const before = Object.fromEntries(await Promise.all(["a", "b", "c", "d", "f"].map(async (s) =>
      [s, mod.readTrustedSessionCredentials(await config(s))])));

    const client = await h.app.db.db.pool.connect();
    try {
      // A batch of one, so the walk over pages is what reaches every row.
      assert.equal(await mod.sealPlaintextSessionCredentials(client, 1), 4);
      assert.equal(await mod.sealPlaintextSessionCredentials(client, 1), 0, "nothing is left for the next start");
    } finally { client.release(); }

    for (const sid of ["a", "b", "c", "d"]) {
      const cfg = await config(sid);
      assert.equal(typeof cfg.sealed_credentials, "string", sid);
      for (const f of mod.PLAINTEXT_CREDENTIAL_FIELDS) assert.equal(f in cfg, false, `${sid}.${f}`);
      assert.deepEqual(mod.readTrustedSessionCredentials(cfg), before[sid], sid);
    }
    assert.equal((await config("a")).model, "m", "the rest of config is kept");
    assert.deepEqual(before.d, { platformKey: "pk-d", llmApiKey: "" }, "the plain fields were the newer keys");
    for (const [sid, key] of [["a", "pk-a"], ["a", "vk-a"], ["b", "vk-b"], ["d", "pk-d"]]) {
      assert.equal((await raw(sid)).includes(key), false, `${sid} still holds ${key}`);
    }
    assert.equal(await raw("e"), untouched.e, "a row this service never stamped is not touched");
    assert.equal(await raw("f"), untouched.f, "a row already sealed is not rewritten");
  });

  test("B2 initDb runs the backfill", async () => {
    await seed("a", { platform_key: "pk-a", llm_api_key: "vk-a", _server_managed_credentials: true });
    await h.app.db.initDb();
    const cfg = await config("a");
    assert.equal("platform_key" in cfg, false);
    assert.deepEqual(mod.readTrustedSessionCredentials(cfg), { platformKey: "pk-a", llmApiKey: "vk-a" });
  });
});
