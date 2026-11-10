// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform services the Python worker always talks to, in place of the neutral plugins a deployment did not replace:
 * whose key it is from SaFE's `/users/self` (the Python `safe.user_id_of` / `safe.whoami`, used by the subscriptions,
 * `/whoami` and a report), and the GitHub issues a report is filed as (`FeedbackService`'s GitHub sink, when FEEDBACK_REPO
 * and a credential are set). A plugin a deployment did replace is kept.
 */
import {
  noFeedbackSink,
  noIdentityLookup,
  type Logger,
  type Plugins,
  type SecretName,
  type Settings,
} from "@primusclaw/personal-agent";
import { feedbackConfigFromEnv, feedbackSink, HttpIdentityLookup } from "@primusclaw/personal-agent-runtime";

import type { WorkerEnv } from "../worker-api.js";

export interface PlatformDeps {
  readonly env: WorkerEnv;
  readonly settings: Settings;
  readonly secrets: ReadonlyMap<SecretName, string>;
  readonly fetch: typeof fetch;
  /** Seconds since the epoch. */
  readonly now: () => number;
  readonly logger: Logger;
}

/** `plugins` with the identity lookup and the feedback sink the Python worker builds in `main.run` where they are neutral. */
export function platformPlugins(plugins: Plugins, deps: PlatformDeps): Plugins {
  const { env, settings, secrets, logger } = deps;
  const identityLookup =
    plugins.identityLookup === noIdentityLookup
      ? new HttpIdentityLookup(settings.safeApiUrl, (url, init) => deps.fetch(url, init))
      : plugins.identityLookup;
  const config = feedbackConfigFromEnv(env, secrets.get("FEEDBACK_GITHUB_APP_KEY") ?? "");
  const sink =
    plugins.feedbackSink === noFeedbackSink
      ? (feedbackSink(config, { fetch: (url, init) => deps.fetch(url, init), clock: deps.now, log: logger }) ??
        noFeedbackSink)
      : plugins.feedbackSink;
  // (Python main.run: "feedback: issues go to <repo>" or "not configured; reports are stored only")
  if (sink === noFeedbackSink) logger.info("feedback: not configured; reports are stored only");
  else if (plugins.feedbackSink === noFeedbackSink)
    logger.info("feedback: issues go to the configured repository", { repo: config.repo });
  return { ...plugins, identityLookup, feedbackSink: sink };
}
