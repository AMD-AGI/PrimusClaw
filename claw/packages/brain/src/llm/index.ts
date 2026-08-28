// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { LLM_API_STYLE } from "../config.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAiProvider } from "./openai-provider.js";
import type { LlmProvider } from "./provider.js";

export type { LlmProvider, LlmSession, LlmSessionOptions, LlmTurnResult, LlmContentBlock } from "./provider.js";

const anthropicProvider = new AnthropicProvider();
const openAiProvider = new OpenAiProvider();

/** Deployment-wide provider selection (see config.ts LLM_API_STYLE): every
 *  session in this Brain process speaks the same wire protocol. Providers
 *  are cheap stateless singletons — actual per-request state lives in the
 *  LlmSession each one creates. */
export function getProvider(): LlmProvider {
  return LLM_API_STYLE === "openai" ? openAiProvider : anthropicProvider;
}
