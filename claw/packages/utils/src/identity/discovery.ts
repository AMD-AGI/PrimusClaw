// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { IdentityUnavailableError } from "./errors.js";
import { classifyStatus, parseJsonObject, send, type HttpSettings } from "./http.js";
import { observe, RefreshingResource } from "./refreshing.js";
import type { IdentityDeps } from "./types.js";

/** The three addresses an operator may pin instead of taking them from discovery. */
export interface EndpointOverrides {
  introspectionUrl?: string;
  tokenUrl?: string;
  jwksUrl?: string;
}

export interface DiscoverySettings {
  /** The issuer identifier, exactly as it appears in `iss`. */
  issuer: string;
  /** Where to fetch the document; `<issuer>/.well-known/openid-configuration` when unset. */
  discoveryUrl?: string;
  overrides: EndpointOverrides;
  refreshMs: number;
  staleIfErrorMs: number;
  retryAfterFailureMs: number;
  http: HttpSettings;
}

interface DiscoveryDocument {
  introspectionEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
}

/**
 * `s` without its trailing slashes. A scan from the end, not `/\/+$/`: that
 * pattern retries from every slash of a long run and is quadratic on a value an
 * operator or a document supplies.
 */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return s.slice(0, end);
}

export function defaultDiscoveryUrl(issuer: string): string {
  return `${trimTrailingSlashes(issuer)}/.well-known/openid-configuration`;
}

/** An endpoint the document advertises, or a refusal to use a document that advertises nonsense. */
function endpointField(doc: Record<string, unknown>, name: string): string | undefined {
  const v = doc[name];
  if (v === undefined) return undefined;
  const bad = (): never => { throw new IdentityUnavailableError("discovery", "bad_response"); };
  if (typeof v !== "string") return bad();
  let u: URL;
  try { u = new URL(v); } catch { return bad(); }
  // Credentials go to these addresses, so only a plain http(s) address with no
  // userinfo is acceptable.
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return bad();
  return v;
}

/**
 * OIDC discovery plus the three overrides. An address pinned by the operator wins
 * and needs no discovery at all; the rest come from the cached document.
 */
export class Endpoints {
  private readonly doc: RefreshingResource<DiscoveryDocument>;

  constructor(private readonly s: DiscoverySettings, deps: IdentityDeps) {
    const url = s.discoveryUrl ?? defaultDiscoveryUrl(s.issuer);
    this.doc = new RefreshingResource<DiscoveryDocument>({
      op: "discovery",
      refreshMs: s.refreshMs,
      staleIfErrorMs: s.staleIfErrorMs,
      retryAfterFailureMs: s.retryAfterFailureMs,
      load: () => observe(deps, "discovery", async () => {
        const { status, body } = await send("discovery", deps.fetch, url, { headers: { Accept: "application/json" } }, s.http);
        if (status !== 200) throw new IdentityUnavailableError("discovery", classifyStatus(status, false), status);
        const raw = parseJsonObject("discovery", status, body);
        // OpenID Connect Discovery 1.0 section 4.3: a document whose issuer is not
        // the one it was fetched for describes someone else.
        if (raw.issuer !== s.issuer) throw new IdentityUnavailableError("discovery", "bad_response", status);
        return {
          value: {
            introspectionEndpoint: endpointField(raw, "introspection_endpoint"),
            tokenEndpoint: endpointField(raw, "token_endpoint"),
            jwksUri: endpointField(raw, "jwks_uri"),
          },
          outcome: "ok",
        };
      }),
    }, deps);
  }

  introspection(): Promise<string> {
    return this.resolve(this.s.overrides.introspectionUrl, (d) => d.introspectionEndpoint);
  }

  token(): Promise<string> {
    return this.resolve(this.s.overrides.tokenUrl, (d) => d.tokenEndpoint);
  }

  jwks(): Promise<string> {
    return this.resolve(this.s.overrides.jwksUrl, (d) => d.jwksUri);
  }

  /**
   * Fetch the document now so a bad issuer shows at start-up rather than at the
   * first request. With every address pinned the document is never needed, so an
   * unreachable discovery URL is not a start-up failure.
   */
  async warm(): Promise<void> {
    const o = this.s.overrides;
    if (o.introspectionUrl && o.tokenUrl && o.jwksUrl) return;
    await this.doc.get();
  }

  private async resolve(pinned: string | undefined, pick: (d: DiscoveryDocument) => string | undefined): Promise<string> {
    if (pinned) return pinned;
    const found = pick(await this.doc.get());
    if (!found) throw new IdentityUnavailableError("discovery", "not_configured");
    return found;
  }
}
