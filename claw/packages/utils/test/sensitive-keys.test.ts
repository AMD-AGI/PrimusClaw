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
  assertSensitive(["passwordHint", "tokenValue", "credentialsPath", "apiKeySecret"], true);
});

test("acronym runs split into words", () => {
  assertSensitive(["APIKey", "apikey", "APIKeyValue"], true);
});

test("a key that names a credential by id, name or prefix is not itself a credential", () => {
  // An approval card for apikey_delete {"apikey_id": 192} showed the id as
  // [REDACTED], so the approver could not see which key was being deleted.
  assertSensitive([
    "apikey_id", "apiKeyId", "APIKeyId", "apikey_name", "apiKeyName", "api_key_prefix",
    "apikey_uuid", "access_key_id", "accessKeyId", "credential_id", "credentialName",
    "token_name", "tokenPrefix",
  ], false);
  for (const value of [192, "claw5-gate-allow", null, undefined, true]) {
    assert.equal(isSensitiveKey("apikey_id", value), false, `apikey_id = ${String(value)}`);
  }
});

test("an id-named key whose value IS the credential stays masked", () => {
  // Vault AppRole secret_id, Consul/Nomad ACL SecretID and their env spellings
  // are the login secret itself, a plain UUID the shape scan cannot see.
  assertSensitive([
    "secret_id", "SecretID", "secretId", "VAULT_SECRET_ID", "ROLE_SECRET_ID", "secret_ids",
    "secretName", "secret_name", "password_id", "token_id", "tokenId", "auth_token_id",
    "openai_api_key_id", "AWS_SECRET_ACCESS_KEY", "id_token", "idToken", "api_key_id_secret",
    "apikey", "api_key", "apiKey", "client_secret", "access_token", "password",
  ], true);
  for (const key of ["secret_id", "SecretID", "VAULT_SECRET_ID"]) {
    assert.equal(isSensitiveKey(key, "6a1c2f3e-0b4d-4e5f-8a9b-0c1d2e3f4a5b"), true, key);
  }
  // A bare identifier word was never a credential and still is not.
  assertSensitive(["id", "name", "prefix", "uuid", "key_id"], false);
});

test("a container under an identifier-tailed key keeps masking its whole subtree", () => {
  // passwords_by_name {prod: "..."} is a map of passwords: the parent must be
  // sensitive, because the child keys (prod, "7") are not.
  for (const key of ["passwords_by_name", "secrets_by_id", "credentials_by_name", "api_keys_by_name", "access_tokens_by_id"]) {
    assert.equal(isSensitiveKey(key), true, key);
    assert.equal(isSensitiveKey(key, { prod: "XkjQmzPl" }), true, key);
  }
  // Even a listed identifier key is a label only as a scalar: an object or
  // array under it can hold anything, and is masked as a whole.
  assert.equal(isSensitiveKey("apikey_name", { prod: "XkjQmzPl" }), true);
  assert.equal(isSensitiveKey("apikey_id", ["XkjQmzPl"]), true);
  assert.equal(isSensitiveKey("credential_id", {}), true);
  // Bare `tokens` is the usage counter, so tokens_by_id was not sensitive on
  // main either; this change leaves it where it was.
  assert.equal(isSensitiveKey("tokens_by_id", { prod: "XkjQmzPl" }), false);
  // A tool whose name ends in an identifier word still masks its arguments.
  assert.equal(isSensitiveKey("mcp__vault__secret_by_id", { path: "x" }), true);
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

test("vendor spellings of 'password' are sensitive", () => {
  // The word list only works if it holds the words config files actually use.
  // Each of these is a password whose name does not contain "password":
  // Postgres writes it as one unsplittable run, MySQL abbreviates, OpenSSH
  // calls it a passphrase, and the Unix spelling drops the vowel.
  assertSensitive([
    "PGPASSWORD", "pgpassword", "pgPassword", "PGPASS",
    "MYSQL_PWD", "mysql_pwd", "mysqlPwd", "db_pwd", "pwd_hash", "mysql_pwd_hash",
    "SSH_PASSPHRASE", "ssh_passphrase", "sshPassphrase", "key_passphrase",
    "passphrases", "PASSWD", "passwd", "user_passwd",
  ], true);
});

test("adding the vendor spellings did not widen anything else", () => {
  // `pwd` is a word, not a substring, so a name that merely contains those
  // three letters is untouched -- which is the whole reason this file matches
  // by word. `password` remains the only thing being spelled differently.
  assertSensitive([
    "cwd", "upwd", "pwdless", "passphraseless", "passwdless",
    "pg_host", "pg_database", "mysql_host", "ssh_host", "ssh_port",
  ], false);
});

test("the standalone PWD variable is the working directory, not a password", () => {
  // PWD is in essentially every container's environment, and its value is a
  // path. Calling it sensitive collects that path as a secret, and a collected
  // secret is substring-replaced out of every transcript string the model is
  // replayed -- so `cd /workspace/project` comes back as `cd <redacted>`.
  // Losing a password costs a rotation; losing the working directory out of a
  // transcript costs the agent the ability to read its own history.
  assertSensitive(["PWD", "pwd", "OLDPWD", "oldpwd", "$PWD"], false);
  // Qualified by anything at all, it is a password again.
  assertSensitive([
    "MYSQL_PWD", "DB_PWD", "mysql_pwd_hash", "pwd_hash", "app.pwd",
  ], true);
});

test("a qualified credential name is sensitive in the plural too", () => {
  // `API_KEYS` and `ACCESS_TOKENS` are as much a credential as their
  // singulars, and both went straight through -- collection and response
  // header rejection alike -- because the rule spelled the head out letter for
  // letter and every plural had to be added by hand.
  for (const key of [
    "API_KEYS", "api_keys", "apiKeys", "x-api-keys",
    "ACCESS_TOKENS", "access_tokens", "accessTokens",
    "SSH_KEYS", "private_keys", "secret_keys", "signing_keys",
    "refresh_tokens", "bearer_tokens", "auth_tokens", "session_tokens",
  ]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
});

test("the usage counters keep their names in the plural", () => {
  // The reason `tokens` is not simply added to the word list. Every one of
  // these is a number the UI renders, and masking them blanks what a user
  // reads about their own run. `keys` is the same argument: most keys are map
  // keys and sort keys.
  for (const key of [
    "input_tokens", "output_tokens", "prompt_tokens", "completion_tokens",
    "max_tokens", "cached_tokens", "reasoning_tokens", "total_tokens",
    "x-ratelimit-remaining-tokens",
    "foreign_keys", "object_keys", "sort_keys", "partition_keys",
    "tokens", "TOKENS", "keys", "KEYS",
  ]) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});
