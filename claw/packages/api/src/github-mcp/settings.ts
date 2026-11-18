// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The settings of the GitHub tools, read from the environment each time they are needed. They only
 * matter while `CLAW_GITHUB_MCP_ENABLED` is on.
 *
 *   CLAW_GITHUB_MCP_SECRET            HMAC key of the session token the tools are called with (32+ characters)
 *   CLAW_GITHUB_MCP_URL               where Brain reaches the tools, default <INTERNAL_BACKEND_URL>/v1/internal/github/mcp
 *   CLAW_GITHUB_API_URL               shared with GitHub review, default https://api.github.com
 *   CLAW_GITHUB_MCP_BINDING_ENABLED   an owner with no GH_TOKEN is served with the GitHub account they bound at the identity
 *                                     provider (`/github bind`), default off (config.ts)
 */
import { CLAW_GITHUB_MCP_BINDING_ENABLED, CLAW_GITHUB_MCP_ENABLED } from "../config.js";
import { GITHUB_MCP_PATH } from "@claw/protocol";
import { MIN_MCP_SECRET_LENGTH } from "../github-review/settings.js";

export { GITHUB_MCP_PATH };
/** The variable of the owner's env vault that holds their GitHub token: the one the sandbox's `gh` and `git` use. */
export const GITHUB_TOKEN_ENV_NAME = "GH_TOKEN";
/** A turn's token outlives any turn; the session row is checked again on every call. */
export const GITHUB_MCP_TOKEN_TTL_SECONDS = 12 * 3600;

export interface GithubMcpSettings {
  enabled: boolean;
  /** An owner with no `GH_TOKEN` is served with their GitHub binding at the identity provider. */
  binding: boolean;
  secret: string;
  mcpUrl: string;
  apiUrl: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export function readGithubMcpSettings(
  env: Env = process.env, enabled: boolean = CLAW_GITHUB_MCP_ENABLED, binding: boolean = CLAW_GITHUB_MCP_BINDING_ENABLED,
): GithubMcpSettings {
  const backend = ((env.INTERNAL_BACKEND_URL ?? "").trim() || `http://127.0.0.1:${(env.API_PORT ?? "").trim() || "8200"}`).replace(/(?<!\/)\/+$/, "");
  return {
    enabled,
    binding: enabled && binding,
    secret: (env.CLAW_GITHUB_MCP_SECRET ?? "").trim(),
    mcpUrl: (env.CLAW_GITHUB_MCP_URL ?? "").trim() || `${backend}${GITHUB_MCP_PATH}`,
    apiUrl: ((env.CLAW_GITHUB_API_URL ?? "").trim() || "https://api.github.com").replace(/(?<!\/)\/+$/, ""),
  };
}

/**
 * What is wrong with an enabled configuration, as sentences: a process asked for the tools that cannot authenticate them must not start.
 * With the binding on it also needs the identity client (a binding is read from the identity provider) and GitHub review (every call
 * made with a binding is written to its audit log, `claw_github_audit`, before it runs, and that table exists only while review is on).
 */
export function githubMcpConfigErrors(s: GithubMcpSettings, identityClientBuilt = false, reviewEnabled = false): string[] {
  if (!s.enabled) return [];
  const errors: string[] = [];
  if (s.secret.length < MIN_MCP_SECRET_LENGTH) errors.push(`CLAW_GITHUB_MCP_SECRET must be at least ${MIN_MCP_SECRET_LENGTH} characters`);
  if (s.binding && !identityClientBuilt) errors.push("IDENTITY_CLIENT_ENABLED must be true: CLAW_GITHUB_MCP_BINDING_ENABLED reads the owner's GitHub binding from the identity provider");
  if (s.binding && !reviewEnabled) errors.push("CLAW_GITHUB_REVIEW_ENABLED must be true: a call made with a GitHub binding is written to its audit log (claw_github_audit) first");
  try {
    const u = new URL(s.apiUrl);
    if (u.username || u.password || (u.protocol !== "https:" && u.protocol !== "http:")) throw new Error("bad");
  } catch {
    errors.push("CLAW_GITHUB_API_URL must be an http(s) URL without credentials");
  }
  return errors;
}
