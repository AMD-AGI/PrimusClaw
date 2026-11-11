// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bot Framework token validation. The one security control on the public surface.
 *
 * A port of the Python Function's tests/test_auth.py: every test here carries the name of the Python test it ports, and
 * each parametrized case is a subtest named after its parameter (ported-tests/ingress.txt lists them).
 * Tokens are signed with a throwaway RSA key and verified by the real `validate`; only the fetch of the signing key is
 * replaced, so nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SECURITY_FIELD_CATEGORIES } from "@primusclaw/personal-agent";
import {
  ConnectorHosts,
  DEFAULT_HOSTS,
  DEFAULT_SUFFIXES,
  UnaddressableError,
} from "@primusclaw/personal-agent-teams/connector-hosts";

import { Auth, AuthError, authSettings } from "../src/auth.js";
import { type Env } from "../src/env.js";
import { type VerificationKey } from "../src/jwt.js";
import { coreLogger } from "../src/log.js";
import { functionFiles } from "../../../scripts/build-ingress.js";
import {
  claims as withClaims,
  encodeJwt,
  hmacForgery,
  type KeyPair,
  noNetwork,
  now,
  nth,
  rejects,
  rsaKey,
  unsignedJwt,
} from "./helpers.js";

const APP_ID = "00000000-0000-0000-0000-0000000000a1";
const SERVICE_URL = "https://smba.trafficmanager.net/teams/";
const ISSUER = "https://api.botframework.com";

const KEY = rsaKey();

function fakeKeys(auth: Auth, key: VerificationKey): void {
  auth.jwks = { client: () => Promise.resolve({ getSigningKeyFromJwt: () => Promise.resolve(key) }) };
}

/** auth.py imported with `env` (BOT_OPENID_CONFIG_URL and BOT_TOKEN_ISSUERS unset unless given). */
function load(env: Env = {}, errors: string[] = []): Auth {
  const auth = new Auth(
    authSettings(
      env,
      coreLogger((record) => errors.push(record.message), "connector_hosts"),
    ),
    noNetwork,
  );
  fakeKeys(auth, KEY.jwk);
  return auth;
}

function token(key: KeyPair, overrides: Record<string, unknown> = {}): string {
  return encodeJwt(withClaims({ iss: ISSUER, aud: APP_ID, exp: now() + 600, serviceurl: SERVICE_URL }, overrides), key);
}

function check(
  auth: Auth,
  key: KeyPair,
  options: { serviceUrl?: unknown; appId?: string } = {},
  overrides: Record<string, unknown> = {},
) {
  const serviceUrl = "serviceUrl" in options ? options.serviceUrl : SERVICE_URL;
  return auth.validate(`Bearer ${token(key, overrides)}`, options.appId ?? APP_ID, serviceUrl);
}

async function refused(promise: Promise<unknown>, pattern?: RegExp): Promise<AuthError> {
  const error = await rejects(promise, pattern ?? /./);
  assert.ok(error instanceof AuthError, `expected an AuthError, got ${error}`);
  return error;
}

test("test_a_valid_token_is_accepted", async () => {
  const claims = await check(load(), KEY);
  assert.equal(claims.aud, APP_ID);
});

test("test_the_bearer_scheme_is_case_insensitive", async () => {
  assert.ok(await load().validate(`bearer ${token(KEY)}`, APP_ID, SERVICE_URL));
});

test("test_a_missing_or_malformed_header_is_refused", async (t) => {
  for (const header of [null, "", "Basic abc", "Bearer", "token"]) {
    await t.test(String(header), async () => {
      await refused(load().validate(header, APP_ID, SERVICE_URL), /missing bearer token/);
    });
  }
});

test("test_an_unconfigured_app_id_refuses_everything", async () => {
  await refused(check(load(), KEY, { appId: "" }), /not configured/);
});

