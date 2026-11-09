// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where feedback files issues, and with which credential (the Python worker's `feedback.FeedbackConfig`): a GitHub App
 * (an installation token minted from its key, limited to issues of the one repository), else a plain token file, which
 * is also the fallback when the App fails. No repository is built in: a deployment that files issues names its own.
 */
import { readFile } from "node:fs/promises";

import { ConfigError, type FeedbackSink, type Logger } from "@primusclaw/personal-agent";

import { GithubApi, type FetchLike } from "./api.js";
import { AppTokenSource, FallbackTokenSource } from "./app-token.js";
import { GithubIssueSink } from "./feedback-issues.js";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\n?$/;

export interface FeedbackConfig {
  /** `owner/name` ("" when none). */
  readonly repo: string;
  readonly appId: string;
  readonly installationId: string;
  /** The App's private key (PEM) as a mounted file; "" when the key came from a secret store (`keyPem`). */
  readonly keyFile: string;
  /** The same key read from a secret store at start, held in memory only. */
  readonly keyPem: string;
  readonly tokenFile: string;
  readonly apiUrl: string;
}

/**
 * FEEDBACK_REPO, FEEDBACK_GITHUB_APP_ID, FEEDBACK_GITHUB_INSTALLATION_ID, FEEDBACK_GITHUB_KEY_FILE and
 * FEEDBACK_GITHUB_TOKEN_FILE; `keyPem`: the App key from the secret store, with which the key file is not used. A
 * credential with no repository stops the start: it would quietly store reports only.
 */
export function feedbackConfigFromEnv(env: Readonly<Record<string, string | undefined>>, keyPem = ""): FeedbackConfig {
  const get = (name: string): string => (env[name] ?? "").trim();
  if (!get("FEEDBACK_REPO") && (get("FEEDBACK_GITHUB_APP_ID") || get("FEEDBACK_GITHUB_TOKEN_FILE"))) {
    throw new ConfigError(
      "FEEDBACK_REPO is required with FEEDBACK_GITHUB_APP_ID or FEEDBACK_GITHUB_TOKEN_FILE (the owner/repo issues go to)",
    );
  }
  return {
    repo: get("FEEDBACK_REPO"),
    appId: get("FEEDBACK_GITHUB_APP_ID"),
    installationId: get("FEEDBACK_GITHUB_INSTALLATION_ID"),
    keyFile: keyPem ? "" : get("FEEDBACK_GITHUB_KEY_FILE"),
    keyPem,
    tokenFile: get("FEEDBACK_GITHUB_TOKEN_FILE"),
    apiUrl: "https://api.github.com",
  };
}

export function appConfigured(config: FeedbackConfig): boolean {
  return Boolean(config.appId && config.installationId && (config.keyFile || config.keyPem));
}

/** A repository and some credential; whether the credential works is only known when it is used. */
export function feedbackConfigured(config: FeedbackConfig): boolean {
  return REPO.test(config.repo) && (appConfigured(config) || Boolean(config.tokenFile));
}

export interface FeedbackSinkOptions {
  readonly fetch?: FetchLike;
  /** Seconds since the epoch. */
  readonly clock?: () => number;
  readonly log: Logger;
}

/** The sink feedback delivers to, or undefined when nothing is configured (reports are then only recorded). */
export function feedbackSink(config: FeedbackConfig, options: FeedbackSinkOptions): FeedbackSink | undefined {
  if (!feedbackConfigured(config)) return undefined;
  const clock = options.clock ?? (() => Date.now() / 1000);
  const app = appConfigured(config)
    ? new AppTokenSource({
        appId: config.appId,
        installationId: config.installationId,
        key: () => (config.keyPem ? Promise.resolve(config.keyPem) : readFile(config.keyFile)),
        repositories: [config.repo.split("/")[1] ?? ""],
        permissions: { issues: "write" },
        apiUrl: config.apiUrl,
        clock,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : undefined;
  const plain = config.tokenFile ? () => readFile(config.tokenFile, "utf8") : undefined;
  const tokens = new FallbackTokenSource(app, plain, clock, 60, (code) => {
    options.log.warn("feedback: GitHub App token failed; falling back to the token file", { code });
  });
  const api = new GithubApi({ apiUrl: config.apiUrl, tokens, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return new GithubIssueSink(api, config.repo, options.log);
}
