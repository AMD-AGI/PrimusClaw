// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../../../../test-support/clock.js";
import { GithubApi } from "../../src/github/api.js";
import { IdentityCredentialClient } from "../../src/github/credential-client.js";
import { GithubDeviceFlow } from "../../src/github/device-flow.js";
import { GatewayIntentReader, readingOf } from "../../src/github/intent-reader.js";
import { PublicPullReader } from "../../src/github/pull-reader.js";
import { silentLogger } from "@primusclaw/personal-agent";

const code = {
  deviceCode: "dc",
  userCode: "U",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
  interval: 5,
};

async function drive<T>(clock: FakeClock, run: Promise<T>): Promise<T> {
  let done = false;
  const out = run.finally(() => {
    done = true;
  });
  for (let i = 0; i < 400 && !done; i += 1) await clock.advance(5000);
  return out;
}

test("the device flow gives up when the code runs out", async () => {
  const clock = new FakeClock();
  const flow = new GithubDeviceFlow({
    clientId: "c",
    clock,
    fetch: () => Promise.resolve(Response.json({ error: "authorization_pending" })),
  });
  const result = await drive(clock, flow.waitForToken({ ...code, expiresIn: 30 }));
  assert.deepEqual(result, { ok: false, error: { kind: "device_flow_failed", reason: "expired" } });
});

test("the page a person is sent to must be githubs", async () => {
  const flow = new GithubDeviceFlow({
    clientId: "c",
    clock: new FakeClock(),
    fetch: () =>
      Promise.resolve(
        Response.json({
          device_code: "d",
          user_code: "u",
          verification_uri: "https://evil.test/login",
          expires_in: 900,
          interval: 5,
        }),
      ),
  });
  assert.deepEqual(await flow.start(), { ok: false, error: { kind: "device_flow_failed", reason: "unavailable" } });
});

test("an answer github does not give is unavailable not a token", async () => {
  for (const body of [{ error: "weird" }, { access_token: "" }, "not json"]) {
    const clock = new FakeClock();
    const flow = new GithubDeviceFlow({
      clientId: "c",
      clock,
      fetch: () => Promise.resolve(typeof body === "string" ? new Response(body) : Response.json(body)),
    });
    assert.deepEqual(await drive(clock, flow.waitForToken(code)), {
      ok: false,
      error: { kind: "device_flow_failed", reason: "unavailable" },
    });
  }
  const clock = new FakeClock();
  const flow = new GithubDeviceFlow({
    clientId: "c",
    clock,
    fetch: () => Promise.resolve(Response.json({ access_token: "gho_x" })),
  });
  assert.deepEqual(await drive(clock, flow.waitForToken(code)), { ok: true, value: "gho_x" });
  const stop = new AbortController();
  stop.abort();
  assert.deepEqual(await flow.waitForToken(code, stop.signal), { ok: false, error: { kind: "device_flow_cancelled" } });
});

test("a credential call names the status and code and never the body", async () => {
  const answer = (status: number, body: unknown) => () => Promise.resolve(Response.json(body, { status }));
  const client = (fetch: () => Promise<Response>) =>
    new IdentityCredentialClient({ baseUrl: "https://id.test/", clientId: "a", clientSecret: "b", issuer: "i", fetch });
  assert.deepEqual(await client(answer(400, { error: "invalid_grant" })).status("u"), {
    ok: false,
    error: { kind: "not_bound" },
  });
  assert.deepEqual(await client(answer(503, { error: "server_error", error_description: "gho_secret" })).status("u"), {
    ok: false,
    error: { kind: "credential_refused", status: 503, code: "server_error" },
  });
  assert.deepEqual(await client(() => Promise.reject(new TypeError("boom gho_secret"))).unbind("u"), {
    ok: false,
    error: { kind: "credential_refused", status: 0, code: "TypeError" },
  });
  const bound = await client(
    answer(200, { user_id: "u1", bound: true, item: { providerLogin: "octo", scopes: ["repo"], delegation: true } }),
  ).status("u");
  assert.ok(bound.ok && bound.value.login === "octo" && bound.value.delegation);
  const none = await client(answer(200, { user_id: "u1", bound: false })).setDelegation("u", true);
  assert.ok(none.ok && !none.value.bound);
});

test("the pull request read names the pull request and sends no credential", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const reader = (status: number, body: unknown) =>
    new PublicPullReader(
      new GithubApi({
        fetch: (url, init) => {
          seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
          return Promise.resolve(Response.json(body, { status }));
        },
      }),
      silentLogger,
    );
  const pull = { owner: "AMD-AGI", repo: "Hyperloom", number: 12 };
  assert.deepEqual(await reader(200, { user: { login: "bob" }, title: "a `fix`" }).read(pull), {
    author: "bob",
    title: "a fix",
  });
  assert.equal(seen[0]?.url, "https://api.github.com/repos/AMD-AGI/Hyperloom/pulls/12");
  assert.equal(seen[0]?.auth, null);
  assert.deepEqual(await reader(403, {}).read(pull), { author: undefined, title: "" });
  assert.equal(await reader(200, { base: { ref: "main" } }).base(pull), "main");
  assert.equal(await reader(404, {}).repo("AMD-AGI", "nope"), "");
  assert.equal(await reader(200, { full_name: "AMD-AGI/X", private: true }).repo("AMD-AGI", "x"), undefined);
  assert.equal(await reader(200, { full_name: "AMD-AGI/X" }).repo("AMD-AGI", "x"), "AMD-AGI/X");
});

test("the reader calls the gateway with the askers key and gives up on anything but an answer in time", async () => {
  const bodies: string[] = [];
  const reader = (respond: () => Promise<Response>) =>
    new GatewayIntentReader({
      baseUrl: "https://llm.test/v1/",
      model: "small",
      logger: silentLogger,
      fetch: (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return respond();
      },
    });
  const ok = await reader(() =>
    Promise.resolve(Response.json({ choices: [{ message: { content: 'x {"intent": "none"} y' } }] })),
  ).read("ak-1", "请 Bob review 合入 x/y#1", []);
  assert.deepEqual(ok, { intent: "none" });
  assert.ok(bodies[0]?.includes('"model":"small"') && bodies[0].includes("请 Bob review 合入 x/y#1"));
  assert.equal(await reader(() => Promise.resolve(new Response("", { status: 429 }))).readMode("k", "t"), undefined);
  assert.equal(await reader(() => Promise.reject(new Error("timeout"))).readAnswer("k", "t", []), undefined);
  assert.deepEqual(readingOf("no json"), { intent: null });
  assert.deepEqual(readingOf("[1]"), { intent: null });
});
