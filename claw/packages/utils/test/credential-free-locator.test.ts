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