test("test_a_token_for_another_audience_is_refused", async () => {
  await refused(check(load(), KEY, {}, { aud: "someone-elses-bot" }), /token rejected/);
});

test("test_a_token_from_another_issuer_is_refused", async (t) => {
  for (const issuer of [
    "https://sts.windows.net/tenant/",
    "https://login.microsoftonline.com/t/v2.0",
    "https://api.botframework.com.evil.com",
    "",
  ]) {
    await t.test(issuer || "(empty)", async () => {
      await refused(check(load(), KEY, {}, { iss: issuer }), /unexpected issuer/);
    });
  }
});

test("test_an_expired_token_is_refused", async () => {
  await refused(check(load(), KEY, {}, { exp: now() - 60 }), /token rejected/);
});

test("test_a_token_without_a_required_claim_is_refused", async (t) => {
  for (const missing of ["exp", "iss", "aud"]) {
    await t.test(missing, async () => {
      await refused(check(load(), KEY, {}, { [missing]: null }), /token rejected/);
    });
  }
});

test("test_a_token_signed_by_another_key_is_refused", async () => {
  const other = rsaKey();
  await refused(load().validate(`Bearer ${token(other)}`, APP_ID, SERVICE_URL), /token rejected/);
});

test("test_an_unsigned_token_is_refused", async () => {
  const unsigned = unsignedJwt({ iss: ISSUER, aud: APP_ID, exp: now() + 600 });
  await refused(load().validate(`Bearer ${unsigned}`, APP_ID, SERVICE_URL), /token rejected/);
});

test("test_a_token_signed_with_the_public_key_as_an_hmac_secret_is_refused", async () => {
  // The classic algorithm-confusion forgery, assembled by hand.
  const forged = hmacForgery({ iss: ISSUER, aud: APP_ID, exp: now() + 600 }, KEY);
  await refused(load().validate(`Bearer ${forged}`, APP_ID, SERVICE_URL), /token rejected/);
});

test("test_garbage_after_bearer_is_refused", async () => {
  await refused(load().validate("Bearer not.a.jwt", APP_ID, SERVICE_URL), /token rejected/);
});

test("test_a_failure_to_fetch_the_signing_keys_fails_closed", async () => {
  const auth = load();
  auth.jwks = {
    client: () => Promise.reject(new Error("metadata endpoint unreachable")),
  };
  await refused(check(auth, KEY), /token rejected/);
});

test("test_the_service_url_claim_must_match_the_activity", async () => {
  await refused(check(load(), KEY, { serviceUrl: "https://evil.example.com/" }), /serviceUrl claim does not match/);
});

test("test_a_trailing_slash_does_not_change_the_service_url", async () => {
  assert.ok(await check(load(), KEY, { serviceUrl: SERVICE_URL.replace(/\/+$/, "") }));
  assert.ok(await check(load(), KEY, { serviceUrl: SERVICE_URL }, { serviceurl: SERVICE_URL.replace(/\/+$/, "") }));
});

test("test_the_camel_case_service_url_claim_is_checked_too", async () => {
  await refused(
    check(load(), KEY, {}, { serviceurl: null, serviceUrl: "https://other.example.com/" }),
    /serviceUrl claim does not match/,
  );
});

test("test_issuers_can_be_widened_by_configuration", () => {
  const auth = load({ BOT_TOKEN_ISSUERS: "https://api.botframework.com; https://sts.example.com/" });
  assert.deepEqual(auth.issuers, ["https://api.botframework.com", "https://sts.example.com/"]);
});

// --- serviceUrl: required, bound to the activity, and on Microsoft's hosts (security review) ------------------------

test("test_a_token_without_a_service_url_claim_is_refused", async () => {
  const error = await refused(check(load(), KEY, {}, { serviceurl: null }), /no serviceUrl claim/);
  assert.equal(error.reason, "service_url");
});

