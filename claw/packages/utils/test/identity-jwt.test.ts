// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Local JWT verification against the issuer's cached key set.
 *
 * What a verifier must refuse is the substance here: each rejection below
 * asserts the specific reason, because a token turned away for the wrong
 * reason proves the check it was meant to hit is missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createPublicKey, generateKeyPairSync } from "node:crypto";
import { IdentityUnavailableError, JwtVerificationError } from "../src/index.js";
import { harness, signJwt, testKey, type Harness, type TestKey } from "./identity-fake.js";

const AUD = "claw-test-audience";
const rs = testKey("RS256", "rs-1");
const es = testKey("ES256", "es-1");

async function withHarness(
  over: Parameters<typeof harness>[0],
  keys: TestKey[],
  run: (h: Harness, claims: (extra?: Record<string, unknown>) => Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const h = await harness(over);
  h.fake.jwks = () => ({ body: { keys: keys.map((k) => k.jwk) } });
  const claims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    iss: h.fake.issuer, aud: AUD, sub: "user-1", exp: h.clock.seconds + 300, nbf: h.clock.seconds - 1, ...extra,
  });
  try { await run(h, claims); } finally { await h.fake.close(); }
}

function rejected(reason: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof JwtVerificationError, `expected JwtVerificationError(${reason}), got ${String(err)}`);
    assert.equal(err.reason, reason);
    return true;
  };
}

test("RS256 and ES256 tokens verify and hand back their claims", async () => {
  await withHarness({}, [rs, es], async ({ client }, claims) => {
    for (const key of [rs, es]) {
      const token = signJwt({ key, claims: claims({ roles: ["default"] }) });
      const v = await client.verifyJwt(token, { audience: AUD, typ: "at+jwt" });
      assert.equal(v.claims.sub, "user-1", key.alg);
      assert.deepEqual(v.claims.roles, ["default"]);
      assert.equal(v.header.kid, key.kid);
    }
  });
});

