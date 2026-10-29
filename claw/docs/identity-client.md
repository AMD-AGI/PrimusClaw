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

It is **off by default**, and takes part in request authentication in two places,
each behind its own switch: a connector's access token on the connector side of
remote agents (see [remote-agents.md](remote-agents.md#connector-access-tokens)),
and an identity provider's access token as a credential for the rest of the API
(see the access-token credential below). Nothing else is authenticated through
it. With `IDENTITY_CLIENT_ENABLED=true` each process builds the client, reads
discovery and the key set in the background (a failure is logged, not fatal) and
exports the `claw_identity_*` metrics. Code that wants the client gets it from
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

## Metrics

| Metric | Labels | |
|---|---|---|
| `claw_identity_cache_total` | `op`, `result` | `op` is `discovery`, `jwks`, `introspection` or `exchange` |
| `claw_identity_stale_served_total` | `op` | An answer served after the provider could not be asked. Steady state is 0 |
| `claw_identity_upstream_total` | `op`, `outcome` | `ok`, `inactive`, `refused`, or the failure: `timeout`, `network`, `rate_limited`, `http_5xx`, `http_4xx`, `bad_response`, `client_rejected` |
| `claw_identity_upstream_duration_seconds` | `op` | Histogram of provider calls |
| `claw_identity_client_enabled` | | 1 when the client is on in this process |

## Access tokens as an API credential

A browser application that signs a user in with an OpenID Connect authorization
code flow holds an RFC 9068 access token for this API. With
`CLAW_IDENTITY_TOKEN_AUTH_ENABLED=true` (and the identity client on) the API
accepts it as `Authorization: Bearer <JWT>`, beside the credentials it already
accepts. The code is `packages/api/src/auth/identity-token.ts`; it verifies with
`verifyJwt` and reads no signature or key itself.

| Variable | Default | Meaning |
|---|---|---|
| `CLAW_IDENTITY_TOKEN_AUTH_ENABLED` | off | `true`, `1` or `yes` turns the credential on. It also needs `IDENTITY_CLIENT_ENABLED`; without the client the path does nothing |
| `CLAW_IDENTITY_TOKEN_AUDIENCE` | `claw-api` | The `aud` the token must name |
| `CLAW_IDENTITY_TOKEN_SCOPE` | `claw.api` | The scope the token must carry |
| `CLAW_IDENTITY_TOKEN_INTROSPECT` | off | Also ask the provider (RFC 7662) whether the token is still active, so a revoked grant stops at once rather than when the token expires |
| `CLAW_IDENTITY_TOKEN_TRUSTED_ROLES` | none | The platform roles a token the provider confirms may confer: `system-admin` and/or `system-admin-readonly`, separated by commas or spaces. Any other name is ignored. See "Administrators" below |

These are read on each request. In the chart they are `identity.tokenAuth.enabled`,
`.audience`, `.scope`, `.introspect` and `.trustedRoles` (a list), rendered into the
API Deployment only; `identity.tokenAuth.enabled` without `identity.enabled` is
refused at render time, and so is a `trustedRoles` entry that is not one of the two
adoptable roles.

**What a token must be.** Typed `at+jwt` in its JOSE header, signed RS256 or ES256
by a key in the issuer's key set, issued by the configured issuer, naming
`CLAW_IDENTITY_TOKEN_AUDIENCE` in `aud`, carrying `CLAW_IDENTITY_TOKEN_SCOPE` in
`scope` (a space-delimited string, or an array), and inside its `nbf` and `exp`.
The typing refuses an ID token (typed `JWT`, issued to the application). The scope
refuses a token that was issued for the same audience for another purpose, such as
a connector's: holding a token for this API is not enough, it has to say it is for
this use.

**Who the caller is.** The user model is the one the other credentials produce:

| Token | `UserInfo` |
|---|---|
| `sub` | `userId`, exactly as the issuer wrote it. A subject that is missing, blank, padded with whitespace, longer than 128 characters, containing a control character, or equal to an owner the API uses for a caller it did not authenticate (`default`, `anonymous`, `dev-user`) is refused, not repaired |
| `name`, else `preferred_username`, else `email`, else `sub` | `userName` (at most 128 characters) |
| (none) | `roles` is `["default"]`, plus a platform administrator role only under the three conditions in "Administrators" below. The token's `roles` and `groups` claims are never copied as they stand, so enabling this credential never makes anyone an administrator by itself |
| | `platformKey` and `virtualKey` are empty: no session key stands behind a token |

**Administrators.** A person who signs in through the provider and is an administrator
there reaches the admin pages (the sandbox admin page, for one) only if the operator
sets `CLAW_IDENTITY_TOKEN_TRUSTED_ROLES`. It is empty by default, and while it is empty
every token's caller is a plain user, which is what the credential did before the
setting existed. With it set, a role is adopted for a request only when all of these hold:

1. the operator named the role (only `system-admin` and `system-admin-readonly` can be named);
2. the token claims it in `roles` (a list of strings; `groups` is not read). The token has
   already been verified as the configured issuer's, for this API's audience and scope, so
   a self-signed token, another issuer's token or an ID token never gets this far;
3. the provider's RFC 7662 answer for that token, asked now through the identity client
   and cached by its rules, is `active`, names the same `sub` as the token and lists the
   role in its own `roles`. Nothing about the token's own claim stands in for this: the
   provider's answer is the confirmation.

The provider is asked only about a token that claims a role the operator named, so an
ordinary user costs no extra call (with `CLAW_IDENTITY_TOKEN_INTROSPECT` on, the one
question serves both). The outcomes:

| The provider says | The caller |
|---|---|
| active, same subject, lists the role | `["default", <the role>]` |
| active, same subject, does not list the role (it was taken away) | `["default"]` |
| active, names no subject | `["default"]`: nothing is confirmed |
| inactive, or an answer for another subject | refused, 401 `invalid_token` |
| cannot be asked (network, timeout, 5xx, 429, an unreadable answer, a refusal of this client's own credentials, or no introspection endpoint) | `["default"]` for that request, never the token's claim and not a 503; the request is otherwise that token's own. With `CLAW_IDENTITY_TOKEN_INTROSPECT` on, an outage stays a 503 as described below |

So an outage costs an administrator the admin pages until the provider is back, and
nothing else. While the provider is down the identity client may still serve a stale
*active* answer for a token it had already confirmed, for up to
`IDENTITY_STALE_IF_ERROR_SECONDS`; set that to `0` to drop the role at once.

Name a role only when the provider's role of that name means the same thing here. In
`primus-identity` the `roles` claim holds platform roles only, and these two are the
platform administrator roles; a provider shared with other applications may use the
names differently, and then the setting should stay empty.

**How it combines with the other credentials.**

- Once a Bearer value is shaped like a JWT (three base64url segments) and is not an
  `ak-` key, the token path's answer is final. A token that does not verify is a
  401 `invalid_token` (a missing scope is a 403 `insufficient_scope`), and no other
  credential on the request is tried instead; a provider that cannot be asked is a
  503 `authentication_service_unavailable`, never an "invalid token".
- A `Token` cookie is still judged first, and an `ak-` key is still judged by SaFE
  (`ak-` is settled before the token path runs). On the browser-download routes the
  existing `?token=` key path is still tried before any header, so a valid key there
  authenticates its owner whatever Bearer value rides along. Behind the switch nothing about
  them changes; with it off nothing about the request changes at all.
- The connector side of remote agents (see
  [remote-agents.md](remote-agents.md#connector-access-tokens)) judges a JWT-shaped
  Bearer value first, by its own audience and scope, and that answer is final, so
  this credential does not run on those four routes. On every other route, with
  this switch on, a connector's access token (scope `claw.connector`) is judged
  here and refused for its scope (403 `insufficient_scope`) instead of being
  answered as a request with no credential; with the switch off nothing changes.
- It applies in the Kubernetes deployment mode too, where it is judged before the
  gateway-key check. In that mode a Bearer value that looks like a JWT is a token,
  not a key, once the switch is on.

**Limits, stated.**

- Local verification cannot see a revocation: a token is good until it expires (the
  provider decides how long it lives). `CLAW_IDENTITY_TOKEN_INTROSPECT` closes that
  gap at the cost of one cached provider call per token. The identity client's own
  rules for introspection then apply: an answer is cached, and while the provider
  cannot be asked a token whose *active* answer is cached is still honoured for up to
  `IDENTITY_STALE_IF_ERROR_SECONDS` (30 minutes by default) and never past the
  token's own expiry, which is checked locally first; any other token gets a 503.
  Set that variable to `0` to refuse every request during an outage instead. Either
  way an outage is never wider than with introspection off, where an unexpired token
  is honoured for its whole life.
- The roles in the token are not copied. A provider can be shared with other
  applications that define a role named `system-admin` for their own purposes, and
  copying it would make that caller a platform operator of every tenant's sessions
  (and, in the Kubernetes deployment mode, give it a route to admin that mode never
  had). A user authenticated by a token is a plain user, as with a connector token and
  with BYOK, unless the operator opts in with `CLAW_IDENTITY_TOKEN_TRUSTED_ROLES`; then
  only the two platform administrator roles can be adopted, only when the provider
  confirms them for that token as described under "Administrators", and in the
  Kubernetes deployment mode too. No other provider role is mapped onto anything.
- Nothing here issues per-user LLM keys: a user authenticated by a token has none,
  so a deployment that needs a per-user key for model calls has to provide it some
  other way.
- Only the Bearer header is read. A browser download by `?token=` is still an `ak-`
  key only, and a WebSocket upgrade is not covered.
- Unverified: this was exercised against a stand-in provider on a socket with real
  RS256 and ES256 keys, not against a deployed provider's authorization code flow.

