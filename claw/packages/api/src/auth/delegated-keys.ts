// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform key and the virtual key SaFE holds for a person whose access token this API was sent, obtained by
 * service delegation (RFC 8693) instead of by showing SaFE the person's own token.
 *
 * The API holds the person's token for its own audience (`claw-api`). To ask SaFE it exchanges that token, at the
 * identity provider, for one for SaFE's audience that names this API as the party acting for the person (`act`),
 * and presents that to SaFE's verification, which answers with the keys of the token's subject and of nobody else.
 * The person's token never leaves this API, SaFE never sees a credential that is good for this API, and what SaFE
 * accepts is only what the provider issued to this API's own service client.
 *
 * Answers are kept per person, not per token, for at most the life the delegated token has left: a person's own
 * token is replaced every few minutes, and the keys do not change with it. A refusal is kept for 30 seconds so a
 * misconfiguration (or a person SaFE holds nothing for) is not a question per request; a failure to answer is not
 * kept at all.
 */
import { ACCESS_TOKEN_TYPE, IdentityExchangeRefusedError, IdentityUnavailableError, type ExchangedToken, type ExchangeRequest } from "@claw/utils";
import {
  AuthServiceMisconfiguredError, AuthUpstreamUnreachableError, SafeUpstreamHttpError, type SafeClient,
} from "./safe-client.js";

/** The keys SaFE holds for a token's subject, or why the caller has none. */
export type SaFeKeys =
  | { status: "keys"; platformKey: string; virtualKey: string }
  | { status: "none"; reason: string }
  | { status: "unavailable"; source: "safe" | "identity" }
  | { status: "misconfigured"; message: string };

/** What the API asks the identity provider for: the audience SaFE accepts and the scope its verification needs. */
export interface DelegationSettings {
  audience: string;
  scope: string;
}

/** The two things a lookup needs, narrowed so a test can hand in a stand-in for either. */
export interface DelegationDeps {
  identity: { exchange(req: ExchangeRequest): Promise<ExchangedToken> };
  safe: Pick<SafeClient, "verifyAccessToken">;
}

const NEGATIVE_MS = 30_000;
const MAX_ENTRIES = 1000;

interface Entry {
  outcome: Extract<SaFeKeys, { status: "keys" | "none" }>;
  /** Epoch milliseconds. */
  until: number;
}

export class DelegatedKeys {
  private readonly entries = new Map<string, Entry>();
  private readonly flights = new Map<string, Promise<SaFeKeys>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The keys of `sub`, whose own access token is `userToken` (already verified by the caller). Concurrent lookups
   * for one person make one exchange and one question to SaFE.
   */
  async keysOf(sub: string, userToken: string, settings: DelegationSettings, deps: DelegationDeps): Promise<SaFeKeys> {
    const held = this.entries.get(sub);
    if (held && held.until > this.now()) return held.outcome;
    if (held) this.entries.delete(sub);

    const running = this.flights.get(sub);
    if (running) return running;
    const flight = this.ask(sub, userToken, settings, deps).finally(() => {
      if (this.flights.get(sub) === flight) this.flights.delete(sub);
    });
    this.flights.set(sub, flight);
    return flight;
  }

  private remember(sub: string, outcome: Entry["outcome"], until: number): void {
    if (until <= this.now()) return;
    this.entries.delete(sub);
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(sub, { outcome, until });
  }

  private async ask(sub: string, userToken: string, settings: DelegationSettings, deps: DelegationDeps): Promise<SaFeKeys> {
    let delegated: ExchangedToken;
    try {
      delegated = await deps.identity.exchange({
        subjectToken: userToken,
        subjectTokenType: ACCESS_TOKEN_TYPE,
        audience: settings.audience,
        scope: settings.scope,
      });
    } catch (err) {
      if (err instanceof IdentityExchangeRefusedError) {
        // The provider's decision: this token cannot be exchanged (the client is not allowed to, the grant is gone).
        const none: SaFeKeys = { status: "none", reason: `delegation_refused_${err.code}` };
        this.remember(sub, none, this.now() + NEGATIVE_MS);
        return none;
      }
      if (err instanceof IdentityUnavailableError) return { status: "unavailable", source: "identity" };
      throw err;
    }

    // Asked with the delegated token and nothing else, and not remembered by SaFE's client: what is remembered is
    // the answer, here, for as long as the token that earned it lives.
    const outcome = await this.askSafe(sub, delegated.accessToken, deps);
    if (outcome.status === "keys") {
      // A token with no stated lifetime has no remaining life to bound the answer by.
      if (delegated.expiresAt !== null) this.remember(sub, outcome, delegated.expiresAt);
    } else if (outcome.status === "none") {
      this.remember(sub, outcome, this.now() + NEGATIVE_MS);
    }
    return outcome;
  }

  private async askSafe(sub: string, delegatedToken: string, deps: DelegationDeps): Promise<SaFeKeys> {
    try {
      const user = await deps.safe.verifyAccessToken(delegatedToken, { cache: false });
      if (user.userId !== sub) return { status: "none", reason: "subject_mismatch" };
      if (!user.platformKey && !user.virtualKey) return { status: "none", reason: "safe_holds_no_keys" };
      return { status: "keys", platformKey: user.platformKey, virtualKey: user.virtualKey };
    } catch (err) {
      if (err instanceof AuthServiceMisconfiguredError) return { status: "misconfigured", message: err.message };
      if (err instanceof AuthUpstreamUnreachableError) return { status: "unavailable", source: "safe" };
      if (err instanceof SafeUpstreamHttpError) {
        return err.status >= 500 ? { status: "unavailable", source: "safe" } : { status: "none", reason: `safe_http_${err.status}` };
      }
      return { status: "none", reason: "safe_does_not_accept_token" };
    }
  }
}