test("a token that must be refused is refused for the right reason", async () => {
  await withHarness({}, [rs, es], async ({ fake, clock, client }, claims) => {
    const good = signJwt({ key: es, claims: claims() });
    const [h, p, s] = good.split(".") as [string, string, string];
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims(), sub: "admin" })).toString("base64url");
    const hmac = (secret: string): string => {
      const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "at+jwt", kid: "es-1" })).toString("base64url");
      return `${head}.${p}.${createHmac("sha256", secret).update(`${head}.${p}`).digest("base64url")}`;
    };
    const noneHead = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt", kid: "es-1" })).toString("base64url");

    const cases: Array<[string, string, Parameters<typeof client.verifyJwt>[1], string]> = [
      ["payload changed after signing", `${h}.${tamperedPayload}.${s}`, { audience: AUD }, "bad_signature"],
      ["signature of another message", `${h}.${p}.${signJwt({ key: es, claims: claims({ x: 1 }) }).split(".")[2]}`, { audience: AUD }, "bad_signature"],
      ["alg none", `${noneHead}.${p}.`, { audience: AUD }, "alg_not_allowed"],
      ["HMAC keyed with the public key's JSON", hmac(JSON.stringify(es.jwk)), { audience: AUD }, "alg_not_allowed"],
      ["an algorithm the caller did not allow", good, { audience: AUD, algorithms: ["RS256"] }, "alg_not_allowed"],
      ["alg missing", signJwt({ key: es, claims: claims(), header: { alg: undefined } }), { audience: AUD }, "alg_not_allowed"],
      ["RS256 header on an EC key", signJwt({ key: es, claims: claims(), header: { alg: "RS256" } }), { audience: AUD }, "key_mismatch"],
      ["ES256 header on an RSA key", signJwt({ key: rs, claims: claims(), header: { alg: "ES256" } }), { audience: AUD }, "key_mismatch"],
      ["a kid the issuer does not publish", signJwt({ key: es, claims: claims(), header: { kid: "nobody" } }), { audience: AUD }, "unknown_key"],
      ["a kid that is not a string", signJwt({ key: es, claims: claims(), header: { kid: 7 } }), { audience: AUD }, "malformed"],
      ["wrong issuer", signJwt({ key: es, claims: claims({ iss: "https://elsewhere.example.com" }) }), { audience: AUD }, "issuer_mismatch"],
      ["no issuer", signJwt({ key: es, claims: claims({ iss: undefined }) }), { audience: AUD }, "issuer_mismatch"],
      ["wrong audience", signJwt({ key: es, claims: claims({ aud: "someone-else" }) }), { audience: AUD }, "audience_mismatch"],
      ["audience list without ours", signJwt({ key: es, claims: claims({ aud: ["a", "b"] }) }), { audience: AUD }, "audience_mismatch"],
      ["no audience", signJwt({ key: es, claims: claims({ aud: undefined }) }), { audience: AUD }, "audience_mismatch"],
      ["expired", signJwt({ key: es, claims: claims({ exp: clock.seconds - 31 }) }), { audience: AUD }, "expired"],
      ["no exp", signJwt({ key: es, claims: claims({ exp: undefined }) }), { audience: AUD }, "missing_claim"],
      ["exp as a string", signJwt({ key: es, claims: claims({ exp: String(clock.seconds + 300) }) }), { audience: AUD }, "missing_claim"],
      ["not yet valid", signJwt({ key: es, claims: claims({ nbf: clock.seconds + 31 }) }), { audience: AUD }, "not_yet_valid"],
      ["nbf as a string", signJwt({ key: es, claims: claims({ nbf: "soon" }) }), { audience: AUD }, "malformed"],
      ["typ of another profile", signJwt({ key: es, claims: claims(), header: { typ: "JWT" } }), { audience: AUD, typ: "at+jwt" }, "typ_mismatch"],
      ["no typ where one is required", signJwt({ key: es, claims: claims(), header: { typ: undefined } }), { audience: AUD, typ: "at+jwt" }, "typ_mismatch"],
      ["a critical header it does not implement", signJwt({ key: es, claims: claims(), header: { crit: ["exp"] } }), { audience: AUD }, "malformed"],
      ["two segments", `${h}.${p}`, { audience: AUD }, "malformed"],
      ["four segments", `${good}.x`, { audience: AUD }, "malformed"],
      ["empty", "", { audience: AUD }, "malformed"],
      ["a signature in padded base64, which is another spelling of the same bytes", `${h}.${p}.${s}==`, { audience: AUD }, "malformed"],
      ["header that is not base64url", `@@@.${p}.${s}`, { audience: AUD }, "malformed"],
      ["header that is not JSON", `${Buffer.from("nope").toString("base64url")}.${p}.${s}`, { audience: AUD }, "malformed"],
      ["header that is a JSON array", `${Buffer.from("[]").toString("base64url")}.${p}.${s}`, { audience: AUD }, "malformed"],
    ];
    void fake;
    for (const [name, token, opts, reason] of cases) {
      await assert.rejects(client.verifyJwt(token, opts), rejected(reason), name);
    }
  });
});

test("the accepted forms of typ, audience and clock tolerance", async () => {
  await withHarness({}, [es], async ({ clock, client }, claims) => {
    const ok = async (token: string, opts: Parameters<typeof client.verifyJwt>[1]): Promise<void> => {
      await client.verifyJwt(token, opts);
    };
    await ok(signJwt({ key: es, claims: claims(), header: { typ: "AT+JWT" } }), { audience: AUD, typ: "at+jwt" });
    await ok(signJwt({ key: es, claims: claims(), header: { typ: "application/at+jwt" } }), { audience: AUD, typ: "at+jwt" });
    await ok(signJwt({ key: es, claims: claims({ aud: ["x", AUD] }) }), { audience: AUD });
    // A token with no typ is fine when the caller does not ask for one.
    await ok(signJwt({ key: es, claims: claims(), header: { typ: undefined } }), { audience: AUD });
    // exp 29 s ago passes the default 30 s tolerance; 30 s ago does not.
    await ok(signJwt({ key: es, claims: claims({ exp: clock.seconds - 29 }) }), { audience: AUD });
    await assert.rejects(
      client.verifyJwt(signJwt({ key: es, claims: claims({ exp: clock.seconds - 30 }) }), { audience: AUD }),
      rejected("expired"),
    );
    // And a tolerance of zero is exact.
    await assert.rejects(
      client.verifyJwt(signJwt({ key: es, claims: claims({ exp: clock.seconds - 1 }) }), { audience: AUD, clockToleranceSeconds: 0 }),
      rejected("expired"),
    );
    await ok(signJwt({ key: es, claims: claims({ nbf: clock.seconds + 29 }) }), { audience: AUD });
  });
});

test("a token is checked against the issuer it names in the options when one is given", async () => {
  await withHarness({}, [es], async ({ client }, claims) => {
    const token = signJwt({ key: es, claims: claims({ iss: "https://other.example.com" }) });
    await assert.rejects(client.verifyJwt(token, { audience: AUD }), rejected("issuer_mismatch"));
    await client.verifyJwt(token, { audience: AUD, issuer: "https://other.example.com" });
  });
});

