// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, SecretsUnavailable, type SecretName } from "@primusclaw/personal-agent";
import { EnvSecretSource, pyRepr, readSettings, secretsSourceOf, wantedSecrets, type Env } from "../../src/index.js";

const BASE: Env = {
  CLAW_API_URL: "https://claw.example.com/claw-api",
  SAFE_API_URL: "https://safe.example.com",
  PUBLIC_BASE_URL: "https://claw.example.com",
};

describe("where the secrets come from", () => {
  it("the env source reads the environment and the key file, nothing from a vault", async () => {
    const files: string[] = [];
    const source = new EnvSecretSource(
      {
        TEAMS_ENCRYPTION_KEYS: " a,b ",
        TEAMS_EXCHANGE_CLIENT_SECRET: "s",
        FEEDBACK_GITHUB_KEY_FILE: "/k.pem",
        KEYVAULT_URL: "not even a url",
      },
      (path) => {
        files.push(path);
        return "-----BEGIN KEY-----\n";
      },
    );
    const values = await source.load([
      "TEAMS_ENCRYPTION_KEYS",
      "TEAMS_EXCHANGE_CLIENT_SECRET",
      "FEEDBACK_GITHUB_APP_KEY",
    ]);
    assert.deepEqual(Object.fromEntries(values), {
      TEAMS_ENCRYPTION_KEYS: "a,b",
      TEAMS_EXCHANGE_CLIENT_SECRET: "s",
      FEEDBACK_GITHUB_APP_KEY: "-----BEGIN KEY-----",
    });
    assert.deepEqual(files, ["/k.pem"]);
    assert.equal(source.name, "env");
    assert.equal(secretsSourceOf({ SECRETS_SOURCE: "ENV", KEYVAULT_URL: "not even a url" }), "env");
    assert.equal(secretsSourceOf({}), "env");
  });

  it("a secret the environment does not hold fails, naming it and never a value", async () => {
    await assert.rejects(new EnvSecretSource({}).load(["TEAMS_ENCRYPTION_KEYS"]), {
      name: "SecretsUnavailable",
      message: "environment variable PA_ENCRYPTION_KEYS is required",
    });
    const unreadable = new EnvSecretSource({ FEEDBACK_GITHUB_KEY_FILE: "/missing.pem" }, () => {
      throw new Error("ENOENT");
    });
    await assert.rejects(unreadable.load(["FEEDBACK_GITHUB_APP_KEY"]), SecretsUnavailable);
    const empty = new EnvSecretSource({ FEEDBACK_GITHUB_KEY_FILE: "/empty.pem" }, () => " \n");
    await assert.rejects(empty.load(["FEEDBACK_GITHUB_APP_KEY"]), /is empty/);
  });
});

describe("which secrets are read", () => {
  it("only the secrets the configuration uses are read", () => {
    assert.deepEqual(wantedSecrets({}), ["TEAMS_ENCRYPTION_KEYS"]);
    assert.deepEqual(
      wantedSecrets({
        TEAMS_EXCHANGE_ENABLED: "on",
        FEEDBACK_GITHUB_APP_ID: "1",
        FEEDBACK_GITHUB_INSTALLATION_ID: "2",
      }),
      ["TEAMS_ENCRYPTION_KEYS", "TEAMS_EXCHANGE_CLIENT_SECRET", "FEEDBACK_GITHUB_APP_KEY"],
    );
    assert.deepEqual(wantedSecrets({ FEEDBACK_GITHUB_APP_ID: "1", FEEDBACK_GITHUB_INSTALLATION_ID: "" }), [
      "TEAMS_ENCRYPTION_KEYS",
    ]);
  });

  it("a configuration that cannot work fails", () => {
    assert.throws(() => secretsSourceOf({ SECRETS_SOURCE: "vault" }), {
      name: "SecretsUnavailable",
      message: "SECRETS_SOURCE must be one of env, keyvault, not 'vault'",
    });
  });

  it("settings take the vault values and never the environment", () => {
    const vault = new Map<SecretName, string>([
      ["TEAMS_ENCRYPTION_KEYS", "VAULT-key-1,VAULT-key-2"],
      ["TEAMS_EXCHANGE_CLIENT_SECRET", "VAULT-secret"],
    ]);
    const env: Env = {
      ...BASE,
      SECRETS_SOURCE: "keyvault",
      TEAMS_EXCHANGE_ENABLED: "true",
      TEAMS_EXCHANGE_CLIENT_ID: "client",
      TEAMS_ENCRYPTION_KEYS: "STALE-env-key",
      TEAMS_EXCHANGE_CLIENT_SECRET: "STALE-env-secret",
    };
    const s = readSettings(env, vault);
    assert.equal(s.secretsSource, "keyvault");
    assert.deepEqual(s.encryptionKeys, ["VAULT-key-1", "VAULT-key-2"]);
    assert.equal(s.exchange.clientSecret, "VAULT-secret");
    assert.throws(
      () => readSettings(env),
      (err: unknown) => err instanceof ConfigError && err.message.includes("was not read from the vault"),
    );
  });
});

describe("pyRepr", () => {
  it("quotes a value the way Python's repr does", () => {
    assert.deepEqual(["a", "it's", 'say "hi"', "x\ny", "back\\slash", `both ' and "`].map(pyRepr), [
      "'a'",
      '"it\'s"',
      "'say \"hi\"'",
      "'x\\ny'",
      "'back\\\\slash'",
      "'both \\' and \"'",
    ]);
  });
});
