// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * isSensitiveKey is the half of redaction that catches credentials with no
 * recognisable shape, so its blind spots are silent: nothing fails, the value
 * simply travels. These cases pin the two properties that matter -- that a
 * credential is caught in every spelling a payload might use, and that a
 * counter or an unrelated word that merely contains "token" is not.
 *
 * The camelCase cases are the regression this list exists for. The predicate
 * was previously a regex anchored on `^`, `_` or `-`, which made `api_key`
 * sensitive but `accessToken` and `userPassword` invisible -- in a codebase
 * where agent-loop events and tool arguments are camelCase JS objects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSensitiveKey } from "../src/security/sensitive-keys.js";

function assertSensitive(keys: string[], expected: boolean): void {
  for (const key of keys) {
    assert.equal(isSensitiveKey(key), expected, `isSensitiveKey(${JSON.stringify(key)})`);
  }
}

test("snake_case and kebab-case credential names are sensitive", () => {
  assertSensitive([
    "api_key",
    "x-api-key",
    "platform_key",
    "virtual_key",
    "private_key",
    "access_token",
    "auth_token",
    "internal_token_hash",
    "token",
    "secret",
    "password",
    "authorization",
    "credential",
    "cookie",
    "OPENAI_API_KEY",
    "LLM_API_KEY",
  ], true);
});

test("camelCase credential names are sensitive", () => {
  // Every one of these was missed by the anchored regex this replaced.
  assertSensitive([
    "accessToken",
    "refreshToken",
    "authToken",
    "sessionToken",
    "bearerToken",
    "userPassword",
    "dbPassword",
    "apiSecret",
    "clientCredential",
    "openaiApiKey",
    "secretAccessKey",
    "signingKey",
  ], true);
});

test("a credential word is sensitive as a prefix as well as a suffix", () => {
  // Widening only the leading boundary would still have missed these: the word
  // is qualified on the right rather than the left.
  assertSensitive(["apiKeyId", "secretName", "passwordHint", "tokenValue", "credentialsPath"], true);
});

test("acronym runs split into words", () => {
  assertSensitive(["APIKey", "apikey", "APIKeyId"], true);
});

test("token counters are not credentials", () => {
  // tokenUsage rides in every agent_done payload and the UI reports it, so
  // redacting it would blank the usage numbers rather than protect anything.
  assertSensitive([
    "tokenUsage",
    "token_usage",
    "tokenCount",
    "token_count",
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "max_tokens",
    "maxTokens",
  ], false);
});

test("a word that merely contains a credential word is not sensitive", () => {
  assertSensitive(["tokenizer", "subtokenizer", "brokenLink", "keyboard", "foreign_key", "keyName"], false);
});

test("whole environment blocks are sensitive, narrowly", () => {
  assertSensitive(["env", "user_env", "session_env", "userEnv", "sessionEnv"], true);
  // `env` is matched as a whole key only: an environment *name* or a count of
  // variables is not a dump of their values.
  assertSensitive(["environment", "env_count", "envName"], false);
});

test("ordinary field names are untouched", () => {
  assertSensitive(["session_id", "taskId", "status", "created_at", "content", "command", "role"], false);
});

test("an empty or punctuation-only key is not sensitive", () => {
  assertSensitive(["", "_", "-", "..."], false);
});
