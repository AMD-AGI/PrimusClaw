// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { readIntSetting, type IntSettingBounds } from "../env-settings.js";
import { IDENTITY_DEFAULTS, type IdentityClientSettings } from "./client.js";

/**
 * The identity client's environment, read in one place for every process.
 *
 *   IDENTITY_CLIENT_ENABLED            off unless "true", "1" or "yes"
 *   IDENTITY_ISSUER_URL                the OIDC issuer identifier
 *   IDENTITY_CLIENT_ID / _SECRET       this service's own client credentials
 *   IDENTITY_DISCOVERY_URL             where to fetch the discovery document
 *   IDENTITY_INTROSPECTION_URL         pin an address instead of discovering it
 *   IDENTITY_TOKEN_URL                 (same)
 *   IDENTITY_JWKS_URL                  (same)
 *   IDENTITY_CREDENTIAL_RESOLVE_URL    (same, for resolving a user's external credential;
 *                                      derived from the token endpoint when unset)
 *   IDENTITY_INTROSPECTION_CACHE_SECONDS            positive TTL, default 30
 *   IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS   negative TTL, default 5
 *   IDENTITY_STALE_IF_ERROR_SECONDS    default 1800; 0 turns stale serving off
 *   IDENTITY_REQUEST_TIMEOUT_MS        default 5000
 *   IDENTITY_KEYS_REFRESH_SECONDS      discovery and key-set refresh, default 300
 *   IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS  default 30
 *
 * Everything but IDENTITY_CLIENT_ENABLED is ignored while it is off, so an
 * operator can leave the rest in place and flip one switch.
 */
export interface IdentityConfig {
  enabled: boolean;
  /** Present when enabled and `errors` is empty. */
  settings: IdentityClientSettings | null;
  /** Reasons an enabled client cannot be built. A process that was asked for one must not start without it. */
  errors: string[];
  /** Values that were refused and replaced by their default. */
  problems: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function text(env: Env, key: string): string {
  return env[key]?.trim() ?? "";
}

function isHttpUrl(value: string): boolean {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.hash;
}

export function readIdentityConfig(env: Env): IdentityConfig {
  const switchValue = text(env, "IDENTITY_CLIENT_ENABLED").toLowerCase();
  if (!["true", "1", "yes"].includes(switchValue)) {
    return { enabled: false, settings: null, errors: [], problems: [] };
  }

  const errors: string[] = [];
  const problems: string[] = [];

  const required = (key: string): string => {
    const v = text(env, key);
    if (!v) errors.push(`${key} is required when IDENTITY_CLIENT_ENABLED is true`);
    return v;
  };
  const url = (key: string, mandatory: boolean): string | undefined => {
    const v = mandatory ? required(key) : text(env, key);
    if (!v) return undefined;
    if (!isHttpUrl(v)) {
      errors.push(`${key} must be an http(s) URL without credentials or a fragment`);
      return undefined;
    }
    return v;
  };
  const num = (key: string, fallback: number, unit: number, bounds: IntSettingBounds): number => {
    const setting = readIntSetting(env[key], { wholeNumbersOnly: true, ...bounds });
    if (setting === null) return fallback;
    if ("problem" in setting) {
      problems.push(`${key}=${text(env, key)} ${setting.problem}; using ${fallback / unit}`);
      return fallback;
    }
    return setting.value * unit;
  };

  const issuerUrl = url("IDENTITY_ISSUER_URL", true);
  const clientId = required("IDENTITY_CLIENT_ID");
  const clientSecret = required("IDENTITY_CLIENT_SECRET");
  const discoveryUrl = url("IDENTITY_DISCOVERY_URL", false);
  const introspectionUrl = url("IDENTITY_INTROSPECTION_URL", false);
  const tokenUrl = url("IDENTITY_TOKEN_URL", false);
  const jwksUrl = url("IDENTITY_JWKS_URL", false);
  const credentialResolveUrl = url("IDENTITY_CREDENTIAL_RESOLVE_URL", false);

  const d = IDENTITY_DEFAULTS;
  const settings: IdentityClientSettings = {
    issuerUrl: issuerUrl ?? "",
    clientId,
    clientSecret,
    discoveryUrl,
    introspectionUrl,
    tokenUrl,
    jwksUrl,
    credentialResolveUrl,
    positiveTtlMs: num("IDENTITY_INTROSPECTION_CACHE_SECONDS", d.positiveTtlMs, 1000, { min: 0, max: 3600 }),
    negativeTtlMs: num("IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS", d.negativeTtlMs, 1000, { min: 0, max: 300 }),
    staleIfErrorMs: num("IDENTITY_STALE_IF_ERROR_SECONDS", d.staleIfErrorMs, 1000, { min: 0, max: 86_400 }),
    requestTimeoutMs: num("IDENTITY_REQUEST_TIMEOUT_MS", d.requestTimeoutMs, 1, { min: 100, max: 60_000 }),
    keysRefreshMs: num("IDENTITY_KEYS_REFRESH_SECONDS", d.keysRefreshMs, 1000, { min: 30, max: 86_400 }),
    keysStaleIfErrorMs: d.keysStaleIfErrorMs,
    exchangeRefreshSkewMs: num("IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS", d.exchangeRefreshSkewMs, 1000, { min: 0, max: 600 }),
  };
  return { enabled: true, settings: errors.length === 0 ? settings : null, errors, problems };
}
