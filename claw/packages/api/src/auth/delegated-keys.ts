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
 *
 * What a refusal is about decides whom it is kept for. A person has one grant per signed-in device, so the
 * provider's verdict on one subject token (`invalid_grant`: that grant is signed out or that token has expired)
 * says nothing about the person's other tokens: it is kept for that token alone, and a person's valid token is
 * still exchanged. Only a refusal about this client's own standing (it may not exchange, may not ask for that
 * audience or scope) is the same for every token of every person, and is kept per person.
 */
import { createHash } from "node:crypto";
import { ACCESS_TOKEN_TYPE, IdentityExchangeRefusedError, IdentityUnavailableError, type ExchangedToken, type ExchangeRequest } from "@claw/utils";
import {
  AuthServiceMisconfiguredError, AuthUpstreamUnreachableError, SafeUpstreamHttpError, SafeUpstreamProtocolError, type SafeClient,
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

/**
 * The provider's refusals that are about this API's client or its configuration, not about the subject token:
 * the same request with any other token of any person gets the same answer. Anything else (`invalid_grant`,
 * `invalid_token`, `invalid_request`, a code this list does not know) may be the verdict on one token, and is
 * never taken for the person's.
 */
const CLIENT_WIDE_REFUSALS: ReadonlySet<string> = new Set(["unauthorized_client", "invalid_target", "invalid_scope"]);

interface Entry {
  outcome: Extract<SaFeKeys, { status: "keys" | "none" }>;
  /** Epoch milliseconds. */
  until: number;
}

/** What one lookup learned, and whether it is true of the person or only of the token it was asked with. */
interface Answer {
  outcome: SaFeKeys;
  /** A refusal that holds for this token alone: another token of the same person is not answered by it. */
  tokenOnly: boolean;
}

export class DelegatedKeys {
  /** Per person: the keys, or a refusal that holds for every token of the person (or of the client). */
  private readonly entries = new Map<string, Entry>();
  /** Per subject token (digested, never stored): a refusal that is that token's alone. */
  private readonly tokenRefusals = new Map<string, Entry>();
  private readonly flights = new Map<string, { token: string; answer: Promise<Answer> }>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The keys of `sub`, whose own access token is `userToken` (already verified by the caller). Concurrent lookups
   * for one person make one exchange and one question to SaFE, unless the one in flight ends in a refusal of its
   * own token: that is not an answer for a caller who brought another.
   */
  async keysOf(sub: string, userToken: string, settings: DelegationSettings, deps: DelegationDeps): Promise<SaFeKeys> {
    // A refusal of this very token comes first: the provider's word on it stands for its 30 seconds even if another
    // token of the person has since earned keys.
    const tokenKey = `${sub}\u0000${createHash("sha256").update(userToken).digest("hex")}`;
    const refused = this.tokenRefusals.get(tokenKey);
    if (refused && refused.until > this.now()) return refused.outcome;
    if (refused) this.tokenRefusals.delete(tokenKey);

    const held = this.entries.get(sub);
    if (held && held.until > this.now()) return held.outcome;
    if (held) this.entries.delete(sub);

    const running = this.flights.get(sub);
    if (running) {
      const { outcome, tokenOnly } = await running.answer;
      if (!tokenOnly || running.token === userToken) return outcome;
      // The flight we joined was refused for another token of this person: ours has not been asked about.
      return this.keysOf(sub, userToken, settings, deps);
    }
    const answer = this.ask(sub, tokenKey, userToken, settings, deps).finally(() => {
      if (this.flights.get(sub)?.answer === answer) this.flights.delete(sub);
    });
    this.flights.set(sub, { token: userToken, answer });
    return (await answer).outcome;
  }

  private remember(sub: string, outcome: Entry["outcome"], until: number): void {
    if (until <= this.now()) return;
    this.store(this.entries, sub, { outcome, until });
  }

  private rememberTokenRefusal(tokenKey: string, outcome: Entry["outcome"], until: number): void {
    if (until <= this.now()) return;
    this.store(this.tokenRefusals, tokenKey, { outcome, until });
  }

  private store(into: Map<string, Entry>, key: string, entry: Entry): void {
    into.delete(key);
    if (into.size >= MAX_ENTRIES) {
      const oldest = into.keys().next().value;
      if (oldest !== undefined) into.delete(oldest);
    }
    into.set(key, entry);
  }

  private async ask(sub: string, tokenKey: string, userToken: string, settings: DelegationSettings, deps: DelegationDeps): Promise<Answer> {
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
        // The provider's decision. About this client (it may not exchange, may not ask for that audience): the same
        // for everyone, kept for the person. About this token (its grant is signed out, it has expired): kept for
        // this token only, because the person's other tokens have grants of their own.
        const none: SaFeKeys = { status: "none", reason: `delegation_refused_${err.code}` };
        if (CLIENT_WIDE_REFUSALS.has(err.code)) {
          this.remember(sub, none, this.now() + NEGATIVE_MS);
          return { outcome: none, tokenOnly: false };
        }
        this.rememberTokenRefusal(tokenKey, none, this.now() + NEGATIVE_MS);
        return { outcome: none, tokenOnly: true };
      }
      if (err instanceof IdentityUnavailableError) return { outcome: { status: "unavailable", source: "identity" }, tokenOnly: false };
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
    return { outcome, tokenOnly: false };
  }

  private async askSafe(sub: string, delegatedToken: string, deps: DelegationDeps): Promise<SaFeKeys> {
    try {
      const user = await deps.safe.verifyAccessToken(delegatedToken, { cache: false });
      if (user.userId !== sub) return { status: "none", reason: "subject_mismatch" };
      if (!user.platformKey && !user.virtualKey) return { status: "none", reason: "safe_holds_no_keys" };
      return { status: "keys", platformKey: user.platformKey, virtualKey: user.virtualKey };
    } catch (err) {
      if (err instanceof AuthServiceMisconfiguredError) return { status: "misconfigured", message: err.message };
      // A 2xx that is not an answer (not JSON, no id) is SaFE, or something in front of it, failing: not a refusal.
      if (err instanceof AuthUpstreamUnreachableError || err instanceof SafeUpstreamProtocolError) return { status: "unavailable", source: "safe" };
      if (err instanceof SafeUpstreamHttpError) {
        return err.status >= 500 ? { status: "unavailable", source: "safe" } : { status: "none", reason: `safe_http_${err.status}` };
      }
      return { status: "none", reason: "safe_does_not_accept_token" };
    }
  }
}