test("a token without a kid verifies only when the issuer publishes exactly one key", async () => {
  await withHarness({}, [es], async ({ client }, claims) => {
    const noKid = signJwt({ key: { ...es, kid: "" }, claims: claims(), header: { kid: undefined } });
    await client.verifyJwt(noKid, { audience: AUD });
  });
  await withHarness({}, [es, rs], async ({ client }, claims) => {
    const noKid = signJwt({ key: es, claims: claims(), header: { kid: undefined } });
    await assert.rejects(client.verifyJwt(noKid, { audience: AUD }), rejected("unknown_key"));
  });
});

test("keys are cached: verifying again does not fetch, and a refresh interval later it does", async () => {
  await withHarness({ keysRefreshMs: 60_000 }, [es], async ({ fake, clock, metrics, client }, claims) => {
    const token = (): string => signJwt({ key: es, claims: claims() });
    await client.verifyJwt(token(), { audience: AUD });
    await client.verifyJwt(token(), { audience: AUD });
    assert.equal(fake.count("/.well-known/jwks.json"), 1);
    assert.equal(metrics.cacheCount("jwks", "hit"), 1);
    clock.advance(60_000);
    await client.verifyJwt(token(), { audience: AUD });
    assert.equal(fake.count("/.well-known/jwks.json"), 2);
  });
});

test("a key rotated in is found by reloading, but a stream of unknown kids is not a stream of fetches", async () => {
  const added = testKey("ES256", "es-rotated", true);
  await withHarness({ keysRefreshMs: 3_600_000 }, [es], async ({ fake, clock, client }, claims) => {
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    assert.equal(fake.count("/.well-known/jwks.json"), 1);
    clock.advance(31_000);                    // past the forced-reload spacing
    fake.jwks = () => ({ body: { keys: [es.jwk, added.jwk] } });
    await client.verifyJwt(signJwt({ key: added, claims: claims() }), { audience: AUD });
    assert.equal(fake.count("/.well-known/jwks.json"), 2, "the unknown kid forced one reload");

    const forged = (n: number): string => signJwt({ key: es, claims: claims(), header: { kid: `forged-${n}` } });
    for (let i = 0; i < 10; i++) await assert.rejects(client.verifyJwt(forged(i), { audience: AUD }), rejected("unknown_key"));
    assert.equal(fake.count("/.well-known/jwks.json"), 2, "within 30 s of the last reload no forged kid causes a fetch");
    clock.advance(30_000);
    await assert.rejects(client.verifyJwt(forged(99), { audience: AUD }), rejected("unknown_key"));
    assert.equal(fake.count("/.well-known/jwks.json"), 3, "after 30 s one more is allowed");
  });
});

test("an outage keeps verifying from the last key set, and past the stale window says unavailable, not forged", async () => {
  await withHarness({ keysRefreshMs: 60_000, keysStaleIfErrorMs: 600_000 }, [es], async ({ fake, clock, metrics, client }, claims) => {
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    fake.jwks = () => ({ status: 503, body: "" });
    clock.advance(61_000);
    const v = await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    assert.equal(v.claims.sub, "user-1");
    assert.equal(metrics.staleCount("jwks"), 1);
    clock.advance(600_000);
    await assert.rejects(
      client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD }),
      (err: unknown) => err instanceof IdentityUnavailableError && err.reason === "http_5xx",
    );
  });
});

test("a key set that cannot be used does not replace one that can", async () => {
  const cases: Array<[string, unknown]> = [
    ["no keys", { keys: [] }],
    ["only keys of a kind it does not verify with", { keys: [{ kty: "oct", kid: "k", k: "c2VjcmV0" }] }],
    ["only an encryption key", { keys: [{ ...es.jwk, use: "enc" }] }],
    ["a key that is not a key", { keys: [{ kty: "RSA", kid: "x" }, { kty: "EC", crv: "P-256", kid: "y", x: "AA" }, null, 3] }],
    ["not a key set", { nokeys: true }],
    ["not JSON", "<html>"],
  ];
  for (const [name, body] of cases) {
    await withHarness({ keysRefreshMs: 60_000 }, [es], async ({ fake, clock, metrics, client }, claims) => {
      await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
      fake.jwks = () => ({ body });
      clock.advance(61_000);
      const v = await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
      assert.equal(v.claims.sub, "user-1", name);
      assert.equal(metrics.upstreamCount("jwks", "bad_response"), 1, name);
      assert.equal(metrics.staleCount("jwks"), 1, name);
    });
  }
});

