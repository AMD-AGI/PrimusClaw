<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Platform access

Having an account on the platform does not have to mean being served by Claw. An
account can exist with a role that lets it read its own record and nothing else,
and Claw spends the platform's LLM keys and compute on whoever it serves. This
setting lets an operator say which platform roles entitle a person to that.

It is **off by default**: with the setting empty, nothing is checked and every
caller is judged exactly as before.

## Setting

| Variable | Chart value | Default | Meaning |
|---|---|---|---|
| `CLAW_REQUIRED_PLATFORM_ROLES` | `api.requiredPlatformRoles` (a list) | empty | Platform roles, comma- or whitespace-separated, of which a caller must hold at least one. Compared exactly (the platform's role names are case-sensitive). Read on each request. |

Claw knows no role names. Which role means "may use Claw" is the operator's word, and a
name the platform has not defined matches nobody (so everyone is refused: check the
spelling before turning it on).

## What is refused

With the setting non-empty, every authenticated API route answers a caller that holds none
of the named roles with

```
HTTP 403
{ "ok": false, "error": "platform_access_required", "message": "no access yet - ask an administrator" }
```

and under `/anthropic/` with Anthropic's own error shape
(`{"type":"error","error":{"type":"permission_error","message":"..."}}`). A client can
recognise the case by `error` and show `message` as it is. It says nothing about roles.

The check sits in the one authentication hook, so there is no route to forget: the LLM,
sessions and sandboxes, remote agents, A2A and the rest are all behind it. It runs
before the caller's LLM key is cached for background work, so a refused caller leaves no key behind.
Not judged: `/health`, `/metrics`, agent-card discovery and `/v1/internal/*` (which have their own
credentials and no user), and the local-development bypass (`CLAW_INSECURE_DEV_AUTH=1`, which
authenticates nobody and is refused outside a dev `APP_ENV`). A request with no credential or a
bad one is still a 401.

## Where the roles come from

The platform's verification of the credential (`POST /api/v1/auth/verify`) reports the
user's roles in `roles`. Only a credential the platform verified brings them: the session
cookie, and an `ak-` key presented as `Authorization: Bearer`, as `x-api-key` or, on the
file-download routes, as `?token=`.

An identity provider's access token (`CLAW_IDENTITY_TOKEN_AUTH_ENABLED`), a connector's
access token and a BYOK key in Kubernetes mode are not verified by the platform. Claw builds
those callers itself and gives them the single role `default`, which is Claw's marker for an
ordinary user and not something the platform said. Counting it would let a person who has no
access yet in through a different kind of credential, so **with the setting on, those callers are
refused**: their roles are unknown, and unknown never satisfies a requirement. If the setting
is on, a field missing from the platform's answer, `null`, or anything that is not a list
of strings is treated the same way: no roles, refused.

One exception, for the identity token only. A role the identity provider confirmed through
`CLAW_IDENTITY_TOKEN_TRUSTED_ROLES` (`system-admin` and/or `system-admin-readonly`: the
operator named it, the token claims it, and the provider's RFC 7662 answer, asked on that
request, is active, names the same subject and lists it) is a role someone vouched for, and
Claw already lets it confer admin rights, so it counts here as well. Only that: the `default`
every identity-token caller carries never does, and a role that is merely claimed, or that
the provider could not be asked about, counts for nothing. So with
`CLAW_IDENTITY_TOKEN_TRUSTED_ROLES=system-admin` and `api.requiredPlatformRoles: [system-admin]`
an administrator signing in through the provider is served, and with `[default]` they are not.
Connector tokens and BYOK keys have no such confirmation and stay refused.

Before turning the setting on in a deployment that uses those credentials, check that the
people and services using them also have a credential the platform verifies, or accept that
they stop being served.

This includes Brain's `a2a_call` to a peer Claw whose `A2A_AGENTS` entry sets `audience`: it
calls the peer with the session owner's identity token, so a peer that has the setting on
refuses it with the 403 above (the A2A routes are behind the same hook), unless the token
confers a required role as described above, which an ordinary user's does not. A peer entry with
`auth_env` holding an `ak-` key of an account that has a required role is a credential the
platform verifies; the peer then sees that account, not the user.

## What it does not cover

- The platform's answer is cached for five minutes per credential, so a role granted or
  withdrawn takes up to that long to apply. The setting itself applies on the next request.
- Work that was already accepted is not re-judged: a run in flight finishes, and **a scheduled
  trigger keeps firing** with the key saved when it was created, on every tick, for a user who
  later loses access or who created it before the setting was turned on. The check is on
  requests, and a trigger's fire is not one. See Rollout for what to do about it.
- It decides who is served; it does not change what the platform lets a user do there.

## Rollout

1. Leave it empty and deploy: nothing changes.
2. Set the roles an ordinary user holds (`api.requiredPlatformRoles: [default]`) while
   people holding other roles are still being served by other means, and watch
   `auth.platform_access.refused` in the API log (`userId`, `method`, `reason`:
   `role_missing`: the platform verified the credential and its answer holds none of the
   named roles, including an answer with no usable `roles` field; `roles_unknown`: the credential
   was not one the platform verifies). Every user you expect to be served should be absent from it.
3. Before turning it on, and whenever you withdraw a role, deal with the scheduled triggers of
   the users who are about to lose access (`claw_triggers`, one row per trigger, `owner_user_id`):
   a refused user can no longer reach `POST /v1/triggers/:id/pause` or `DELETE /v1/triggers/:id`, and the
   scheduler does not ask who may use Claw, so their triggers go on spending the platform's LLM key
   until someone stops them. Have the owners pause or delete them first, or set `enabled = false` on
   those rows.
4. To turn it off, empty the setting: the next request is judged as before.
