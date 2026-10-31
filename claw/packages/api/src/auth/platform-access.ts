// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who may use Claw at all, judged by the platform roles SaFE reports for them.
 *
 * Signing in to the platform does not by itself entitle a person to the services
 * Claw spends the platform's money on (the LLM, sandboxes, remote agents): an
 * account can exist with a role that lets it read its own record and nothing
 * else. `CLAW_REQUIRED_PLATFORM_ROLES` names the roles that do entitle someone.
 *
 *   - Empty (the default): nothing is checked, and every caller is judged exactly
 *     as before this setting existed.
 *   - Non-empty: a caller is served only when it holds at least one of the named
 *     roles, as SaFE's verification of its credential reported them. Anyone else
 *     gets a 403 `platform_access_required` that a client can show as is.
 *
 * Claw keeps no list of SaFE roles. Which role means "may use Claw" is the
 * operator's word, and a role SaFE has not defined simply matches nobody.
 *
 * Only a credential SaFE verified brings roles SaFE reported. The identity-token,
 * connector-token and BYOK paths build the caller themselves and give it the
 * single role `default`, which is Claw's own marker for "an ordinary user" and not
 * anything SaFE said, so counting it would let a caller SaFE never vouched for
 * through. Their roles are unknown, and an unknown set never satisfies a
 * requirement: with the setting on, those callers are refused until they present
 * a credential SaFE verifies. That is the point of failing closed here: the
 * alternative is that a person who has no access yet could reach the same
 * services by presenting a different kind of credential.
 */
import type { UserInfo } from "./models.js";

/** The environment variable that names the roles; empty or unset means no requirement. */
export const REQUIRED_PLATFORM_ROLES_ENV = "CLAW_REQUIRED_PLATFORM_ROLES";

/** The `error` of the 403, for a client to recognise. */
export const PLATFORM_ACCESS_REQUIRED = "platform_access_required";

/** What a person is told. Says nothing about roles: they are the operator's vocabulary, not the user's. */
export const PLATFORM_ACCESS_MESSAGE = "no access yet - ask an administrator";

/**
 * The credential methods (`recordRequestCredential`, the `method` of a verified
 * outcome) whose `roles` are SaFE's answer: the session cookie, an `ak-` key in a
 * download URL, in `Authorization: Bearer` and in `x-api-key`. Every other method
 * has no platform roles to offer. A new SaFE-verified path has to be added here
 * to count, and until it is the requirement refuses it, which is the safe way to
 * be wrong.
 */
const SAFE_VERIFIED_METHODS: ReadonlySet<string> = new Set(["cookie", "query_token", "api_key", "x_api_key"]);

/**
 * The roles an operator requires, from a comma- or whitespace-separated list.
 * Names are compared exactly (SaFE's role names are case-sensitive); blanks and
 * repeats are dropped. Read from the environment on each use, so what a request
 * is judged by is what the environment says now.
 */
export function requiredPlatformRoles(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const names = (env[REQUIRED_PLATFORM_ROLES_ENV] ?? "").split(/[\s,]+/).filter(Boolean);
  return [...new Set(names)];
}

/** Why a caller was refused. `roles_unknown`: no credential SaFE verified. `role_missing`: SaFE named roles and none is required. */
export type PlatformAccessRefusalReason = "roles_unknown" | "role_missing";

/** The response to send, in the shape the middleware's other refusals take. */
export interface PlatformAccessRefusal {
  status: 403;
  legacyError: typeof PLATFORM_ACCESS_REQUIRED;
  /** Anthropic's own name for a 403, under `/anthropic/*`. */
  anthropicType: "permission_error";
  message: string;
  /** For the log only: it is not sent. */
  reason: PlatformAccessRefusalReason;
}

/**
 * Whether `user`, authenticated by `method`, may use Claw under `required`:
 * `null` to let the request through, otherwise the refusal to send.
 */
export function platformAccessRefusal(
  user: UserInfo,
  method: string,
  required: readonly string[] = requiredPlatformRoles(),
): PlatformAccessRefusal | null {
  if (required.length === 0) return null;
  const refuse = (reason: PlatformAccessRefusalReason): PlatformAccessRefusal => ({
    status: 403,
    legacyError: PLATFORM_ACCESS_REQUIRED,
    anthropicType: "permission_error",
    message: PLATFORM_ACCESS_MESSAGE,
    reason,
  });
  if (!SAFE_VERIFIED_METHODS.has(method)) return refuse("roles_unknown");
  return user.roles.some((role) => required.includes(role)) ? null : refuse("role_missing");
}
