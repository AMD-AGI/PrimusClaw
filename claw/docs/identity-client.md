<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Identity client

API and Brain share one client for the three things a service asks an identity
provider: *who owns this opaque credential* (RFC 7662 introspection), *is this
JWT genuine* (OIDC discovery and the issuer's JWKS), and *give me a token for this
user* (RFC 8693 token exchange). It lives in `packages/utils/src/identity/` and
speaks only those standards, so any provider that implements them works.

It is **off by default**, and the one place it takes part in request authentication
is a connector's access token on the connector side of remote agents (see
[remote-agents.md](remote-agents.md#connector-access-tokens)). With
`IDENTITY_CLIENT_ENABLED=true` each process builds the client, reads discovery and
the key set in the background (a failure is logged, not fatal) and exports the
`claw_identity_*` metrics. Code that wants the client gets it from
`identityClient()` (`api/src/auth/identity.ts`, `brain/src/clients/identity.ts`).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `IDENTITY_CLIENT_ENABLED` | off | `true`, `1` or `yes` builds the client; nothing else is read while it is off |
| `IDENTITY_ISSUER_URL` | required | The issuer identifier, exactly as it appears in `iss` |
| `IDENTITY_CLIENT_ID`, `IDENTITY_CLIENT_SECRET` | required | This service's own client credentials (HTTP Basic, form-encoded per RFC 6749 section 2.3.1) |
| `IDENTITY_DISCOVERY_URL` | `<issuer>/.well-known/openid-configuration` | Where to fetch the discovery document |
| `IDENTITY_INTROSPECTION_URL`, `IDENTITY_TOKEN_URL`, `IDENTITY_JWKS_URL` | from discovery | Pin an address the pod can reach when the advertised one is not; a pinned address is never discovered |
| `IDENTITY_INTROSPECTION_CACHE_SECONDS` | 30 | How long an active answer is reused (0 turns it off) |
| `IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS` | 5 | How long an inactive answer is reused (0 turns it off) |
| `IDENTITY_CREDENTIAL_RESOLVE_URL` | derived from the token endpoint | Where an external credential is resolved (`<origin>/oauth/external-credentials/resolve`); pin it when the pod reaches the provider on another address |
| `IDENTITY_STALE_IF_ERROR_SECONDS` | 1800 | How long past its freshness a cached active answer may be served while the provider cannot be asked (0 turns it off) |
| `IDENTITY_REQUEST_TIMEOUT_MS` | 5000 | Per request, including reading the body |
| `IDENTITY_KEYS_REFRESH_SECONDS` | 300 | How often discovery and the JWKS are re-read |
| `IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS` | 30 | An exchanged token with less life left than this is replaced before it is handed out |

A process that is told to enable the client and is missing a required value, or
given a malformed address, refuses to start. A numeric value outside its range is
logged at start (`startup.config_refused`) and the default is used.

In the chart, `identity.enabled` and the `identity:` block render the same
variables into both Deployments; the client secret is read from a Secret you
create (`identity.clientSecret.existingSecret`), never from values.

## What each call guarantees

**Introspection.** One lookup records exactly one cache result (`hit`,
`hit_negative`, `miss`, `coalesced`), so the hit ratio is a ratio of counters.
Concurrent lookups of one credential make one upstream call. An answer is keyed by
the whole question (credential, token type hint, extra form members), so an answer
for one audience is never served for another, and a positive answer is never kept
past the token's own `exp`.

**When the provider cannot be asked** (network error, timeout, 5xx, 429, a body
that is not an introspection answer) the result is an `IdentityUnavailableError`,
which a caller answers with a 503. It is never `{active: false}`: that answer is
cacheable and would refuse a valid user. The one exception is a credential with a
cached active answer inside its stale window, which is served and counted in
`claw_identity_stale_served_total`. Three things are never served stale: an
inactive answer, a token past its own `exp`, and anything while the provider is
refusing this client's own credentials (401/403 is a disabled client, not an
outage). After a failed refresh a stale entry is served for 5 s without trying
again, so an outage costs one timeout rather than one per request.

**JWT verification** (`verifyJwt`) checks RS256 and ES256 signatures against the
cached key set and the issuer, audience, `exp`, `nbf` and (optionally) `typ`
claims. `none`, HMAC and any algorithm the caller did not allow are refused. It
cannot see a revocation, so it is for short-lived tokens; use introspection for
anything that must be revocable at once. An unknown `kid` triggers one reload of
the key set, at most once per 30 s.

**Token exchange** sends an RFC 8693 request and caches the answer by everything
that can change it (subject, subject token type, audience, scope, resource,
requested type). The subject token type is a required argument with no default.
A refusal by the provider is a typed `IdentityExchangeRefusedError` and is never
cached. When the provider cannot be asked, a token still inside its lifetime is
handed out again; an expired one, a refused request, a rejected client and a
`forceRefresh` call are not covered.

Discovery is accepted only for the issuer it was fetched for, and an advertised
endpoint must be a plain http(s) address without credentials. Redirects are not
followed and response bodies are capped at 1 MiB. An `http://` issuer is accepted
for traffic inside a trusted cluster network; the client secret then crosses it
unencrypted, so use `https://` anywhere that is not true.

**External credentials** (`resolveExternalCredential`). Asks the provider for a user's
third-party credential (a GitHub token) for one use: `POST` with HTTP Basic client
authentication and a JSON body `{user_id, provider, requester_user_id?, purpose?}`; the answer
is `{token, provider_login, kind, scopes, delegation, expires_at}`. Nothing is cached: the
owner can unbind at any moment and every resolve is a line in the provider's audit trail. A
refusal the provider decided (`not_bound`, `expired`) is an `IdentityCredentialRefusedError`;
anything that stops an answer is an `IdentityUnavailableError`, which a caller must treat as
"unknown", never as "not bound". The service client needs the `identity.credential.resolve`
scope. `delegation` is the owner's switch for others acting with the credential; the caller
has to honour it (`requesterUserId === userId || delegation`). Used by
[GitHub pull request review](github-review.md).

## Metrics

| Metric | Labels | |
|---|---|---|
| `claw_identity_cache_total` | `op`, `result` | `op` is `discovery`, `jwks`, `introspection`, `exchange` or `credential` |
| `claw_identity_stale_served_total` | `op` | An answer served after the provider could not be asked. Steady state is 0 |
| `claw_identity_upstream_total` | `op`, `outcome` | `ok`, `inactive`, `refused`, or the failure: `timeout`, `network`, `rate_limited`, `http_5xx`, `http_4xx`, `bad_response`, `client_rejected` |
| `claw_identity_upstream_duration_seconds` | `op` | Histogram of provider calls |
| `claw_identity_client_enabled` | | 1 when the client is on in this process |