test("test_an_empty_or_non_string_service_url_claim_is_refused", async (t) => {
  for (const claim of ["", 42, ["https://smba.trafficmanager.net/teams/"]]) {
    await t.test(JSON.stringify(claim), async () => {
      const error = await refused(check(load(), KEY, {}, { serviceurl: claim }));
      assert.equal(error.reason, "service_url");
    });
  }
});

test("test_an_activity_without_a_service_url_is_refused", async (t) => {
  for (const serviceUrl of [null, "", 42, { url: SERVICE_URL }]) {
    await t.test(JSON.stringify(serviceUrl), async () => {
      const error = await refused(check(load(), KEY, { serviceUrl }));
      assert.equal(error.reason, "service_url");
    });
  }
});

test("test_a_service_url_off_the_allow_list_is_refused_even_when_the_claim_matches", async (t) => {
  for (const serviceUrl of [
    "https://attacker.trafficmanager.net/teams/", // anyone can register names under trafficmanager.net
    "https://evil.example.com/",
    "https://smba.trafficmanager.net.evil.com/teams/", // a suffix trick
    "https://evilbotframework.com/", // the suffix must start at a label boundary
    "http://smba.trafficmanager.net/teams/", // not https
    "https://smba.trafficmanager.net:8443/teams/",
    "https://smba.trafficmanager.net:notaport/teams/",
    "https://user:pw@smba.trafficmanager.net/teams/",
  ]) {
    await t.test(serviceUrl, async () => {
      // A correctly signed token whose claim names the same host: the allow-list is what refuses it.
      const error = await refused(
        check(load(), KEY, { serviceUrl }, { serviceurl: serviceUrl }),
        /serviceUrl is not allowed/,
      );
      assert.equal(error.reason, "service_url");
    });
  }
});

test("test_microsofts_connector_hosts_are_accepted", async (t) => {
  for (const serviceUrl of [
    "https://smba.trafficmanager.net/emea/",
    "https://webchat.botframework.com/",
    "https://smba.infra.gov.teams.microsoft.us/gcch",
    "https://SMBA.trafficmanager.net/teams/",
  ]) {
    await t.test(serviceUrl, async () => {
      assert.ok(await check(load(), KEY, { serviceUrl }, { serviceurl: serviceUrl }));
    });
  }
});

test("test_the_allow_list_is_the_workers_rule", () => {
  // One rule: the defaults are the worker's own (@primusclaw/personal-agent-teams/connector-hosts, which its direct
  // delivery applies), imported, not copied, so the ingress and the worker cannot drift apart.
  assert.deepEqual([...DEFAULT_HOSTS], ["smba.trafficmanager.net"]);
  assert.deepEqual(
    [...DEFAULT_SUFFIXES],
    [".botframework.com", ".botframework.us", ".teams.microsoft.com", ".teams.microsoft.us"],
  );
  const auth = load();
  assert.ok(auth.serviceUrlHosts instanceof ConnectorHosts);
  assert.deepEqual(auth.serviceUrlHosts.hosts, DEFAULT_HOSTS);
  assert.deepEqual(auth.serviceUrlHosts.suffixes, DEFAULT_SUFFIXES);
});

test("test_publish_packages_the_shared_rule", async () => {
  // The deployable package is one bundle of src/main.ts and what it imports (scripts/build-ingress.ts): the worker's
  // rule is in it, and nothing else of the worker is.
  const files = await functionFiles();
  const bundle = nth(
    files.filter((f) => f.name === "dist/main.js"),
    0,
  ).data.toString("utf8");
  for (const piece of [...DEFAULT_SUFFIXES, "is not a Bot Connector host", "ignoring Bot Connector entry"]) {
    assert.ok(bundle.includes(piece), piece);
  }
  for (const worker of ["fastify", "buildWorker", "node:sqlite"]) assert.ok(!bundle.includes(worker), worker);
});

