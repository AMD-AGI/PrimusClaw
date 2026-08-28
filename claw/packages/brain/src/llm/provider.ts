// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Message, ToolSchema } from "@claw/protocol";

/**
 * Normalized content blocks produced by any LlmProvider. Matches the
 * Anthropic content-block vocabulary already used end-to-end (checkpoint
 * state, SSE events, frontend rendering) so agent/agent-loop.ts, hooks, and
 * compaction never need to know which provider actually ran a given turn.
 */
export interface LlmTextBlock {
  type: "text";
  text: string;
}
export interface LlmThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export interface LlmToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type LlmContentBlock = LlmTextBlock | LlmThinkingBlock | LlmToolUseBlock;

export interface LlmTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_create: number;
  cache_read: number;
}

export interface LlmTurnResult {
  content: LlmContentBlock[];
  /** Normalized: "end_turn" | "tool_use" | "max_tokens" | provider-specific
   *  passthrough | null (stream truncated — callers treat this as an error). */
  stopReason: string | null;
  usage: LlmTurnUsage;
  firstByteMs: number;
  /** Backend that served this turn, as the gateway or the upstream reported
   *  it. Absent when neither named a model. */
  routedModel?: string;
}

/**
 * One LLM call sequence for a single agent-loop run. Constructed once per
 * agentLoop() invocation (not per turn) so session-scoped context (model,
 * user/session id headers, client instance) is built once and reused across
 * turns — mirrors the previous per-loop Anthropic client lifetime.
 */
export interface LlmSession {
  streamTurn(messages: Message[], tools: ToolSchema[], signal?: AbortSignal): Promise<LlmTurnResult>;
  /** Non-streaming single-shot completion used for conversation compaction.
   *  Returns the plain summary text; throws on failure so the caller can
   *  fall back to the uncompacted messages. */
  complete(systemPrompt: string, userText: string, maxTokens: number): Promise<string>;
}

export interface LlmSessionOptions {
  model: string;
  apiUrl: string;
  apiKey: string;
  userId?: string;
  sessionId?: string;
}

export interface LlmProvider {
  readonly name: "anthropic" | "openai";
  createSession(opts: LlmSessionOptions): LlmSession;
}
