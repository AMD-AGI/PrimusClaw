// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The gateway base URLs a sandbox is given so the agent CLIs in it (Claude
 * Code, Codex, ...) can reach the model. The keys are `applyPlatformKeyEnv`
 * (params.ts). Hands' kubernetes path and app sandboxes both use this, so the
 * two cannot drift.
 */
import { ANTHROPIC_BASE_URL, OPENAI_BASE_URL } from "../config.js";

export interface GatewayUrls {
  anthropic?: string;
  openai?: string;
}

/** The URLs this deployment is configured with. */
export const configuredGatewayUrls = (): GatewayUrls => ({ anthropic: ANTHROPIC_BASE_URL, openai: OPENAI_BASE_URL });

/** The gateway base URLs, each only when configured. */
export function modelBaseUrlEnv(urls: GatewayUrls = configuredGatewayUrls()): Record<string, string> {
  const env: Record<string, string> = {};
  if (urls.anthropic) env.ANTHROPIC_BASE_URL = urls.anthropic;
  if (urls.openai) env.OPENAI_BASE_URL = urls.openai;
  return env;
}
