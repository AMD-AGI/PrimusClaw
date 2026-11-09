// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { ExchangeSettings } from "@primusclaw/personal-agent";
import { HttpTokenExchange } from "../../src/index.js";
import { FakeClock } from "../../../../test-support/index.js";

const CFG: ExchangeSettings = {
  enabled: true,
  tokenUrl: "https://safe.test/oauth/token",
  clientId: "cid",
  clientSecret: "csecret",
  issuer: "teams.microsoft.com",
  audience: "claw-api",
  scope: "safe.api",
  bindingRequestUrl: "",
  forChat: false,
};

const BASIC = `Basic ${Buffer.from("cid:csecret").toString("base64")}`;

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fake identity service. /oauth/token: bound users get tok-<n>, others invalid_grant. /oauth/binding-requests: a
 * confirm link (req-<n>) valid for `linkTtl` seconds. Records every request.
 */
class Safe {
  readonly bound: Set<string>;
  readonly requests: Seen[] = [];
  readonly bindings: Seen[] = [];
  fail: number | null = null;
  bindStatus = 200;
  linkTtl = 600;
  n = 0;

  constructor(
    bound: readonly string[] = ["aad-a"],
    readonly expiresIn = 600,
  ) {
    this.bound = new Set(bound);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const url = input instanceof Request ? input.url : input.toString();
    const body = init?.body;
    const text = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "";
    const seen = { url, headers: new Headers(init?.headers), body: text };
    if (seen.url.endsWith("/binding-requests")) return this.binding(seen);
    this.requests.push(seen);
    if (this.fail !== null) return json(this.fail, { error: "server_error", access_token: "LEAK" });
    const subject = new URLSearchParams(seen.body).get("subject_token") ?? "";
    if (!this.bound.has(subject.split("|").at(-1) ?? "")) return json(400, { error: "invalid_grant" });
    this.n += 1;
    return json(200, { access_token: `tok-${String(this.n)}`, expires_in: this.expiresIn, token_type: "Bearer" });
  };

  private binding(seen: Seen): Response {
    this.bindings.push(seen);
    if (this.bindStatus !== 200) return json(this.bindStatus, { error: "access_denied", error_description: "LEAK" });
    const n = this.bindings.length;
    return json(200, {
      request_id: `req-${String(n)}`,
      expires_in: this.linkTtl,
      confirm_url: `https://id.test/binding/confirm?request=req-${String(n)}`,
    });
  }
}

function client(safe: Safe, clock = new FakeClock(), cfg = CFG): HttpTokenExchange {
  return new HttpTokenExchange(cfg, clock, safe.fetch);
}

