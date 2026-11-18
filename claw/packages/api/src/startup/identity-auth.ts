// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Startup checks for CLAW_AUTH_PROVIDER=identity: the LLM key source it needs, and the identity client and URL
 * without which every request is answered 500. Importing this module reads nothing.
 */
import { identityApiBase } from "../auth/identity-verifier.js";

/** Why identity auth cannot run with this LLM key source, or null when it can. */
export function identityKeySourceProblem(identity: boolean, keySource: string): string | null {
  if (!identity || keySource === "platformKey") return null;
  return "CLAW_AUTH_PROVIDER=identity requires LLM_KEY_SOURCE=platformKey: the identity " +
    "verifier leaves virtualKey empty, so Engines and the sandbox must use the platform key.";
}

/** Settings identity auth needs outside dev mode that `env` does not provide; empty when none is missing. */
export function identityAuthMissingSettings(identity: boolean, appEnv: string, env: NodeJS.ProcessEnv): string[] {
  if (!identity) return [];
  if (["dev", "development", "local"].includes(appEnv.toLowerCase())) return [];
  const missing: string[] = [];
  if (!["true", "1", "yes"].includes((env.IDENTITY_CLIENT_ENABLED ?? "").trim().toLowerCase())) missing.push("IDENTITY_CLIENT_ENABLED");
  if (!(env.IDENTITY_CLIENT_ID ?? "").trim()) missing.push("IDENTITY_CLIENT_ID");
  if (!(env.IDENTITY_CLIENT_SECRET ?? "").trim()) missing.push("IDENTITY_CLIENT_SECRET");
  if (!identityApiBase(env.IDENTITY_INTROSPECTION_URL, env.IDENTITY_API_URL)) missing.push("IDENTITY_INTROSPECTION_URL or IDENTITY_API_URL");
  return missing;
}
