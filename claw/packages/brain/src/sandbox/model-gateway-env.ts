// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model-gateway variables a sandbox is given so the agent CLIs in it
 * (Claude Code, Codex, ...) can call the model.
 *
 * One definition for every sandbox Claw creates: a Hands sandbox and an app
 * sandbox get them the same way, from the session owner's key and the
 * deployment's configured gateway URLs. Two copies would only have to drift once
 * for one kind of sandbox to lose its model access.
 */
import { ANTHROPIC_BASE_URL, OPENAI_BASE_URL } from "../config.js";

export interface GatewayUrls {
  anthropic?: string;
  openai?: string;
}

/** The URLs this deployment is configured with. */
export const configuredGatewayUrls = (): GatewayUrls => ({ anthropic: ANTHROPIC_BASE_URL, openai: OPENAI_BASE_URL });

/**
 * The owner's key under the conventional Anthropic / OpenAI names. Empty key:
 * nothing is set, and no empty string stands in for a credential.
 */
export function modelKeyEnv(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { ANTHROPIC_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : {};
}

/** The gateway base URLs, each only when configured. */
export function modelBaseUrlEnv(urls: GatewayUrls = configuredGatewayUrls()): Record<string, string> {
  const env: Record<string, string> = {};
  if (urls.anthropic) env.ANTHROPIC_BASE_URL = urls.anthropic;
  if (urls.openai) env.OPENAI_BASE_URL = urls.openai;
  return env;
}

/** Keys and base URLs together. */
export function modelGatewayEnv(apiKey: string | undefined, urls?: GatewayUrls): Record<string, string> {
  return { ...modelKeyEnv(apiKey), ...modelBaseUrlEnv(urls) };
}