async function token(c: HttpTokenExchange, user: string): Promise<string> {
  const r = await c.tokenFor(user);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

test("request is an rfc8693 exchange with basic client auth", async () => {
  const safe = new Safe();
  assert.equal(await token(client(safe), "aad-a"), "tok-1");
  const [request] = safe.requests;
  assert.ok(request);
  assert.equal(request.headers.get("authorization"), BASIC);
  const params = new URLSearchParams(request.body);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(params.get("subject_token"), "external:teams.microsoft.com|aad-a");
  assert.equal(params.get("subject_token_type"), "urn:primus:params:oauth:token-type:user-ref");
  assert.equal(params.get("requested_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.deepEqual([params.get("audience"), params.get("scope")], ["claw-api", "safe.api"]);
});

test("token is cached until shortly before it expires", async () => {
  const safe = new Safe();
  const clock = new FakeClock();
  const c = client(safe, clock);
  const first = await token(c, "aad-a");
  await clock.advance(539_000); // 600 - 60 margin = 540 is the limit
  const same = await token(c, "aad-a");
  await clock.advance(1_000);
  const fresh = await token(c, "aad-a");
  assert.deepEqual([first, same, fresh], ["tok-1", "tok-1", "tok-2"]);
  assert.equal(safe.requests.length, 2);
});

test("cache is per user", async () => {
  const c = client(new Safe(["aad-a", "aad-b"]));
  assert.deepEqual(
    [await token(c, "aad-a"), await token(c, "aad-b"), await token(c, "aad-a")],
    ["tok-1", "tok-2", "tok-1"],
  );
});

test("token that is nearly expired is not cached", async () => {
  const c = client(new Safe(["aad-a"], 30));
  assert.deepEqual([await token(c, "aad-a"), await token(c, "aad-a")], ["tok-1", "tok-2"]);
});

test("concurrent calls share one exchange", async () => {
  const safe = new Safe();
  const c = client(safe);
  const all = await Promise.all(Array.from({ length: 5 }, () => token(c, "aad-a")));
  assert.deepEqual(all, Array(5).fill("tok-1"));
  assert.equal(safe.requests.length, 1);
});

test("unbound user is not bound and is remembered only briefly", async () => {
  const safe = new Safe([]);
  const clock = new FakeClock();
  const c = client(safe, clock);
  for (let i = 0; i < 2; i++) assert.deepEqual(await c.tokenFor("aad-x"), { ok: false, error: { kind: "not_bound" } });
  assert.equal(safe.requests.length, 1); // the second was answered from memory
  await clock.advance(16_000);
  assert.deepEqual(await c.tokenFor("aad-x"), { ok: false, error: { kind: "not_bound" } });
  safe.bound.add("aad-x");
  c.invalidate("aad-x"); // what the Confirm button does
  assert.equal(await token(c, "aad-x"), "tok-1");
  assert.equal(safe.requests.length, 3);
});

test("other failures are errors not unbound and never quote the body", async (t) => {
  for (const status of [401, 403, 500, 503]) {
    await t.test(String(status), async () => {
      const safe = new Safe();
      safe.fail = status;
      const r = await client(safe).tokenFor("aad-a");
      assert.ok(!r.ok && r.error.kind === "exchange_failed");
      assert.equal(r.error.reason, `token exchange failed: ${String(status)} server_error`);
      assert.ok(!r.error.reason.includes("LEAK"));
    });
  }
});

const boom = (): Promise<Response> => Promise.reject(new TypeError("fetch failed: down https://safe.test"));

test("unreachable endpoint is an error", async () => {
  const r = await new HttpTokenExchange(CFG, new FakeClock(), boom).tokenFor("aad-a");
  assert.deepEqual(r, {
    ok: false,
    error: { kind: "exchange_failed", reason: "token endpoint unreachable: TypeError" },
  });
});

test("malformed success is an error", async (t) => {
  const bodies: unknown[] = [
    {},
    { access_token: "t" },
    { access_token: "", expires_in: 600 },
    { access_token: "t", expires_in: "soon" },
    { access_token: "t", expires_in: true },
    ["not", "an", "object"],
  ];
  for (const body of bodies) {
    await t.test(JSON.stringify(body), async () => {
      const c = new HttpTokenExchange(CFG, new FakeClock(), () => Promise.resolve(json(200, body)));
      const r = await c.tokenFor("aad-a");
      assert.ok(!r.ok && r.error.kind === "exchange_failed");
    });
  }
  const text = new HttpTokenExchange(CFG, new FakeClock(), () =>
    Promise.resolve(new Response("<html>", { status: 502 })),
  );
  assert.deepEqual(await text.tokenFor("aad-a"), {
    ok: false,
    error: { kind: "exchange_failed", reason: "token exchange failed: 502 " },
  });
});

async function binding(
  c: HttpTokenExchange,
  user: string,
  email = "",
): Promise<{ confirmUrl: string; expiresInSeconds: number }> {
  const r = await c.bindingRequest(user, email);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

test("binding request is json with basic client auth and returns the link", async () => {
  const safe = new Safe([]);
  assert.deepEqual(await binding(client(safe), "aad-a", "alice@example.com"), {
    confirmUrl: "https://id.test/binding/confirm?request=req-1",
    expiresInSeconds: 600,
  });
  const [request] = safe.bindings;
  assert.ok(request);
  assert.equal(request.headers.get("authorization"), BASIC);
  assert.ok(request.headers.get("content-type")?.startsWith("application/json"));
  assert.deepEqual(JSON.parse(request.body), {
    issuer: "teams.microsoft.com",
    subject: "aad-a",
    expected_email: "alice@example.com",
  });
});

test("the binding request url is beside the token url unless one is given", async () => {
  const safe = new Safe([]);
  await binding(client(safe), "aad-a");
  assert.equal(safe.bindings[0]?.url, "https://safe.test/oauth/binding-requests");
  const [first] = safe.bindings;
  assert.ok(first);
  assert.deepEqual(JSON.parse(first.body), { issuer: "teams.microsoft.com", subject: "aad-a" });
  await binding(
    client(safe, new FakeClock(), { ...CFG, bindingRequestUrl: "https://elsewhere.test/oauth/binding-requests" }),
    "aad-a",
  );
  assert.equal(safe.bindings[1]?.url, "https://elsewhere.test/oauth/binding-requests");
});

test("the open link is handed out again until shortly before it runs out", async () => {
  const safe = new Safe([]);
  const clock = new FakeClock();
  const c = client(safe, clock);
  const first = await binding(c, "aad-a");
  await clock.advance(539_000); // 600 - 60 margin = 540 is the limit
  const same = await binding(c, "aad-a");
  const other = await binding(c, "aad-b"); // per user
  await clock.advance(1_000);
  const fresh = await binding(c, "aad-a");
  assert.deepEqual(first, same);
  assert.ok(first.confirmUrl.endsWith("req-1"));
  assert.ok(other.confirmUrl.endsWith("req-2") && fresh.confirmUrl.endsWith("req-3"));
});

test("a link that is nearly out is not kept", async () => {
  const safe = new Safe([]);
  safe.linkTtl = 50;
  const c = client(safe);
  const [first, second] = [await binding(c, "aad-a"), await binding(c, "aad-a")];
  assert.ok(first.confirmUrl.endsWith("req-1") && second.confirmUrl.endsWith("req-2"));
});

test("concurrent binding requests share one request", async () => {
  const safe = new Safe([]);
  const c = client(safe);
  const all = await Promise.all(Array.from({ length: 5 }, () => binding(c, "aad-a")));
  assert.equal(new Set(all.map((r) => r.confirmUrl)).size, 1);
  assert.equal(safe.bindings.length, 1);
});

test("binding request failures are errors that never quote the body", async (t) => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    await t.test(String(status), async () => {
      const safe = new Safe([]);
      safe.bindStatus = status;
      const r = await client(safe).bindingRequest("aad-a", "");
      assert.ok(!r.ok && r.error.kind === "exchange_failed");
      assert.ok(!r.error.reason.includes("LEAK") && r.error.reason.includes(String(status)));
      assert.ok(r.error.reason.includes("access_denied"));
    });
  }
});

test("a failed binding request is not remembered", async () => {
  const safe = new Safe([]);
  safe.bindStatus = 503;
  const c = client(safe);
  assert.equal((await c.bindingRequest("aad-a", "")).ok, false);
  safe.bindStatus = 200;
  assert.ok((await binding(c, "aad-a")).confirmUrl.endsWith("req-2"));
});

test("a malformed binding reply is an error", async (t) => {
  const bodies: unknown[] = [
    {},
    { expires_in: 600 },
    { confirm_url: "https://id.test/x" },
    { confirm_url: "", expires_in: 600 },
    { confirm_url: "http://id.test/x", expires_in: 600 }, // a link that is shown must be https
    { confirm_url: "javascript:alert(1)", expires_in: 600 },
    { confirm_url: "//id.test/x", expires_in: 600 },
    { confirm_url: "https://id.test/x", expires_in: "soon" },
    { confirm_url: "https://id.test/x", expires_in: 0 },
    { confirm_url: "https://id.test/x", expires_in: true },
    { confirm_url: ["https://id.test/x"], expires_in: 600 },
  ];
  for (const body of bodies) {
    await t.test(JSON.stringify(body), async () => {
      const c = new HttpTokenExchange(CFG, new FakeClock(), () => Promise.resolve(json(200, body)));
      assert.equal((await c.bindingRequest("aad-a", "")).ok, false);
    });
  }
});

test("an unreachable binding endpoint is an error", async () => {
  const r = await new HttpTokenExchange(CFG, new FakeClock(), boom).bindingRequest("aad-a", "");
  assert.deepEqual(r, {
    ok: false,
    error: { kind: "exchange_failed", reason: "binding endpoint unreachable: TypeError" },
  });
});

test("a later caller waits for the exchange in flight and then asks again when it failed", async () => {
  const safe = new Safe();
  safe.fail = 503;
  const c = client(safe);
  const both = await Promise.all([c.tokenFor("aad-a"), c.tokenFor("aad-a")]);
  assert.ok(both.every((r) => !r.ok));
  assert.equal(safe.requests.length, 2); // one at a time, each its own try (an asyncio.Lock, not a shared result)
  assert.equal(c.enabled, true);
});
