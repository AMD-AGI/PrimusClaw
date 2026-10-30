// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How long the keys SaFE holds for a person are kept after the API got them through a delegated token
 * (`auth/delegated-keys.ts`), with a clock the test moves and stand-ins for the provider and for SaFE, so the
 * bounds are exact: the delegated token's remaining life for an answer, 30 seconds for a refusal, nothing for a
 * failure to answer.
 *
 *   D1  an answer is kept per person until the delegated token ends, not a moment longer
 *   D2  a refusal is kept 30 seconds; a failure to answer is not kept
 *   D3  concurrent lookups of one person are one exchange and one question
 *   D4  the cache is bounded, and a person's answer is never another's
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { IdentityExchangeRefusedError, IdentityUnavailableError, type ExchangedToken, type ExchangeRequest } from "@claw/utils";
import { DelegatedKeys, type DelegationDeps } from "../src/auth/delegated-keys.js";
import { AuthUpstreamUnreachableError, SafeUpstreamHttpError, SafeUpstreamProtocolError } from "../src/auth/safe-client.js";
import type { UserInfo } from "../src/auth/models.js";

const SETTINGS = { audience: "primus-safe", scope: "safe.api" };
const user = (userId: string, platformKey = `ak-${userId}`, virtualKey = `sk-${userId}`): UserInfo =>
  ({ userId, userName: userId, roles: ["default"], platformKey, virtualKey });

/** A provider and a SaFE that count what they are asked, and answer from functions the test replaces. */
function world(clock: { t: number }) {
  const w = {
    exchanges: [] as ExchangeRequest[],
    verifies: [] as Array<{ token: string; opts: { cache?: boolean } | undefined }>,
    lifetimeMs: 60_000 as number | null,
    exchange: undefined as undefined | ((req: ExchangeRequest) => Promise<ExchangedToken>),
    verify: undefined as undefined | ((token: string) => Promise<UserInfo>),
    deps: undefined as unknown as DelegationDeps,
    keys: new DelegatedKeys(() => clock.t),
  };
  let n = 0;
  w.deps = {
    identity: {
      exchange: async (req) => {
        w.exchanges.push(req);
        if (w.exchange) return w.exchange(req);
        n += 1;
        return { accessToken: `delegated-${n}-for-${req.subjectToken}`, tokenType: "Bearer", expiresAt: w.lifetimeMs === null ? null : clock.t + w.lifetimeMs };
      },
    },
    safe: {
      verifyAccessToken: async (token, opts) => {
        w.verifies.push({ token, opts });
        if (w.verify) return w.verify(token);
        return user(/for-user-token-of-(\S+)$/.exec(token)?.[1] ?? "nobody");
      },
    },
  };
  return w;
}
const ask = (w: ReturnType<typeof world>, sub: string) => w.keys.keysOf(sub, `user-token-of-${sub}`, SETTINGS, w.deps);

describe("D1 an answer is kept per person until the delegated token ends", () => {
  test("the exchange asks for what the settings say, with the person's token as the subject, and SaFE is asked without its own cache", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    const r = await ask(w, "alice");
    assert.deepEqual(r, { status: "keys", platformKey: "ak-alice", virtualKey: "sk-alice" });
    assert.deepEqual(w.exchanges, [{
      subjectToken: "user-token-of-alice", subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
      audience: "primus-safe", scope: "safe.api",
    }]);
    assert.deepEqual(w.verifies.map((v) => v.opts), [{ cache: false }], "the answer is kept here, not twice");
    assert.ok(!w.verifies[0]!.token.includes("undefined") && w.verifies[0]!.token.startsWith("delegated-"), "SaFE is asked with the delegated token");
  });

  test("kept for the life the delegated token has, exactly", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock); // the delegated token lives 60 s
    await ask(w, "alice");
    clock.t += 59_999;
    await ask(w, "alice");
    assert.equal(w.verifies.length, 1, "one millisecond before the token ends it is still kept");
    clock.t += 1;
    await ask(w, "alice");
    assert.equal(w.verifies.length, 2, "when the token ends it is asked again");
    assert.equal(w.exchanges.length, 2);
  });

  test("a longer-lived token is kept longer: the bound is the token's, not a constant", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    w.lifetimeMs = 15 * 60_000;
    await ask(w, "alice");
    clock.t += 14 * 60_000;
    await ask(w, "alice");
    assert.equal(w.verifies.length, 1);
    clock.t += 60_000;
    await ask(w, "alice");
    assert.equal(w.verifies.length, 2);
  });

  test("a token with no stated end, or one already past it, is not kept at all", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    w.lifetimeMs = null;
    await ask(w, "alice");
    await ask(w, "alice");
    assert.equal(w.verifies.length, 2, "no end stated");
    w.lifetimeMs = -1;
    await ask(w, "alice");
    await ask(w, "alice");
    assert.equal(w.verifies.length, 4, "already ended");
  });
});

