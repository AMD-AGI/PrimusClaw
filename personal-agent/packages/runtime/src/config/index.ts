// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export {
  ALIASED_SETTINGS,
  LEGACY_SETTING_PREFIX,
  SETTING_ALIASES,
  SETTING_PREFIX,
  legacySettings,
  settingSource,
  settingValue,
  warnLegacySettings,
  type LegacySetting,
} from "./aliases.js";
export { EnvReader, pyRepr, withoutTrailingSlash, type Env } from "./env.js";
// eslint-disable-next-line @typescript-eslint/no-deprecated -- still exported, with its 0.8.0 values, for older callers
export { ENV_NAMES, EnvSecretSource, SECRET_SETTING_NAMES, secretsSourceOf, wantedSecrets } from "./secrets.js";
export { ASSISTANT_REPLY_WINDOW_SECONDS, GITHUB_CLI_CLIENT_ID, readSettings } from "./settings.js";