test("test_the_allow_list_can_be_tightened", async () => {
  const auth = load({ BOT_SERVICE_URL_SUFFIXES: "" });
  assert.deepEqual(auth.serviceUrlHosts.suffixes, []);
  const webchat = "https://webchat.botframework.com/";
  await refused(
    auth.validate(`Bearer ${token(KEY, { serviceurl: webchat })}`, APP_ID, webchat),
    /serviceUrl is not allowed/,
  );
  assert.ok(await auth.validate(`Bearer ${token(KEY)}`, APP_ID, SERVICE_URL));
});

test("test_the_allow_list_can_be_extended", () => {
  const auth = load({
    BOT_SERVICE_URL_HOSTS: "smba.trafficmanager.net; bots.contoso.example",
    BOT_SERVICE_URL_SUFFIXES: "*.botframework.com,.teams.contoso.example",
  });
  assert.deepEqual(auth.serviceUrlHosts.hosts, ["smba.trafficmanager.net", "bots.contoso.example"]);
  assert.deepEqual(auth.serviceUrlHosts.suffixes, [".botframework.com", ".teams.contoso.example"]);
  auth.serviceUrlHosts.check("https://bots.contoso.example/x");
  auth.serviceUrlHosts.check("https://a.teams.contoso.example/");
  assert.throws(() => {
    auth.serviceUrlHosts.check("https://webchat.botframework.us/");
  }, UnaddressableError);
});

test("test_a_malformed_allow_list_entry_is_ignored_not_widened", () => {
  const errors: string[] = [];
  const auth = load(
    {
      BOT_SERVICE_URL_SUFFIXES: ".net; *; com; .botframework.com",
      BOT_SERVICE_URL_HOSTS: "https://x.example; smba.trafficmanager.net",
    },
    errors,
  );
  assert.deepEqual(auth.serviceUrlHosts.suffixes, [".botframework.com"]);
  assert.deepEqual(auth.serviceUrlHosts.hosts, ["smba.trafficmanager.net"]);
  assert.throws(() => {
    auth.serviceUrlHosts.check("https://evil.net/");
  }, UnaddressableError);
  assert.equal(errors.length, 4);
});

// --- every refusal carries the category the security event log reports ----------------------------------------------

function refusal(auth: Auth, kind: string): () => Promise<unknown> {
  const other = rsaKey();
  const t = now();
  switch (kind) {
    case "missing_token":
      return () => auth.validate(null, APP_ID, SERVICE_URL);
    case "not_configured":
      return () => check(auth, KEY, { appId: "" });
    case "audience":
      return () => check(auth, KEY, {}, { aud: "someone-elses-bot" });
    case "issuer":
      return () => check(auth, KEY, {}, { iss: "https://sts.windows.net/tenant/" });
    case "expired":
      return () => check(auth, KEY, {}, { exp: t - 60 });
    case "not_yet_valid":
      return () => check(auth, KEY, {}, { nbf: t + 3600 });
    case "bad_signature":
      return () => auth.validate(`Bearer ${token(other)}`, APP_ID, SERVICE_URL);
    case "malformed":
      return () => auth.validate("Bearer not.a.jwt", APP_ID, SERVICE_URL);
    case "key_unavailable":
      auth.jwks = {
        client: () => Promise.reject(new Error("metadata endpoint unreachable")),
      };
      return () => check(auth, KEY);
    case "service_url":
      return () => check(auth, KEY, {}, { serviceurl: null });
    default:
      throw new Error(kind);
  }
}

test("test_each_refusal_names_its_category", async (t) => {
  for (const kind of [
    "missing_token",
    "not_configured",
    "audience",
    "issuer",
    "expired",
    "not_yet_valid",
    "bad_signature",
    "malformed",
    "key_unavailable",
    "service_url",
  ]) {
    await t.test(kind, async () => {
      const error = await refused(refusal(load(), kind)());
      assert.equal(error.reason, kind);
      assert.ok(SECURITY_FIELD_CATEGORIES["reason"]?.has(kind));
    });
  }
});
