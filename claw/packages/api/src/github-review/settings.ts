// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The settings of GitHub pull request review, read from the environment each time
 * they are needed so that what a request is judged by is what the environment
 * says now. All of them only matter while `CLAW_GITHUB_REVIEW_ENABLED` is on.
 *
 *   CLAW_GITHUB_REVIEW_OWNERS               organisations or users whose repositories may be reviewed, default AMD-AGI
 *   CLAW_GITHUB_WRITES_ENABLED              off (default): every write tool answers what it would do and writes nothing
 *   CLAW_GITHUB_API_URL                     default https://api.github.com
 *   CLAW_GITHUB_REVIEW_MCP_SECRET           HMAC key of the session token the tools are called with (32+ characters)
 *   CLAW_GITHUB_REVIEW_MCP_URL              where Brain reaches the tools, default <INTERNAL_BACKEND_URL>/v1/internal/github-review/mcp
 *   CLAW_GITHUB_REVIEW_TOKEN_TTL_SECONDS    life of that token, default 43200 (12 h)
 *   CLAW_GITHUB_CONFIRMATION_TTL_SECONDS    life of a pending confirmation, default 86400 (24 h)
 *   CLAW_GITHUB_REVIEWS_PER_TOKEN_PER_HOUR  default 6
 *   CLAW_GITHUB_REVIEWS_PER_HOUR            all tokens together, default 20
 *   CLAW_GITHUB_CONCURRENT_PER_REPO         default 3 (per API replica)
 *   CLAW_GITHUB_REQUESTS_PER_SESSION        GitHub requests one session may make, default 60
 *   CLAW_GITHUB_REVIEW_FAST_MAX_FILES       a change with at most this many files is reviewed from the diff, no sandbox, default 15
 *   CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES  ... and at most this many added plus deleted lines, default 600
 */
import { readIntSetting, type IntSettingBounds } from "@claw/utils";
import { CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";

export const GITHUB_PROVIDER = "github";
export const MIN_MCP_SECRET_LENGTH = 32;

export interface GithubReviewSettings {
  enabled: boolean;
  owners: string[];
  writesEnabled: boolean;
  apiUrl: string;
  mcpSecret: string;
  mcpUrl: string;
  tokenTtlSeconds: number;
  confirmationTtlSeconds: number;
  reviewsPerTokenPerHour: number;
  reviewsPerHour: number;
  concurrentPerRepo: number;
  requestsPerSession: number;
  fastMaxFiles: number;
  fastMaxChangedLines: number;
  /** Values that were refused and replaced by their default. */
  problems: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function bool(v: string | undefined): boolean {
  return ["true", "1", "yes"].includes((v ?? "").trim().toLowerCase());
}

export function readGithubReviewSettings(env: Env = process.env, enabled: boolean = CLAW_GITHUB_REVIEW_ENABLED): GithubReviewSettings {
  const problems: string[] = [];
  const num = (key: string, fallback: number, bounds: IntSettingBounds): number => {
    const setting = readIntSetting(env[key], { wholeNumbersOnly: true, ...bounds });
    if (setting === null) return fallback;
    if ("problem" in setting) {
      problems.push(`${key}=${(env[key] ?? "").trim()} ${setting.problem}; using ${fallback}`);
      return fallback;
    }
    return setting.value;
  };
  const owners = ((env.CLAW_GITHUB_REVIEW_OWNERS ?? "").trim() || "AMD-AGI")
    .split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);
  const backend = (env.INTERNAL_BACKEND_URL ?? "").trim() || `http://127.0.0.1:${(env.API_PORT ?? "").trim() || "8200"}`;
  const apiUrl = ((env.CLAW_GITHUB_API_URL ?? "").trim() || "https://api.github.com").replace(/\/+$/, "");
  return {
    enabled,
    owners,
    writesEnabled: bool(env.CLAW_GITHUB_WRITES_ENABLED),
    apiUrl,
    mcpSecret: (env.CLAW_GITHUB_REVIEW_MCP_SECRET ?? "").trim(),
    mcpUrl: (env.CLAW_GITHUB_REVIEW_MCP_URL ?? "").trim() || `${backend.replace(/\/+$/, "")}/v1/internal/github-review/mcp`,
    tokenTtlSeconds: num("CLAW_GITHUB_REVIEW_TOKEN_TTL_SECONDS", 43_200, { min: 60, max: 7 * 86_400 }),
    confirmationTtlSeconds: num("CLAW_GITHUB_CONFIRMATION_TTL_SECONDS", 86_400, { min: 60, max: 7 * 86_400 }),
    reviewsPerTokenPerHour: num("CLAW_GITHUB_REVIEWS_PER_TOKEN_PER_HOUR", 6, { min: 1, max: 1000 }),
    reviewsPerHour: num("CLAW_GITHUB_REVIEWS_PER_HOUR", 20, { min: 1, max: 10_000 }),
    concurrentPerRepo: num("CLAW_GITHUB_CONCURRENT_PER_REPO", 3, { min: 1, max: 100 }),
    requestsPerSession: num("CLAW_GITHUB_REQUESTS_PER_SESSION", 60, { min: 5, max: 1000 }),
    fastMaxFiles: num("CLAW_GITHUB_REVIEW_FAST_MAX_FILES", 15, { min: 0, max: 500 }),
    fastMaxChangedLines: num("CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES", 600, { min: 0, max: 100_000 }),
    problems,
  };
}

/**
 * What is wrong with an enabled configuration, as sentences. A process that was
 * asked for the feature and cannot offer it must not start: running on would be
 * running without the gates the feature is made of.
 */
export function githubReviewConfigErrors(s: GithubReviewSettings, identityClientBuilt: boolean): string[] {
  if (!s.enabled) return [];
  const errors: string[] = [];
  if (s.mcpSecret.length < MIN_MCP_SECRET_LENGTH) {
    errors.push(`CLAW_GITHUB_REVIEW_MCP_SECRET must be at least ${MIN_MCP_SECRET_LENGTH} characters`);
  }
  if (!identityClientBuilt) {
    errors.push("IDENTITY_CLIENT_ENABLED must be true: the review tools fetch the acting user's credential from the identity provider");
  }
  if (s.owners.length === 0) errors.push("CLAW_GITHUB_REVIEW_OWNERS names no owner");
  try {
    const u = new URL(s.apiUrl);
    if (u.username || u.password || (u.protocol !== "https:" && u.protocol !== "http:")) throw new Error("bad");
  } catch {
    errors.push("CLAW_GITHUB_API_URL must be an http(s) URL without credentials");
  }
  return errors;
}
