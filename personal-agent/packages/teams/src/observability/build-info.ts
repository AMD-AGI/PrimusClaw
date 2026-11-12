// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `personal_agent_build_info` on the Teams worker: runtime's worker metric (`buildInfoText`), with the teams package's
 * own version (what npm and the image were released as; "unknown" when its package.json cannot be read).
 */
import { packageVersion } from "@primusclaw/personal-agent-runtime";

export { BUILD_INFO_METRIC, buildInfoText, withBuildInfo } from "@primusclaw/personal-agent-runtime/worker";

/** The teams package's version, read from its package.json (in the sources and in the published package alike). */
export function teamsVersion(): string {
  return packageVersion(new URL("../../package.json", import.meta.url));
}