describe("D2 what is kept of a refusal and of a failure to answer", () => {
  test("SaFE's refusal is kept 30 seconds", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    w.verify = async () => { throw new SafeUpstreamHttpError({ status: 403, bodySnippet: "" }); };
    assert.deepEqual(await ask(w, "alice"), { status: "none", reason: "safe_http_403" });
    clock.t += 29_999;
    await ask(w, "alice");
    assert.equal(w.verifies.length, 1);
    clock.t += 1;
    await ask(w, "alice");
    assert.equal(w.verifies.length, 2);
  });

  test("the provider's refusal is kept 30 seconds, and says which refusal", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    w.exchange = async () => { throw new IdentityExchangeRefusedError("unauthorized_client", 400); };
    assert.deepEqual(await ask(w, "alice"), { status: "none", reason: "delegation_refused_unauthorized_client" });
    clock.t += 29_999;
    await ask(w, "alice");
    assert.equal(w.exchanges.length, 1);
    clock.t += 1;
    await ask(w, "alice");
    assert.equal(w.exchanges.length, 2);
    assert.equal(w.verifies.length, 0, "SaFE is not asked without a delegated token");
  });

  test("an answer for somebody else's id, and a person SaFE holds nothing for, are refusals", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    w.verify = async () => user("bob");
    assert.deepEqual(await ask(w, "alice"), { status: "none", reason: "subject_mismatch" });
    w.verify = async () => user("carol", "", "");
    assert.deepEqual(await ask(w, "carol"), { status: "none", reason: "safe_holds_no_keys" });
  });

  test("SaFE or the provider not answering is never kept, and says which", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    w.verify = async () => { throw new AuthUpstreamUnreachableError("down"); };
    assert.deepEqual(await ask(w, "alice"), { status: "unavailable", source: "safe" });
    w.verify = async () => { throw new SafeUpstreamHttpError({ status: 502, bodySnippet: "" }); };
    assert.deepEqual(await ask(w, "alice"), { status: "unavailable", source: "safe" });
    w.verify = async () => { throw new SafeUpstreamProtocolError("SaFE answered 200 with a body that is not JSON"); };
    assert.deepEqual(await ask(w, "alice"), { status: "unavailable", source: "safe" }, "a 2xx that is not an answer is a failure to answer");
    w.verify = undefined;
    w.exchange = async () => { throw new IdentityUnavailableError("exchange", "timeout"); };
    assert.deepEqual(await ask(w, "alice"), { status: "unavailable", source: "identity" });
    w.exchange = async () => { throw new IdentityUnavailableError("exchange", "client_rejected", 401); };
    assert.deepEqual(await ask(w, "alice"), { status: "unavailable", source: "identity" });
    w.exchange = undefined;
    assert.equal((await ask(w, "alice")).status, "keys", "and the next request asks again");
  });

  test("a SaFE that cannot be asked at all is misconfigured, not keyless, and is not kept", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    const { AuthServiceMisconfiguredError } = await import("../src/auth/safe-client.js");
    w.verify = async () => { throw new AuthServiceMisconfiguredError("no internal token"); };
    assert.deepEqual(await ask(w, "alice"), { status: "misconfigured", message: "no internal token" });
    w.verify = undefined;
    assert.equal((await ask(w, "alice")).status, "keys");
  });
});

describe("D3 concurrent lookups of one person", () => {
  test("one exchange and one question, whatever the number of requests, and a failure reaches all of them", async () => {
    const clock = { t: 1_000_000 };
    const w = world(clock);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    w.verify = async (token) => { await gate; return user(/for-user-token-of-(\S+)$/.exec(token)?.[1] ?? ""); };
    const all = Promise.all(Array.from({ length: 8 }, () => ask(w, "alice")));
    await new Promise((r) => setImmediate(r));
    release();
    for (const r of await all) assert.equal(r.status, "keys");
    assert.equal(w.exchanges.length, 1);
    assert.equal(w.verifies.length, 1);

    const w2 = world(clock);
    w2.verify = async () => { await gate; throw new AuthUpstreamUnreachableError("down"); };
    const failing = await Promise.all(Array.from({ length: 4 }, () => ask(w2, "alice")));
    assert.deepEqual(new Set(failing.map((r) => r.status)), new Set(["unavailable"]));
    assert.equal(w2.verifies.length, 1);
    // The flight is over: the next lookup is a new one.
    w2.verify = undefined;
    assert.equal((await ask(w2, "alice")).status, "keys");
  });

  test("two people at once are two lookups", async () => {
    const w = world({ t: 1_000_000 });
    const [a, b] = await Promise.all([ask(w, "alice"), ask(w, "bob")]);
    assert.deepEqual([a, b].map((r) => (r as { platformKey: string }).platformKey), ["ak-alice", "ak-bob"]);
    assert.equal(w.exchanges.length, 2);
  });
});

describe("D4 bounded, and per person", () => {
  test("the cache holds a bounded number of people: the oldest is forgotten first", async () => {
    const w = world({ t: 1_000_000 });
    for (let i = 0; i < 1001; i++) await ask(w, `u${i}`);
    const before = w.verifies.length;
    await ask(w, "u1000");
    assert.equal(w.verifies.length, before, "the newest is kept");
    await ask(w, "u0");
    assert.equal(w.verifies.length, before + 1, "the oldest was dropped");
  });

  test("one person's keys are never handed to another", async () => {
    const w = world({ t: 1_000_000 });
    const a = await ask(w, "alice");
    const b = await ask(w, "bob");
    assert.notDeepEqual(a, b);
    assert.deepEqual(await ask(w, "alice"), a);
    assert.deepEqual(await ask(w, "bob"), b);
  });
});

test("an unexpected error from the exchange is not turned into an answer", async () => {
  const w = world({ t: 1_000_000 });
  w.exchange = async () => { throw new TypeError("a bug"); };
  await assert.rejects(ask(w, "alice"), TypeError);
});
