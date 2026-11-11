// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Bot Framework's signing keys, read the way PyJWT's PyJWKClient reads them (what the Python Function used): the
 * OpenID metadata names the JWKS, the key set is cached for five minutes, a token naming an unknown `kid` refetches it
 * (at most every 30 seconds), and up to 16 keys are kept by `kid`.
 */
import { type Clock, type Fetch } from "./env.js";
import { unverifiedKid, type VerificationKey } from "./jwt.js";
import { get, isObject, type JsonObject, rstripChars, truthy } from "./py.js";

const CONFIG_TTL_SECONDS = 3600;
// PyJWKClient's defaults, which the Python Function used.
const JWKS_LIFESPAN_SECONDS = 300;
const JWKS_COOLDOWN_SECONDS = 30;
const JWKS_MAX_CACHED_KEYS = 16;
const OPENID_TIMEOUT_MS = 15_000;
const JWKS_TIMEOUT_MS = 30_000;

/** A failure to read the signing keys (PyJWT's PyJWKClientError and PyJWKSetError). */
export class KeyClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyJWKClientError";
  }
}

interface StoredKey {
  kid: unknown;
  use: unknown;
  key: VerificationKey;
}

/** PyJWKSet.from_dict: the keys PyJWT can build, in order. */
function keySet(data: unknown): StoredKey[] {
  if (!isObject(data)) throw new KeyClientError("The JWKS endpoint did not return a JSON object");
  const keys = get(data, "keys") ?? [];
  if (!truthy(keys)) throw new KeyClientError("The JWK Set did not contain any keys");
  if (!Array.isArray(keys)) throw new KeyClientError("Invalid JWK Set value");
  const out: StoredKey[] = [];
  for (const jwk of keys) {
    if (!isObject(jwk)) continue;
    const key = verificationKey(jwk);
    if (key) out.push({ kid: get(jwk, "kid"), use: get(jwk, "use"), key });
  }
  if (!out.length) throw new KeyClientError("The JWK Set did not contain any usable keys");
  return out;
}

const RSA_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"]);
const OTHER_ALGORITHMS = new Set(["HS256", "HS384", "HS512", "ES256", "ES256K", "ES384", "ES512", "EdDSA", "Ed25519"]);
const B64URL_INT = /^[A-Za-z0-9_-]+={0,2}$/;
const EC_CURVES = new Map([
  ["P-256", "ES256"],
  ["P-384", "ES384"],
  ["P-521", "ES512"],
  ["secp256k1", "ES256K"],
]);

/** The algorithm PyJWK infers for a JWK without `alg`, or null when it cannot build the key. */
function inferredAlgorithm(kty: unknown, crv: unknown): string | null {
  if (kty === "EC") return truthy(crv) ? (EC_CURVES.get(String(crv)) ?? null) : "ES256";
  if (kty === "RSA") return "RS256";
  if (kty === "oct") return "HS256";
  if (kty === "OKP") return crv === "Ed25519" ? "EdDSA" : null;
  return null;
}

/** An RSA JWK as its public key, or null when PyJWK would not build it. */
function rsaKey(jwk: JsonObject): VerificationKey | null {
  if (get(jwk, "kty") !== "RSA") return null;
  const n = get(jwk, "n");
  const e = get(jwk, "e");
  if (typeof n !== "string" || typeof e !== "string" || !B64URL_INT.test(n) || !B64URL_INT.test(e)) return null;
  return { kty: "RSA", n: rstripChars(n, "="), e: rstripChars(e, "=") };
}

/**
 * The key PyJWK would build from a JWK, or null when it would skip it. An RSA key is kept as its public JWK; any other
 * usable type is kept as `other`, which an RS256 token can never verify against (PyJWT refuses it the same way).
 */
function verificationKey(jwk: JsonObject): VerificationKey | null {
  const kty = get(jwk, "kty");
  if (!truthy(kty)) return null;
  const given = get(jwk, "alg");
  const algorithm = truthy(given) ? given : inferredAlgorithm(kty, get(jwk, "crv"));
  if (typeof algorithm !== "string") return null;
  if (RSA_ALGORITHMS.has(algorithm)) return rsaKey(jwk);
  return OTHER_ALGORITHMS.has(algorithm) ? { kty: "other" } : null;
}

