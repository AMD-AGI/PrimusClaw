// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ExecuteRequest } from "@claw/protocol";
import { LLM_KEY_SOURCE } from "../config.js";

/** Select the request key used for LLM calls.
 *  Default is llm_api_key (virtualKey). In proxy mode, platform_key is used
 *  first so Brain and sandbox LLM calls authenticate through the SaFE/proxy key. */
export function resolveRequestLlmKey(request: ExecuteRequest, fallback = ""): string {
  if (LLM_KEY_SOURCE === "platformKey") {
    return request.platform_key || request.llm_api_key || fallback;
  }
  return request.llm_api_key || fallback;
}
