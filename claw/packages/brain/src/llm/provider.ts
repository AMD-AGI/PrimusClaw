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
  /**
   * What this turn did about prompt caching, for metering only.
   *
   * Deliberately here and not inside `LlmTurnUsage`. That type is accumulated
   * into `TokenUsage`, which the loop spreads into the version-3 checkpoint
   * through an unvalidated `{...state}`, then out through ResultMessage, the
   * agent_done callback and `claw_tasks.token_usage` to clients. A new key
   * there arrives `undefined` from any checkpoint written before it existed,
   * and `+=` turns that into NaN on the far side of a resume. This one dies in
   * `runTurn`.
   *
   * Optional rather than required: `test/` is outside the tsconfig include and
   * tsx erases types, so a required field would not break the existing session
   * doubles -- they would silently supply nothing and the metric would read as
   * a real zero.
   */
  cacheReport?: LlmCacheReport;
  /**
   * How big this turn's prompt actually was, in the provider's own accounting.
   *
   * `usage.input_tokens` cannot be compared against a context budget once
   * caching works: it is the UNCACHED REMAINDER on both wires -- measured on
   * the live gateway, the same prompt reads 10,960 without a cache marker and
   * 6 with one -- so a guard written against it silently stops firing the
   * moment caching starts working. This field is the whole prompt, which is
   * the number a context budget is actually about.
   *
   * Both providers now compute it the same way, `input + cache_read +
   * cache_create`, because the OpenAI path normalizes the gateway's inclusive
   * `prompt_tokens` down to the remainder at the read site. That was not
   * always true: the OpenAI path used to report the inclusive number as
   * `input_tokens` and had to bypass the sum here to avoid double-counting the
   * cached portion, which is why this doc once said the two needed opposite
   * arithmetic. One meaning now holds on both, and the sum is the only correct
   * way to recover the total.
   *
   * Absent from a session double, in which case callers fall back to
   * `usage.input_tokens` -- the remainder, which UNDER-reports the prompt.
   * That is a test-only path (see `cacheReport` above for why these are
   * optional); a provider that reaches production without setting this would
   * leave compaction comparing against a number that shrinks as the cache
   * improves.
   */
  promptTokens?: number;
}

export interface LlmCacheReport {
  /** Markers counted off the request body that was actually sent. */
  breakpointsSent: number;
  /** False once a session has given up on markers after a gateway rejection. */
  enabled: boolean;
  /**
   * Which usage numbers this provider can actually speak to.
   *
   * The Anthropic path reports both. The OpenAI path never assigns
   * `cache_create` at all, so reporting its structural zero as an observation
   * is how "we cannot see writes" gets averaged into a dashboard as "there
   * were no writes" -- the exact shape of the incident this exists to catch.
   */
  reported: ReadonlyArray<"cache_read" | "cache_create">;
  /**
   * Allowlisted response headers from the attempt that served this turn.
   *
   * The counter can say a read was lost; it cannot say which backend lost it,
   * and on a miss that is the first question worth asking. Populated only when
   * the deployment names headers in LLM_DEBUG_RESPONSE_HEADERS, because which
   * header identifies a backend is a property of the gateway in front of Claw,
   * not of Claw.
   */
  upstreamHeaders?: Record<string, string>;
  /**
   * Where this turn's markers sat, as ordinals in a flat walk over the blocks
   * actually sent, and how many blocks that walk had.
   *
   * `breakpointsSent` says markers went out; it stays at its healthy maximum
   * while the chain they form is broken. The break is a distance: two
   * consecutive markers further apart than the provider's lookback, which one
   * turn appending many blocks at once can open in a single step. Only the
   * positions show it, and only on the turn that failed -- by the next turn
   * the plan has rolled and the evidence is gone.
   *
   * Optional because the OpenAI path builds its markers elsewhere and session
   * doubles supply neither.
   */
  markerBlockOffsets?: ReadonlyArray<number>;
  promptBlocks?: number;
  /** Write split by lifetime, when the gateway reports it. A 1h marker that
   *  comes back as a 5m write is a silent downgrade worth seeing. */
  createdEphemeral5m?: number;
  createdEphemeral1h?: number;
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
