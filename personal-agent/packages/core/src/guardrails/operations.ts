// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Limit } from "../config/settings.js";
import { pyStrip as strip } from "../text/py-text.js";

/**
 * The operations that act with someone's authority and are limited per person; the keys are the `operation`
 * category of the security events.
 */
export const SENSITIVE_OPERATIONS = {
  pr_review:
    "start a review of a pull request for a colleague (each pull request), or post a held review with one's own GitHub account",
  pr_merge: "confirm a merge that Claw holds for the person whose GitHub account it uses",
  approval:
    "approve a tool call held for approval: a Claw session's approval card, or a remote agent's permission card",
  remote_agent:
    "switch a remote agent session to a mode that runs without asking for approval (`/agent mode`, the mode card, or the " +
    "choice on a new session card)",
} as const;
export type SensitiveOperation = keyof typeof SENSITIVE_OPERATIONS;

export const SENSITIVE_OPERATION_NAMES = Object.keys(SENSITIVE_OPERATIONS) as SensitiveOperation[];

/** The defaults, per person: a busy coding agent asks for many approvals, a person merges a few pull requests an hour. */
export const DEFAULT_LIMITS: Readonly<Record<SensitiveOperation, Limit>> = {
  pr_review: { count: 30, windowSeconds: 3600 },
  pr_merge: { count: 20, windowSeconds: 3600 },
  approval: { count: 120, windowSeconds: 3600 },
  remote_agent: { count: 10, windowSeconds: 3600 },
};

/** PA_LIMIT_PR_MERGE=20/3600; 0 turns that limit off. (The older TEAMS_LIMIT_ names are read by the runtime.) */
export const ENV_PREFIX = "PA_LIMIT_";

const DIGITS = /^\d+$/;

function parseOne(name: string, raw: string, fallback: Limit): Limit {
  const [number = "", seconds, ...rest] = raw.split("/");
  const count = strip(number);
  const window = rest.length === 0 && seconds !== undefined ? strip(seconds) : "";
  if (DIGITS.test(count) && DIGITS.test(window) && Number(count) > 0 && Number(window) > 0) {
    return { count: Number(count), windowSeconds: Number(window) };
  }
  throw new RangeError(
    `${name} must be COUNT/SECONDS with both positive (for example ${String(fallback.count)}/${String(fallback.windowSeconds)}), ` +
      `or 0 for no limit, not '${raw}'`,
  );
}

/**
 * The limits from the environment: `PA_LIMIT_<OPERATION>` is `COUNT/SECONDS` (`20/3600`), or `0` to turn that
 * limit off. Unset takes the default. Anything else throws (the worker stops at start: a typo must not lift a limit),
 * naming the variable `source` says the value was read from (default: the name asked for).
 */
export function parseLimits(
  env: (name: string) => string,
  source: (name: string) => string = (name) => name,
): Map<SensitiveOperation, Limit> {
  const limits = new Map<SensitiveOperation, Limit>();
  for (const operation of SENSITIVE_OPERATION_NAMES) {
    const fallback = DEFAULT_LIMITS[operation];
    const name = ENV_PREFIX + operation.toUpperCase();
    const raw = strip(env(name));
    if (!raw) limits.set(operation, fallback);
    else if (raw === "0") limits.set(operation, { count: 0, windowSeconds: fallback.windowSeconds });
    else limits.set(operation, parseOne(source(name), raw, fallback));
  }
  return limits;
}
