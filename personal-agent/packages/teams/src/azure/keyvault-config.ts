// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What SECRETS_SOURCE=keyvault reads and from where: the vault's address (KEYVAULT_URL, checked), the secrets this
 * configuration needs (`wanted`), the vault entry each one is stored under (`VAULT_NAMES`), and the environment
 * setting each one replaces (`ENV_NAMES`, named in a warning when it is set anyway).
 */
import { pyRstrip, type SecretName, SecretsUnavailable, pyStrip, own } from "@primusclaw/personal-agent";
import { SETTING_ALIASES, settingValue } from "@primusclaw/personal-agent-runtime";

export type Env = Readonly<Record<string, string | undefined>>;

export const KEYVAULT_SCOPE = "https://vault.azure.net/.default";
export const KEYVAULT_API_VERSION = "7.4";

/** The setting a secret replaces -> the name of the secret in the vault. */
export const VAULT_NAMES: Readonly<Record<SecretName, string>> = {
  TEAMS_ENCRYPTION_KEYS: "clawy-encryption-keys",
  TEAMS_EXCHANGE_CLIENT_SECRET: "clawy-exchange-client-secret",
  FEEDBACK_GITHUB_APP_KEY: "clawy-feedback-github-app-key",
};

/**
 * What the environment holds for each secret with SECRETS_SOURCE=env (the GitHub App key is a mounted file); the older
 * `TEAMS_` name of a `PA_` one is read too.
 */
export const ENV_NAMES: Readonly<Record<SecretName, string>> = {
  TEAMS_ENCRYPTION_KEYS: "PA_ENCRYPTION_KEYS",
  TEAMS_EXCHANGE_CLIENT_SECRET: "PA_EXCHANGE_CLIENT_SECRET",
  FEEDBACK_GITHUB_APP_KEY: "FEEDBACK_GITHUB_KEY_FILE",
};

function get(env: Env, name: string): string {
  return pyStrip(own(env, name) ?? "");
}

function on(raw: string): boolean {
  return ["1", "true", "yes", "on"].includes(pyStrip(raw).toLowerCase());
}

/**
 * The secrets this configuration needs: the encryption keys always, the exchange's client secret when the exchange is
 * on, the GitHub App key when the feedback App is configured (FEEDBACK_GITHUB_APP_ID and FEEDBACK_GITHUB_INSTALLATION_ID).
 */
export function wanted(env: Env): SecretName[] {
  const names: SecretName[] = ["TEAMS_ENCRYPTION_KEYS"];
  if (on(settingValue(env, "PA_EXCHANGE_ENABLED") ?? "")) names.push("TEAMS_EXCHANGE_CLIENT_SECRET");
  if (get(env, "FEEDBACK_GITHUB_APP_ID") && get(env, "FEEDBACK_GITHUB_INSTALLATION_ID")) {
    names.push("FEEDBACK_GITHUB_APP_KEY");
  }
  return names;
}

/** The environment settings `names` replace that are set anyway (either name of a pair): with keyvault they are ignored. */
export function shadowedSettings(env: Env, names: readonly SecretName[]): string[] {
  return names
    .flatMap((name) => {
      const setting = ENV_NAMES[name];
      const legacy = SETTING_ALIASES.get(setting);
      return legacy === undefined ? [setting] : [setting, legacy];
    })
    .filter((setting) => get(env, setting));
}

/** Python's `urlsplit`, the parts this check needs: scheme (lower case), host name (lower case), path and query. */
function splitUrl(url: string): { scheme: string; hostname: string; path: string; query: string } {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/.exec(url);
  if (match === null) return { scheme: "", hostname: "", path: url, query: "" };
  const netloc = match[2] ?? "";
  const hostPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const hostname = hostPort.startsWith("[") ? hostPort.slice(1, hostPort.indexOf("]")) : hostPort.split(":")[0];
  return {
    scheme: (match[1] ?? "").toLowerCase(),
    hostname: (hostname ?? "").toLowerCase(),
    path: match[3] ?? "",
    query: match[4] ?? "",
  };
}

/** The vault's host name, from a URL `vaultUrl` accepted. */
export function vaultHost(url: string): string {
  return splitUrl(url).hostname;
}

/** KEYVAULT_URL without a trailing slash: https, a <name>.vault.azure.net host, nothing after the host. */
export function vaultUrl(env: Env): string {
  const url = pyRstrip(get(env, "KEYVAULT_URL"), "/");
  const parts = splitUrl(url);
  if (parts.scheme !== "https" || !parts.hostname.endsWith(".vault.azure.net") || parts.path || parts.query) {
    throw new SecretsUnavailable(
      "SECRETS_SOURCE=keyvault needs KEYVAULT_URL: the vault's address, scheme https and host " +
        "<name>.vault.azure.net, nothing after the host",
    );
  }
  return url;
}
