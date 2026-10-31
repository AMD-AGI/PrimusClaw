// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Endpoints } from "./discovery.js";
import { IdentityCredentialRefusedError, IdentityUnavailableError } from "./errors.js";
import { basicAuthHeader, classifyStatus, parseJsonObject, send, type HttpSettings } from "./http.js";
import { observe } from "./refreshing.js";
import type { IdentityDeps } from "./types.js";

export interface ResolveCredentialRequest {
  /** The user whose credential is wanted. */
  userId: string;
  /** Which kind of credential, for example `github`. */
  provider: string;
  /**
   * The user on whose behalf the credential is used, when that is somebody other
   * than its owner. Recorded in the provider's audit trail with `purpose`; the
   * provider does not decide on it.
   */
  requesterUserId?: string;
  purpose?: string;
}

export interface ResolvedCredential {
  /** The secret itself. Held for one use: never cached by the client, never logged, never put in a result a model reads. */
  token: string;
  providerLogin: string;
  kind: string;
  scopes: string[];
  /**
   * Whether the owner allows others to act with this credential. The caller has
   * to honour it: `requesterUserId === userId || delegation`.
   */
  delegation: boolean;
  /** Epoch milliseconds, or null when the provider did not say. */
  expiresAt: number | null;
}

export interface CredentialSettings {
  clientId: string;
  clientSecret: string;
  http: HttpSettings;
}

/**
 * Resolves a user's third-party credential from the identity provider, one call
 * per use.
 *
 * Nothing here is cached. A credential is a long-lived secret that the owner can
 * unbind at any moment, and every resolve is a line in the provider's audit
 * trail; a cache would make both untrue. A refusal (`not_bound`, `expired`) is a
 * decision and is thrown as {@link IdentityCredentialRefusedError}; anything that
 * stops an answer from being obtained is {@link IdentityUnavailableError}, which a
 * caller must treat as "unknown", never as "not bound".
 */
export class CredentialClient {
  private readonly authorization: string;

  constructor(
    private readonly s: CredentialSettings,
    private readonly endpoints: Endpoints,
    private readonly deps: IdentityDeps,
  ) {
    this.authorization = basicAuthHeader(s.clientId, s.clientSecret);
  }

  async resolve(req: ResolveCredentialRequest): Promise<ResolvedCredential> {
    if (!req.userId) throw new TypeError("userId is required");
    if (!req.provider) throw new TypeError("provider is required");
    const answer = await observe(this.deps, "credential", async () => {
      const url = await this.endpoints.credentialResolve();
      const payload: Record<string, string> = { user_id: req.userId, provider: req.provider };
      if (req.requesterUserId) payload.requester_user_id = req.requesterUserId;
      if (req.purpose) payload.purpose = req.purpose;
      const { status, body } = await send("credential", this.deps.fetch, url, {
        method: "POST",
        headers: {
          Authorization: this.authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      }, this.s.http);

      if (status === 200) {
        const raw = parseJsonObject("credential", status, body);
        if (typeof raw.token !== "string" || raw.token === "") {
          throw new IdentityUnavailableError("credential", "bad_response", status);
        }
        const scopes = Array.isArray(raw.scopes) ? raw.scopes.filter((v): v is string => typeof v === "string") : [];
        const expires = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : Number.NaN;
        const value: ResolvedCredential = {
          token: raw.token,
          providerLogin: typeof raw.provider_login === "string" ? raw.provider_login : "",
          kind: typeof raw.kind === "string" ? raw.kind : "",
          scopes,
          delegation: raw.delegation === true,
          expiresAt: Number.isFinite(expires) ? expires : null,
        };
        return { value: value as ResolvedCredential | IdentityCredentialRefusedError, outcome: "ok" as const };
      }

      // 401/403 is the provider refusing this client, a configuration fault. A 4xx
      // with an OAuth error body is its decision about the credential.
      const reason = classifyStatus(status, true);
      if (reason === "http_4xx") {
        let code: unknown;
        try {
          code = parseJsonObject("credential", status, body).error;
        } catch {
          code = undefined;
        }
        if (typeof code === "string" && code !== "") {
          return { value: new IdentityCredentialRefusedError(code, status) as ResolvedCredential | IdentityCredentialRefusedError, outcome: "refused" as const };
        }
      }
      throw new IdentityUnavailableError("credential", reason, status);
    });
    if (answer instanceof IdentityCredentialRefusedError) throw answer;
    return answer;
  }
}
