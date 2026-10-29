// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The identity client's environment. The first property is the one the rest
 * depend on: with nothing set, there is no client, and no setting can switch one
 * on by accident.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_DEFAULTS, readIdentityConfig } from "../src/index.js";

const REQUIRED = {
  IDENTITY_CLIENT_ENABLED: "true",
  IDENTITY_ISSUER_URL: "https://idp.example.com",
  IDENTITY_CLIENT_ID: "svc-claw",
  IDENTITY_CLIENT_SECRET: "secret-value",
};

test("it is off unless explicitly enabled, whatever else is set", async () => {
  for (const enabled of [undefined, "", "false", "0", "no", "off", "enabled", "TRUEISH"]) {
    const env = { ...REQUIRED, IDENTITY_CLIENT_ENABLED: enabled };
    const c = readIdentityConfig(env);
    assert.equal(c.enabled, false, String(enabled));
    assert.equal(c.settings, null);
    assert.deepEqual(c.errors, []);
  }
  assert.equal(readIdentityConfig({}).enabled, false);
});

test("the switch reads true, 1 and yes in any case, blanks trimmed", () => {
  for (const v of ["true", "TRUE", "1", "yes", "Yes", " true "]) {
    assert.equal(readIdentityConfig({ ...REQUIRED, IDENTITY_CLIENT_ENABLED: v }).enabled, true, v);
  }
});

test("enabled with the three required values it takes the shipped defaults", () => {
  const c = readIdentityConfig(REQUIRED);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.problems, []);
  assert.ok(c.settings);
  assert.equal(c.settings.issuerUrl, "https://idp.example.com");
  assert.equal(c.settings.clientId, "svc-claw");
  assert.equal(c.settings.clientSecret, "secret-value");
  assert.equal(c.settings.positiveTtlMs, 30_000);
  assert.equal(c.settings.negativeTtlMs, 5_000);
  assert.equal(c.settings.staleIfErrorMs, 30 * 60_000);
  assert.equal(c.settings.requestTimeoutMs, 5_000);
  assert.equal(c.settings.keysRefreshMs, 300_000);
  assert.equal(c.settings.exchangeRefreshSkewMs, 30_000);
  assert.equal(c.settings.discoveryUrl, undefined);
  assert.equal(c.settings.introspectionUrl, undefined);
  assert.deepEqual(
    { p: c.settings.positiveTtlMs, n: c.settings.negativeTtlMs, s: c.settings.staleIfErrorMs },
    { p: IDENTITY_DEFAULTS.positiveTtlMs, n: IDENTITY_DEFAULTS.negativeTtlMs, s: IDENTITY_DEFAULTS.staleIfErrorMs },
  );
});

test("a missing required value is an error that names it, and no settings are returned", () => {
  for (const missing of ["IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET"]) {
    for (const blank of [undefined, "", "   "]) {
      const c = readIdentityConfig({ ...REQUIRED, [missing]: blank });
      assert.equal(c.enabled, true);
      assert.equal(c.settings, null, `${missing}=${JSON.stringify(blank)}`);
      assert.equal(c.errors.length, 1);
      assert.match(c.errors[0] ?? "", new RegExp(missing));
    }
  }
  assert.equal(readIdentityConfig({ IDENTITY_CLIENT_ENABLED: "true" }).errors.length, 3);
});

test("an address must be a plain http(s) URL", () => {
  for (const key of ["IDENTITY_ISSUER_URL", "IDENTITY_DISCOVERY_URL", "IDENTITY_INTROSPECTION_URL", "IDENTITY_TOKEN_URL", "IDENTITY_JWKS_URL"]) {
    for (const bad of ["ftp://idp.example.com", "idp.example.com", "https://user:pw@idp.example.com", "https://idp.example.com/#frag", "file:///etc/passwd"]) {
      const c = readIdentityConfig({ ...REQUIRED, [key]: bad });
      assert.equal(c.settings, null, `${key}=${bad}`);
      assert.match(c.errors.join(";"), new RegExp(key));
    }
    const ok = readIdentityConfig({ ...REQUIRED, [key]: "http://idp.svc.cluster.local:8080/path" });
    assert.deepEqual(ok.errors, [], key);
  }
});

