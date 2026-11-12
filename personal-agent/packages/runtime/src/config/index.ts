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
export { ENV_NAMES, EnvSecretSource, secretsSourceOf, wantedSecrets } from "./secrets.js";
export { ASSISTANT_REPLY_WINDOW_SECONDS, GITHUB_CLI_CLIENT_ID, readSettings } from "./settings.js";
