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
| `CLAW_IDENTITY_TOKEN_DELEGATION_AUDIENCE` | `primus-safe` | SaFE deployment mode: the audience of the token the API asks the provider for, to present to SaFE in the person's name (see "Keys for a token's user") |
| `CLAW_IDENTITY_TOKEN_DELEGATION_SCOPE` | `safe.api` | The scope of that token |
| `CLAW_IDENTITY_TOKEN_TRUSTED_ROLES` | none | The platform roles a token the provider confirms may confer: `system-admin` and/or `system-admin-readonly`, separated by commas or spaces. Any other name is ignored. See "Administrators" below |

These are read on each request. In the chart they are `identity.tokenAuth.enabled`,
`.audience`, `.scope`, `.introspect`, `.delegationAudience`, `.delegationScope` and `.trustedRoles` (a list), rendered into the
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
| | `platformKey` and `virtualKey` are the person's own keys from SaFE in the SaFE deployment mode (see "Keys for a token's user"), and empty otherwise: no session key stands behind a token |

**Keys for a token's user (SaFE deployment mode).** The things a caller does that are
not reads of this API's own tables run on two keys SaFE holds for them: the platform
key (an `ak-` key: a sandbox is created with it, and `GET /v1/me`, the image search, the
sandbox admin page and the other reads of SaFE present it) and the LiteLLM virtual key
(what a turn's model calls run with). A cookie or an `ak-` key gets both from SaFE's
verification, `POST /api/v1/auth/verify`, which the API already calls with
`AUTH_INTERNAL_TOKEN`. A token gets them the same way, but **SaFE is never shown the token**,
which is good for this API's own audience: the API is a service acting for the person, and
asks the identity provider for the credential of one (RFC 8693 service delegation).

1. The token has verified here (signature, audience, scope, and the provider's answer when
   that is asked for).
2. The API exchanges it at the provider, as its own client (`IDENTITY_CLIENT_ID`),
   with `subject_token_type=urn:ietf:params:oauth:token-type:access_token`, for a token whose
   audience and scope are `CLAW_IDENTITY_TOKEN_DELEGATION_AUDIENCE` and `_SCOPE` (default
   `primus-safe` and `safe.api`). The provider answers with a token for that person (its `sub` is the
   token's), with the API's client as the party acting for them (`act`), valid for the lifetime the
   provider has set for this client (it is not fixed here: the exchange response says how long).
3. The API presents that token to SaFE's verification, asking for both keys. SaFE answers with the
   keys of the token's subject, if it was told to accept this API as an actor.
4. The answer must name the token's own `sub`, or those keys are somebody else's and are not used.

What the API keeps: the answer, **per person**, for at most the life the delegated token has left
(a person's own token is replaced every few minutes; their keys do not change with it, so a new
token of the same person does not ask again). A provider that states no lifetime has nothing to
bound an answer by, and none is kept. Concurrent requests of one person make one exchange and one
question.

| What happens | The caller |
|---|---|
| SaFE answers with the person's id (the token's `sub`) and keys | has those keys, until the delegated token ends |
| an id that is not the token's `sub` (those keys would be somebody else's), or a person SaFE holds no keys for | no keys; kept 30 seconds, the decision is made on every request |
| SaFE answers 401 or another 4xx (it does not accept this issuer or audience, or was not told about this actor) | authenticated, no keys; kept 30 seconds so SaFE is not asked on every request. The log says why (`auth.identity_token.no_safe_keys`) |
| the provider refuses the exchange (`unauthorized_client`: its client is not registered to exchange access tokens; `invalid_grant`: the person's grant is gone, `invalid_target`: no such audience for this client) | authenticated, no keys; kept 30 seconds. The log says which refusal (`delegation_refused_<code>`) |
| SaFE 5xx or no answer, a 200 from SaFE that is not an answer (a proxy's page, a cut-off body, no user id), the provider 5xx, a timeout, or the provider refusing this client's own credentials | 503 `authentication_service_unavailable`, not remembered: the next request asks again |
| (no `AUTH_INTERNAL_TOKEN` to ask with) | 500 `authentication_misconfigured`, as for a cookie or a key |

A caller without keys is not refused. They can read and write their own sessions, but a
turn has no model key (unless Brain has a deployment-wide one, `ANTHROPIC_AUTH_TOKEN`,
as it always could), a sandbox has no platform key, and `GET /v1/me` is a 401
`authentication_required`, because there is nothing to present to SaFE.

What has to be set up, and what is not done:

- **The provider** has to know this API's client (`IDENTITY_CLIENT_ID`) as one that may exchange
  an access token for this API's audience (`claw-api`) and may ask for tokens for SaFE's audience
  with the scope above. In `primus-identity` that is a service client with `allowedAudiences`
  `primus-safe`, `allowedScopes` `safe.api` and `subjectAudiences` `claw-api`; its `tokenTtlSeconds`
  is how long the delegated token lives, and so how long the API keeps a person's keys.
- **SaFE** has to accept the token the provider issues: `auth.mode: external` with an `oidc`
  authenticator for the issuer whose `audience` is the delegation audience (keep a `builtin` entry so
  cookies and `ak-` keys go on working), and this API's client id in `auth.key_actors`, which lets a
  delegated token whose actor is listed call `POST /api/v1/auth/verify` and get the keys of its subject
  and no one else's. A SaFE in its default `builtin` mode does not know the issuer and answers 401 to every
  token, which leaves every token caller keyless; one that was not told about the actor answers 403, the same.
  SaFE needs no name of this API beyond that client id.
- A token that is itself delegated (RFC 8693, with an `act` claim: a service acting for the person) is
  not exchanged again. Such a caller has no keys.
- The person's token is not forwarded to SaFE by any route. The MCP tool that lists models, which sends the
  caller's own `Authorization` header to SaFE, sends such a caller's platform key instead (nothing if they have none).
- The roles in SaFE's answer are ignored, as the token's are: only
  `CLAW_IDENTITY_TOKEN_TRUSTED_ROLES` makes a token's caller an administrator.
- The Kubernetes deployment mode has no SaFE to ask; a token's caller has no keys there.

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
- Nothing here issues keys. A token's user has the keys SaFE already holds for that
  person (see "Keys for a token's user"), and none where SaFE does not accept the token.
- Only the Bearer header is read. A browser download by `?token=` is still an `ak-`
  key only, and a WebSocket upgrade is not covered.
- Unverified: this was exercised against a stand-in provider on a socket with real
  RS256 and ES256 keys, not against a deployed provider's authorization code flow.

