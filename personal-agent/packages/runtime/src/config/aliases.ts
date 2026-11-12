// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's own settings carry the `PA_` prefix (personal agent): the store, the encryption keys, the token exchange,
 * the review for a colleague, the per-person limits and the other settings every surface shares. They were first
 * written with the `TEAMS_` prefix, when Teams was the only surface; those names are still read, as aliases, so a
 * deployment that sets them keeps working unchanged. `PA_` and not a word such as `WORKER_`: the Teams surface already
 * uses `WORKER_IDENTITY_*` for its own Azure identity, and a surface's own settings keep the surface's prefix
 * (`TEAMS_STREAMING`, `TEAMS_AI_LABEL`), so the prefix says whose a setting is.
 *
 * The rule, for every pair: the `PA_` name when it is set and not blank; else the `TEAMS_` name when it is set; else the
 * `PA_` name (unset or blank). A message about a value names the variable it was read from.
 */
import { own, pyStrip, type Logger } from "@primusclaw/personal-agent";

/** The prefix of the worker's own settings. */
export const SETTING_PREFIX = "PA_";
/** The prefix the same settings were first written with, still read as an alias. */
export const LEGACY_SETTING_PREFIX = "TEAMS_";

/** The settings read under both prefixes, by their name after the prefix. */
export const ALIASED_SETTINGS = [
  "DB_PATH",
  "ENCRYPTION_KEYS",
  "CLAW_EVENTS_GONE",
  "ON_BEHALF_USERS",
  "OBSERVE_USERS",
  "DIRECT_CHAT",
  "DIRECT_CHAT_USERS",
  "ASSISTANT_UNDERSTANDING",
  "ASSISTANT_UNDERSTANDING_USERS",
  "GROUP_CONTEXT_MESSAGES",
  "GROUP_CONTEXT_HOURS",
  "GROUP_CONTEXT_CHARS",
  "GROUP_CONTEXT_GRANTED",
  "EXCHANGE_ENABLED",
  "EXCHANGE_CLIENT_ID",
  "EXCHANGE_CLIENT_SECRET",
  "EXCHANGE_TOKEN_URL",
  "EXCHANGE_BINDING_REQUEST_URL",
  "EXCHANGE_ISSUER",
  "EXCHANGE_AUDIENCE",
  "EXCHANGE_SCOPE",
  "EXCHANGE_FOR_CHAT",
  "GITHUB_REVIEW_ENABLED",
  "GITHUB_REVIEW_OWNERS",
  "REVIEW_INTENT_MODEL",
  "GITHUB_CREDENTIAL_URL",
  "GITHUB_CLIENT_ID",
  "USER_MESSAGE_LIMIT",
  "USER_MESSAGE_WINDOW_SECONDS",
  "USER_MAX_CONCURRENT_TASKS",
  "LINK_MAX_FAILURES_PER_USER",
  "LINK_MAX_FAILURES_GLOBAL",
  "LINK_ATTEMPT_WINDOW_SECONDS",
  "LIMIT_PR_REVIEW",
  "LIMIT_PR_MERGE",
  "LIMIT_APPROVAL",
  "LIMIT_REMOTE_AGENT",
] as const;

/** The pairs: `PA_` name -> the `TEAMS_` name still read when it is not set. */
export const SETTING_ALIASES: ReadonlyMap<string, string> = new Map(
  ALIASED_SETTINGS.map((stem) => [SETTING_PREFIX + stem, LEGACY_SETTING_PREFIX + stem]),
);

const NEUTRAL_OF: ReadonlyMap<string, string> = new Map([...SETTING_ALIASES].map(([neutral, old]) => [old, neutral]));

type Env = Readonly<Record<string, string | undefined>>;

const isSet = (env: Env, name: string): boolean => pyStrip(own(env, name) ?? "") !== "";

/**
 * The variable a setting is read from: `name` may be either name of a pair (or any other setting, read as it is). The
 * `PA_` name when it is set and not blank, else the `TEAMS_` name when it is present, else the `PA_` name.
 */
export function settingSource(env: Env, name: string): string {
  const neutral = NEUTRAL_OF.get(name) ?? name;
  const legacy = SETTING_ALIASES.get(neutral);
  if (legacy === undefined) return name;
  if (isSet(env, neutral)) return neutral;
  return own(env, legacy) !== undefined ? legacy : neutral;
}

/** The value of a setting under the alias rule (undefined: neither name is present). */
export function settingValue(env: Env, name: string): string | undefined {
  return own(env, settingSource(env, name));
}

/** A legacy name in use: the one read, or one set beside its `PA_` name and ignored. */
export interface LegacySetting {
  readonly legacy: string;
  readonly neutral: string;
  /** The `PA_` name is set too, so the `TEAMS_` value is not read. */
  readonly ignored: boolean;
}

/** The `TEAMS_` names this environment sets (not blank) of the settings that now carry `PA_`. */
export function legacySettings(env: Env): LegacySetting[] {
  const out: LegacySetting[] = [];
  for (const [neutral, legacy] of SETTING_ALIASES) {
    if (isSet(env, legacy)) out.push({ legacy, neutral, ignored: isSet(env, neutral) });
  }
  return out;
}

/**
 * One warning at start for the `TEAMS_` names in use, naming the `PA_` name of each (never a value: some are secrets);
 * and one for each `TEAMS_` name that is set beside its `PA_` name and so not read. Nothing when none is in use.
 */
export function warnLegacySettings(env: Env, logger: Logger): void {
  const used = legacySettings(env);
  const read = used.filter((s) => !s.ignored);
  if (read.length > 0) {
    logger.warn(
      `deprecated setting names: ${read.map((s) => `${s.legacy} (now ${s.neutral})`).join(", ")}; ` +
        `they still work, the ${SETTING_PREFIX} names take precedence`,
      { settings: read.map((s) => s.legacy).join(",") },
    );
  }
  for (const s of used.filter((u) => u.ignored)) {
    logger.warn(`${s.legacy} is ignored: ${s.neutral} is set`, { setting: s.legacy });
  }
}