/** PyJWKClient(jwks_uri, cache_keys=True): a JWK set cached for five minutes and a per-kid LRU cache. */
export class KeyClient {
  private cached: { keys: StoredKey[]; at: number } | null = null;
  private lastFetch: number | null = null;
  private readonly byKid = new Map<string | undefined, VerificationKey>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly uri: string,
    private readonly fetchImpl: Fetch,
    private readonly clock: Clock,
  ) {
    let scheme = "";
    const colon = uri.indexOf(":");
    if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(uri.slice(0, colon))) scheme = uri.slice(0, colon).toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      throw new KeyClientError(`Invalid JWKS URI scheme '${scheme}': only 'http' and 'https' are supported.`);
    }
  }

  /** The key for the token's `kid` (the token is parsed first, as PyJWT does, so a malformed one is refused here). */
  async getSigningKeyFromJwt(token: string): Promise<VerificationKey> {
    return this.getSigningKey(unverifiedKid(token));
  }

  getSigningKey(kid: string | undefined): Promise<VerificationKey> {
    const cached = this.byKid.get(kid);
    if (cached) {
      this.byKid.delete(kid);
      this.byKid.set(kid, cached);
      return Promise.resolve(cached);
    }
    // One lookup at a time, like the client's lock: a burst of tokens for a new kid fetches the set once.
    const run = this.queue.then(() => this.lookup(kid));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async lookup(kid: string | undefined): Promise<VerificationKey> {
    const hit = this.byKid.get(kid);
    if (hit) return hit;
    let key = match(this.signingKeys(await this.keySet(false)), kid);
    if (!key) {
      const coolingDown = this.lastFetch !== null && this.clock.monotonic() - this.lastFetch < JWKS_COOLDOWN_SECONDS;
      if (!coolingDown) {
        key = match(this.signingKeys(await this.keySet(true)), kid);
        this.lastFetch = this.clock.monotonic();
      }
      if (!key) throw new KeyClientError(`Unable to find a signing key that matches: "${kid}"`);
    }
    this.byKid.set(kid, key);
    if (this.byKid.size > JWKS_MAX_CACHED_KEYS) this.byKid.delete(this.byKid.keys().next().value);
    return key;
  }

  private signingKeys(keys: StoredKey[]): StoredKey[] {
    const signing = keys.filter((k) => (k.use === "sig" || k.use === undefined || k.use === null) && truthy(k.kid));
    if (!signing.length) throw new KeyClientError("The JWKS endpoint did not contain any signing keys");
    return signing;
  }

  private async keySet(refresh: boolean): Promise<StoredKey[]> {
    if (!refresh && this.cached && this.clock.monotonic() - this.cached.at < JWKS_LIFESPAN_SECONDS) {
      return this.cached.keys;
    }
    let data: unknown;
    try {
      // urllib with redirects refused: anything but a 2xx answer is a failed fetch.
      const response = await this.fetchImpl(this.uri, {
        redirect: "manual",
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP Error ${String(response.status)}`);
      data = JSON.parse(await response.text());
    } catch (error) {
      throw new KeyClientError(`Fail to fetch data from the url, err: "${(error as Error).message}"`);
    }
    const keys = keySet(data);
    this.cached = { keys, at: this.clock.monotonic() };
    this.lastFetch = this.clock.monotonic();
    return keys;
  }
}

function match(keys: StoredKey[], kid: string | undefined): VerificationKey | undefined {
  return keys.find((k) => k.kid === kid)?.key;
}

/** Caches the signing-key client; the metadata document rotates slowly. */
export class JwksCache {
  private current: KeyClient | null = null;
  private fetchedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly openidConfigUrl: string,
    private readonly fetchImpl: Fetch,
    private readonly clock: Clock,
  ) {}

  client(): Promise<KeyClient> {
    const run = this.queue.then(() => this.load());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<KeyClient> {
    if (this.current && this.clock.monotonic() - this.fetchedAt < CONFIG_TTL_SECONDS) return this.current;
    const response = await this.fetchImpl(this.openidConfigUrl, { signal: AbortSignal.timeout(OPENID_TIMEOUT_MS) });
    if (response.status >= 400) throw new Error(`${String(response.status)} error fetching the OpenID configuration`);
    const config: unknown = JSON.parse(await response.text());
    if (!isObject(config) || !Object.hasOwn(config, "jwks_uri"))
      throw new Error("no jwks_uri in the OpenID configuration");
    const jwksUri = config.jwks_uri;
    if (typeof jwksUri !== "string") throw new Error("jwks_uri is not a string");
    this.current = new KeyClient(jwksUri, this.fetchImpl, this.clock);
    this.fetchedAt = this.clock.monotonic();
    return this.current;
  }
}
