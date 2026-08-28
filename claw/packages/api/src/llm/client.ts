// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { MEMORY_LLM_MODEL, MEMORY_LLM_API_KEY, MEMORY_LLM_BASE_URL } from "../config.js";
import pino from "pino";

const logger = pino({ name: "llm-client" });

export interface LlmCompletionOptions {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  /** 0 = deterministic (use for classification/tagging), default = LLM gateway default. */
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Per-user LLM key cache (in-process, never expires).
//
// Why: background tasks (memory extraction, profile update, skill evolution,
// summarization) run OUTSIDE any request context, so they cannot reach the
// per-request LLM key that the auth middleware resolves. Previously
// they silently fell back to empty env vars and failed (memory.profile_update_failed).
//
// How it is populated: authMiddleware calls `cacheUserLlmKey(userId, llmKey)`
// on every successful auth — so the very next inbound request from a user
// refreshes that user's key (matches "new conversation => refresh" intent).
//
// Lifetime: process-local, never auto-evicted. If the process restarts, the
// cache cold-starts empty and the next inbound request repopulates it.
// Fallback to MEMORY_LLM_API_KEY (env) if we have no userId or miss the cache.
// ---------------------------------------------------------------------------
interface CachedLlmKey { virtualKey: string; baseUrl?: string; }
const userLlmKeyCache = new Map<string, CachedLlmKey>();

export function cacheUserLlmKey(userId: string, llmKey: string, baseUrl?: string): void {
  if (!userId || !llmKey) return;
  userLlmKeyCache.set(userId, { virtualKey: llmKey, baseUrl });
}

export function getCachedUserLlmKey(userId: string): CachedLlmKey | undefined {
  return userLlmKeyCache.get(userId);
}

function resolveKey(userId: string | null): { apiKey: string; baseUrl: string; source: "user" | "env" } {
  if (userId) {
    const cached = userLlmKeyCache.get(userId);
    if (cached?.virtualKey) {
      return {
        apiKey: cached.virtualKey,
        baseUrl: cached.baseUrl || MEMORY_LLM_BASE_URL || "",
        source: "user",
      };
    }
  }
  return { apiKey: MEMORY_LLM_API_KEY || "", baseUrl: MEMORY_LLM_BASE_URL || "", source: "env" };
}

/**
 * Single-turn LLM completion for API-layer background tasks
 * (memory extraction, skill creation/evolution, summarization).
 * Not for agent loops — use Brain's agentLoop for multi-turn.
 *
 * @param userId  The user this background task is for. Used to look up the
 *                per-user LLM key cached by authMiddleware. Pass `null`
 *                only for truly system-level callers (e.g. cron), which
 *                fall back to MEMORY_LLM_API_KEY env var.
 */
export async function callMemoryLLM<T = Record<string, unknown>>(
  userId: string | null,
  promptTemplate: string,
  variables: Record<string, unknown>,
  opts: Partial<LlmCompletionOptions> = {},
): Promise<T> {
  const model = opts.model || MEMORY_LLM_MODEL;
  const { apiKey, baseUrl, source } = resolveKey(userId);

  if (!apiKey || !baseUrl) {
    throw new Error(
      `LLM key unavailable (userId=${userId ?? "null"}, source=${source}): ` +
      `neither cached user virtualKey nor MEMORY_LLM_API_KEY is set`,
    );
  }

  let userPrompt = promptTemplate;
  for (const [key, value] of Object.entries(variables)) {
    const strValue = typeof value === "string" ? value : JSON.stringify(value);
    userPrompt = userPrompt.replaceAll(`{${key}}`, strValue);
  }

  const messages: Array<Record<string, unknown>> = [];
  if (opts.systemPrompt) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: userPrompt });

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts.maxTokens || 4096,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!resp.ok) {
        const body = (await resp.text()).slice(0, 500);
        throw new Error(`LLM ${resp.status}: ${body}`);
      }

      const data = await resp.json() as Record<string, unknown>;
      const content = data.content as Array<Record<string, unknown>>;
      const textBlock = content?.find((b: any) => b.type === "text");
      const text = (textBlock as any)?.text as string || "";

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
      }

      return JSON.parse(jsonMatch[0]) as T;
    } catch (err: any) {
      if (attempt < maxRetries && (err.message?.includes("429") || err.message?.includes("timeout"))) {
        logger.warn({ err, attempt }, "llm-client.retry");
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      logger.error({ err, model, userId, keySource: source }, "llm-client.failed");
      throw err;
    }
  }

  throw new Error("llm-client: unreachable");
}