test("the optional addresses are carried through", () => {
  const c = readIdentityConfig({
    ...REQUIRED,
    IDENTITY_DISCOVERY_URL: "http://idp.svc/.well-known/openid-configuration",
    IDENTITY_INTROSPECTION_URL: "http://idp.svc/introspect",
    IDENTITY_TOKEN_URL: "http://idp.svc/token",
    IDENTITY_JWKS_URL: "http://idp.svc/jwks",
  });
  assert.equal(c.settings?.discoveryUrl, "http://idp.svc/.well-known/openid-configuration");
  assert.equal(c.settings?.introspectionUrl, "http://idp.svc/introspect");
  assert.equal(c.settings?.tokenUrl, "http://idp.svc/token");
  assert.equal(c.settings?.jwksUrl, "http://idp.svc/jwks");
});

test("numeric settings are in the unit their name says", () => {
  const c = readIdentityConfig({
    ...REQUIRED,
    IDENTITY_INTROSPECTION_CACHE_SECONDS: "45",
    IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "2",
    IDENTITY_STALE_IF_ERROR_SECONDS: "600",
    IDENTITY_REQUEST_TIMEOUT_MS: "1500",
    IDENTITY_KEYS_REFRESH_SECONDS: "120",
    IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS: "10",
  });
  assert.deepEqual(c.problems, []);
  assert.equal(c.settings?.positiveTtlMs, 45_000);
  assert.equal(c.settings?.negativeTtlMs, 2_000);
  assert.equal(c.settings?.staleIfErrorMs, 600_000);
  assert.equal(c.settings?.requestTimeoutMs, 1_500);
  assert.equal(c.settings?.keysRefreshMs, 120_000);
  assert.equal(c.settings?.exchangeRefreshSkewMs, 10_000);
});

test("zero turns caching or stale serving off where that is meaningful", () => {
  const c = readIdentityConfig({
    ...REQUIRED,
    IDENTITY_INTROSPECTION_CACHE_SECONDS: "0",
    IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0",
    IDENTITY_STALE_IF_ERROR_SECONDS: "0",
  });
  assert.deepEqual(c.problems, []);
  assert.equal(c.settings?.positiveTtlMs, 0);
  assert.equal(c.settings?.negativeTtlMs, 0);
  assert.equal(c.settings?.staleIfErrorMs, 0);
});

test("a value outside its range or not a whole number is refused and the default used", () => {
  const cases: Array<[string, string, keyof NonNullable<ReturnType<typeof readIdentityConfig>["settings"]>, number]> = [
    ["IDENTITY_INTROSPECTION_CACHE_SECONDS", "3601", "positiveTtlMs", 30_000],
    ["IDENTITY_INTROSPECTION_CACHE_SECONDS", "-1", "positiveTtlMs", 30_000],
    ["IDENTITY_INTROSPECTION_CACHE_SECONDS", "30s", "positiveTtlMs", 30_000],
    ["IDENTITY_INTROSPECTION_CACHE_SECONDS", "1.5", "positiveTtlMs", 30_000],
    ["IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS", "301", "negativeTtlMs", 5_000],
    ["IDENTITY_STALE_IF_ERROR_SECONDS", "86401", "staleIfErrorMs", 1_800_000],
    ["IDENTITY_REQUEST_TIMEOUT_MS", "99", "requestTimeoutMs", 5_000],
    ["IDENTITY_REQUEST_TIMEOUT_MS", "60001", "requestTimeoutMs", 5_000],
    ["IDENTITY_KEYS_REFRESH_SECONDS", "29", "keysRefreshMs", 300_000],
    ["IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS", "601", "exchangeRefreshSkewMs", 30_000],
  ];
  for (const [key, value, field, fallback] of cases) {
    const c = readIdentityConfig({ ...REQUIRED, [key]: value });
    assert.equal(c.settings?.[field], fallback, `${key}=${value}`);
    assert.equal(c.problems.length, 1, `${key}=${value}`);
    assert.match(c.problems[0] ?? "", new RegExp(key));
    assert.deepEqual(c.errors, []);
  }
});

test("a blank numeric setting is an absent one", () => {
  const c = readIdentityConfig({ ...REQUIRED, IDENTITY_INTROSPECTION_CACHE_SECONDS: "", IDENTITY_REQUEST_TIMEOUT_MS: "  " });
  assert.deepEqual(c.problems, []);
  assert.equal(c.settings?.positiveTtlMs, 30_000);
  assert.equal(c.settings?.requestTimeoutMs, 5_000);
});

test("nothing is read while disabled, so a bad value cannot break a disabled process", () => {
  const c = readIdentityConfig({ IDENTITY_ISSUER_URL: "not a url", IDENTITY_REQUEST_TIMEOUT_MS: "banana" });
  assert.deepEqual(c, { enabled: false, settings: null, errors: [], problems: [] });
});
