// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Telling a location from a credential, for values whose NAME says credential.
 *
 * `TOKEN_ENDPOINT` and `SSH_KEY_PATH` are what an OAuth client and an SSH
 * config are supposed to call these settings. The name rule reads both as
 * credentials -- correctly, as names go -- and collecting the value puts it on
 * a blind substring-replacement list applied to transcripts that are replayed
 * to the model. The endpoint then vanished from every command that called it
 * and the path from every command that read it.
 *
 * This predicate is the exemption, and both directions matter: a URL with
 * inline userinfo, a credential in a query parameter, or a documented vendor
 * shape anywhere in the value means the value really is a secret and must keep
 * being collected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isCredentialFreeLocator } from "../src/index.js";

test("an endpoint URL is a location", () => {
  for (const value of [
    "https://example.invalid/oauth/token",
    "https://login.example.invalid/v2/oauth2/token?audience=api",
    "http://127.0.0.1:8080/healthz",
    "wss://events.example.invalid/stream",
    "https://example.invalid/",
  ]) {
    assert.equal(isCredentialFreeLocator(value), true, value);
  }
});

test("a filesystem path is a location", () => {
  for (const value of [
    "/home/user/.ssh/id_ed25519",
    "/etc/claw/api.key",
    "/workspace/project/src",
    "./build/out",
    "../shared/config.yaml",
    "~/.config/claw/settings.json",
  ]) {
    assert.equal(isCredentialFreeLocator(value), true, value);
  }
});

test("a URL carrying inline userinfo is the credential", () => {
  // This is the case `database url` sits in the sensitive-pair list for.
  for (const value of [
    "postgres://svc:Tr0ub4dor3@db.internal:5432/app",
    "redis://:hunter2@cache.internal:6379/0",
    "https://user@example.invalid/repo.git",
  ]) {
    assert.equal(isCredentialFreeLocator(value), false, value);
  }
});

test("a credential in the query string is still a credential", () => {
  for (const value of [
    "https://example.invalid/v1?access_token=Xk9mzPl2vQr7TnA4",
    "https://example.invalid/v1?api_key=Zq7Wm2Rt9Kd4Nb6H",
    "https://example.invalid/v1?x=Xk9mzPl2vQr7TnA4",
  ]) {
    assert.equal(isCredentialFreeLocator(value), false, value);
  }
});

test("a vendor shape anywhere in the value keeps the whole value a secret", () => {
  for (const value of [
    `/opt/creds/sk-ant-${"a".repeat(40)}`,
    `https://example.invalid/hf_${"b".repeat(34)}`,
  ]) {
    assert.equal(isCredentialFreeLocator(value), false, value);
  }
});

test("anything that is not a location is not exempted", () => {
  // The predicate answers one narrow question and declines everything else,
  // so a value it has no opinion about keeps being collected.
  for (const value of [
    "Tr0ub4dor&3x", "hunter2", "", "not a url", "example.invalid/path",
    "relative/path/without/a/leading/slash",
    "/etc/creds/Xk9mzPl2vQr7TnA4",
  ]) {
    assert.equal(isCredentialFreeLocator(value), false, JSON.stringify(value));
  }
});

// ── A query parameter is not a credential because it is escaped ────────────

test("an ordinary redirect_uri survives its own percent-encoding", () => {
  // Encoded, `https%3A%2F%2Fapp.example%2Fcb` satisfies every clause of
  // looksLikeCredentialValue: the upper-case letters are the hex digits of
  // `%3A` and `%2F` and the symbols are the percent signs. An OAuth client is
  // required to send this parameter, and reading it as a key deleted the
  // authorization URL out of the transcript.
  assert.equal(
    isCredentialFreeLocator(
      "https://login.example.invalid/oauth?redirect_uri=https%3A%2F%2Fapp.example%2Fcb",
    ),
    true,
  );
  assert.equal(
    isCredentialFreeLocator("https://example.invalid/a?next=%2Fdashboard%2Fhome"),
    true,
  );
  assert.equal(
    isCredentialFreeLocator(
      "https://example.invalid/oauth?client_id=web-app&scope=read%20write&state=abc",
    ),
    true,
  );
});

test("a credential in a query parameter is still a credential, encoded or not", () => {
  for (const url of [
    "https://example.invalid/v1?api_key=abc123",
    "https://example.invalid/v1?x=Xk9mzPl2vQr7TnA4",
    "https://example.invalid/v1?redirect_uri=https%3A%2F%2Fapp.example%2Fcb%3Ftoken%3DXk9mzPl2vQr7TnA4",
  ]) {
    assert.equal(isCredentialFreeLocator(url), false, url);
  }
});

// ── The half of a URL that never reaches the server ───────────────────────

test("a token in the fragment disqualifies the URL", () => {
  // The OAuth implicit flow returns the access token after the `#` precisely
  // because that half is not sent to the server. Dropping the fragment read
  // the whole callback URL as credential-free and left the token standing.
  for (const url of [
    "https://example.invalid/cb#access_token=Xk9mzPl2vQr7TnA4",
    "https://example.invalid/cb#Xk9mzPl2vQr7TnA4",
    "https://example.invalid/cb#state=ok&id_token=Xk9mzPl2vQr7TnA4",
  ]) {
    assert.equal(isCredentialFreeLocator(url), false, url);
  }
});

test("an ordinary fragment is still ordinary", () => {
  for (const url of [
    "https://example.invalid/docs/guide#section-2",
    "https://example.invalid/docs#installation",
    "https://example.invalid/oauth/token",
  ]) {
    assert.equal(isCredentialFreeLocator(url), true, url);
  }
});

test("the scheme/authority/path split does not backtrack", () => {
  // The path alternative used to be `[^?#]*`, which every character the
  // authority could match could also match -- so a non-matching input made
  // the engine try every split between the two, quadratically. This input is
  // the shape CodeQL named (`A://` then a long run of one character); it must
  // answer in constant-ish time, not seconds.
  const hostile = `A://${'"'.repeat(60_000)}`;
  const started = Date.now();
  // The verdict is beside the point -- there is no credential in 60,000 quote
  // marks either way. What is being asserted is that answering is cheap.
  assert.equal(typeof isCredentialFreeLocator(hostile), "boolean");
  assert.ok(Date.now() - started < 1_000,
    "a locator test must not be a way to stall the process");
});
