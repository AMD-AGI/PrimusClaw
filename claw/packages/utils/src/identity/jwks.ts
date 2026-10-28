// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createPublicKey, type JsonWebKeyInput, type KeyObject } from "node:crypto";
import type { Endpoints } from "./discovery.js";
import { IdentityUnavailableError, JwtVerificationError } from "./errors.js";
import { classifyStatus, parseJsonObject, send, type HttpSettings } from "./http.js";
import { observe, RefreshingResource } from "./refreshing.js";
import type { IdentityDeps } from "./types.js";

/** A usable verification key. `rsa` is for RS256, `ec` for ES256 over P-256. */
export interface VerificationKey {
  kid: string;
  kind: "rsa" | "ec";
  key: KeyObject;
}

export interface JwksSettings {
  refreshMs: number;
  staleIfErrorMs: number;
  retryAfterFailureMs: number;
  /**
   * The shortest gap between two reloads forced by a `kid` the cache does not
   * hold. A rotated-in key is picked up at once; a stream of forged `kid`s is
   * not a stream of upstream requests.
   */
  minForcedReloadMs: number;
  http: HttpSettings;
}

const MIN_RSA_MODULUS_BITS = 2048;

/** The key the JWK describes, or null for one this client does not verify with. */
function importKey(jwk: Record<string, unknown>): VerificationKey | null {
  const kid = typeof jwk.kid === "string" ? jwk.kid : "";
  // `use` absent means "any use"; only an explicit non-signature key is skipped.
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  let kind: "rsa" | "ec";
  if (jwk.kty === "RSA") kind = "rsa";
  else if (jwk.kty === "EC" && jwk.crv === "P-256") kind = "ec";
  else return null;
  try {
    const key = createPublicKey({ key: jwk as JsonWebKeyInput["key"], format: "jwk" });
    // RFC 7518 section 3.3: an RSA key for RS256 must be at least 2048 bits. A
    // smaller one can be factored, so a token "signed" by it proves nothing.
    if (kind === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS) return null;
    // A private JWK would import as a public key too; whatever the document
    // carried, only the public half is kept.
    return { kid, kind, key };
  } catch {
    return null;
  }
}

function parseKeySet(status: number, body: string): Map<string, VerificationKey> {
  const doc = parseJsonObject("jwks", status, body);
  if (!Array.isArray(doc.keys)) throw new IdentityUnavailableError("jwks", "bad_response", status);
  const keys = new Map<string, VerificationKey>();
  for (const raw of doc.keys) {
    if (raw === null || typeof raw !== "object") continue;
    const k = importKey(raw as Record<string, unknown>);
    if (k) keys.set(k.kid, k);
  }
  // A document with no usable key replaces nothing: swapping a working key set
  // for an empty one would turn a bad deploy upstream into every JWT refused.
  if (keys.size === 0) throw new IdentityUnavailableError("jwks", "bad_response", status);
  return keys;
}

/**
 * The upstream's signing keys, cached. Verification never waits on the network
 * while the set is fresh, and keeps working from the last good copy when the
 * upstream is down.
 */
export class JwksCache {
  private readonly keys: RefreshingResource<Map<string, VerificationKey>>;
  private lastForcedReload = -Infinity;

  constructor(
    private readonly s: JwksSettings,
    endpoints: Endpoints,
    private readonly deps: IdentityDeps,
  ) {
    this.keys = new RefreshingResource({
      op: "jwks",
      refreshMs: s.refreshMs,
      staleIfErrorMs: s.staleIfErrorMs,
      retryAfterFailureMs: s.retryAfterFailureMs,
      load: () => observe(deps, "jwks", async () => {
        const url = await endpoints.jwks();
        const { status, body } = await send("jwks", deps.fetch, url, { headers: { Accept: "application/json" } }, s.http);
        if (status !== 200) throw new IdentityUnavailableError("jwks", classifyStatus(status, false), status);
        return { value: parseKeySet(status, body), outcome: "ok" };
      }),
    }, deps);
  }

  /**
   * The key a token's header names. A token without a `kid` is accepted only
   * against a key set that has exactly one key: with several there is no way to
   * know which was meant, and trying each would let the token choose.
   */
  async getKey(kid: string | undefined): Promise<VerificationKey> {
    let set = await this.keys.get();
    let found = this.find(set, kid);
    // Measured from whichever came last, a forced reload or an ordinary one: a
    // set fetched a moment ago already had its chance to hold this key.
    const since = this.deps.now() - Math.max(this.lastForcedReload, this.keys.loadedAt);
    if (!found && since >= this.s.minForcedReloadMs) {
      this.lastForcedReload = this.deps.now();
      set = (await this.keys.reload()) ?? set;
      found = this.find(set, kid);
    }
    if (!found) throw new JwtVerificationError("unknown_key");
    return found;
  }

  /** Load the set now so a wrong address shows at start-up. */
  async warm(): Promise<number> {
    return (await this.keys.get()).size;
  }

  private find(set: Map<string, VerificationKey>, kid: string | undefined): VerificationKey | undefined {
    if (kid) return set.get(kid);
    return set.size === 1 ? set.values().next().value : undefined;
  }
}
