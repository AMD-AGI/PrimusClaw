// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import {
  SECRETS_SOURCES,
  SecretsUnavailable,
  pyStrip,
  type SecretName,
  type SecretSource,
  type SecretsSourceName,
} from "@primusclaw/personal-agent";
import { type Env, EnvReader, pyRepr } from "./env.js";

/**
 * Where SECRETS_SOURCE=env finds each secret: an environment variable (its `PA_` name, or the older `TEAMS_` one, as
 * `settingSource` reads them), or (the GitHub App's key) the file it names.
 */
export const ENV_NAMES: Readonly<Record<SecretName, string>> = {
  TEAMS_ENCRYPTION_KEYS: "PA_ENCRYPTION_KEYS",
  TEAMS_EXCHANGE_CLIENT_SECRET: "PA_EXCHANGE_CLIENT_SECRET",
  FEEDBACK_GITHUB_APP_KEY: "FEEDBACK_GITHUB_KEY_FILE",
};

/** SECRETS_SOURCE: env (the default) or keyvault; a typo stops the worker. */
export function secretsSourceOf(env: Env): SecretsSourceName {
  const value = pyStrip(env["SECRETS_SOURCE"] ?? "").toLowerCase() || "env";
  const known = SECRETS_SOURCES.find((name) => name === value);
  if (known === undefined) {
    throw new SecretsUnavailable(`SECRETS_SOURCE must be one of ${SECRETS_SOURCES.join(", ")}, not ${pyRepr(value)}`);
  }
  return known;
}

/**
 * The secrets this configuration needs: the encryption keys always, the exchange's client secret when the exchange is
 * on, the GitHub App's key when the feedback App is configured.
 */
export function wantedSecrets(env: Env): SecretName[] {
  const read = new EnvReader(env);
  return [
    "TEAMS_ENCRYPTION_KEYS",
    ...(read.isOn("PA_EXCHANGE_ENABLED") ? (["TEAMS_EXCHANGE_CLIENT_SECRET"] as const) : []),
    ...(read.text("FEEDBACK_GITHUB_APP_ID") !== "" && read.text("FEEDBACK_GITHUB_INSTALLATION_ID") !== ""
      ? (["FEEDBACK_GITHUB_APP_KEY"] as const)
      : []),
  ];
}

/** SECRETS_SOURCE=env: the secrets from the environment (a Kubernetes Secret) and the mounted key file. */
export class EnvSecretSource implements SecretSource {
  readonly name = "env";

  constructor(
    private readonly env: Env,
    private readonly readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  ) {}

  load(names: readonly SecretName[]): Promise<ReadonlyMap<SecretName, string>> {
    // (a failure inside the executor is the promise's rejection, as for a source that reads over the network)
    return new Promise((resolve) => {
      resolve(this.read(names));
    });
  }

  private read(names: readonly SecretName[]): Map<SecretName, string> {
    const values = new Map<SecretName, string>();
    const read = new EnvReader(this.env);
    for (const name of names) {
      const variable = ENV_NAMES[name];
      const value = read.text(variable);
      if (value === "") throw new SecretsUnavailable(`environment variable ${read.source(variable)} is required`);
      values.set(name, name === "FEEDBACK_GITHUB_APP_KEY" ? this.keyFile(value) : value);
    }
    return values;
  }

  private keyFile(path: string): string {
    let text: string;
    try {
      text = pyStrip(this.readFile(path));
    } catch {
      throw new SecretsUnavailable(`FEEDBACK_GITHUB_KEY_FILE ${path} cannot be read`);
    }
    if (text === "") throw new SecretsUnavailable(`FEEDBACK_GITHUB_KEY_FILE ${path} is empty`);
    return text;
  }
}
