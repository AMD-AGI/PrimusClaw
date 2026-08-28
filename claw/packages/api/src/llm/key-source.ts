// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { UserInfo } from "../auth/models.js";
import { LLM_KEY_SOURCE } from "../config.js";

/** Select the per-user key used for LLM calls.
 *  Default is virtualKey (existing behavior). In proxy mode, platformKey is
 *  forwarded as llm_api_key so the LLM gateway authenticates against SaFE/proxy
 *  keys. */
export function resolveUserLlmKey(user: UserInfo | null | undefined): string {
  if (!user) return "";
  return LLM_KEY_SOURCE === "platformKey"
    ? (user.platformKey || "")
    : (user.virtualKey || "");
}

/** True when LLM calls should use platformKey instead of virtualKey. */
export function usePlatformKeyForLlm(): boolean {
  return LLM_KEY_SOURCE === "platformKey";
}