test("a key on a curve it does not verify with is not used", async () => {
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ format: "jwk" });
  await withHarness({}, [{ ...es, jwk: { ...p384, kid: "es-1", use: "sig" } }], async ({ client }, claims) => {
    await assert.rejects(
      client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD }),
      (err: unknown) => err instanceof IdentityUnavailableError && err.reason === "bad_response",
    );
  });
});

test("after a failed key refresh the held set is used for 5 s without asking again", async () => {
  await withHarness({ keysRefreshMs: 60_000 }, [es], async ({ fake, clock, client }, claims) => {
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    fake.jwks = () => ({ status: 503, body: "" });
    clock.advance(61_000);
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    assert.equal(fake.count("/.well-known/jwks.json"), 2, "one failed refresh");
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    assert.equal(fake.count("/.well-known/jwks.json"), 2, "inside the back-off: no request");
    clock.advance(5_000);
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    assert.equal(fake.count("/.well-known/jwks.json"), 3, "back-off over: asks again");
  });
});

test("concurrent first verifications make one key fetch and the rest wait on it", async () => {
  await withHarness({}, [es], async ({ fake, metrics, client }, claims) => {
    fake.jwks = () => ({ body: { keys: [es.jwk] }, delayMs: 60 });
    await Promise.all(Array.from({ length: 10 }, () => client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD })));
    assert.equal(fake.count("/.well-known/jwks.json"), 1);
    assert.equal(metrics.cacheCount("jwks", "miss"), 1);
    assert.equal(metrics.cacheCount("jwks", "coalesced"), 9);
  });
});

test("an unknown kid right after an ordinary refresh does not fetch the key set a second time", async () => {
  await withHarness({ keysRefreshMs: 60_000 }, [es], async ({ fake, clock, client }, claims) => {
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
    clock.advance(61_000);                    // the set is due for refresh anyway
    const forged = signJwt({ key: es, claims: claims(), header: { kid: "nobody" } });
    await assert.rejects(client.verifyJwt(forged, { audience: AUD }), rejected("unknown_key"));
    assert.equal(fake.count("/.well-known/jwks.json"), 2, "the refresh already had its say about that kid");
  });
});

// The public half of a real 1024-bit RSA key, kept as data: the private key was
// discarded, and no key under 2048 bits is generated anywhere in this suite. A
// token that claims this key is signed with the 2048-bit test key instead; the
// property under test is only that the published key is not one the client will
// verify with.
const WEAK_RSA_1024_N =
  "uPybX-dDg0qCidIQGTi0GnQ2mrj22tRE5vRUr_nJ5n4uemWqJ-ZqmhrcQQTnliIrnwfZxJaWmdO2riHO9WfuaLAg7qDIUC4UStW9mLQWgn37yZt2xh37w5MKB1erHzk_Mc6Gkz6YT7ay7u5lBAKSV0S2xzjL_HcX8uS3RL7ZgYU";

test("an RSA key under 2048 bits is not used, so a token signed with it proves nothing", async () => {
  const weakJwk = { kty: "RSA", n: WEAK_RSA_1024_N, e: "AQAB", kid: "weak", use: "sig", alg: "RS256" };
  // The fixture is what it says: without this the test could go vacuous quietly.
  assert.equal(createPublicKey({ key: weakJwk, format: "jwk" }).asymmetricKeyDetails?.modulusLength, 1024);
  const weakKey: TestKey = { kid: "weak", alg: "RS256", privateKey: rs.privateKey, jwk: weakJwk };
  // Published beside a good key: the set is usable, the weak key is not in it.
  await withHarness({}, [weakKey, es], async ({ client }, claims) => {
    await assert.rejects(client.verifyJwt(signJwt({ key: weakKey, claims: claims() }), { audience: AUD }), rejected("unknown_key"));
    await client.verifyJwt(signJwt({ key: es, claims: claims() }), { audience: AUD });
  });
  // Published alone: there is no usable key at all.
  await withHarness({}, [weakKey], async ({ client }, claims) => {
    await assert.rejects(
      client.verifyJwt(signJwt({ key: weakKey, claims: claims() }), { audience: AUD }),
      (err: unknown) => err instanceof IdentityUnavailableError && err.reason === "bad_response",
    );
  });
});
