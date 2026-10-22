// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Environment injected into an app run so it talks to the E2B control plane
 * with the grant's role keys.
 */

const ROLE_ENV: Record<string, string> = {
  measurement: "HYPERLOOM_SANDBOX_KEY_MEASUREMENT",
  subrun: "HYPERLOOM_SANDBOX_KEY_SUBRUN",
  dev: "HYPERLOOM_SANDBOX_KEY_DEV",
};

/** Build the env map for one grant. Unknown roles are omitted. */
export function grantEnv(input: {
  apiUrl: string;
  sandboxUrl: string;
  keys: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    E2B_API_URL: input.apiUrl,
    E2B_SANDBOX_URL: input.sandboxUrl,
  };
  for (const [role, value] of Object.entries(input.keys)) {
    const name = ROLE_ENV[role];
    if (name && value) env[name] = value;
  }
  return env;
}
