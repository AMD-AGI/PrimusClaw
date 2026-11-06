// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Shared types for web-tools (search + fetch).
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface TokenUsageDelta {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create: number;
}

/** Accumulates token usage across sub-LLM calls within a session. */
export interface SessionCostTracker {
  addUsage(delta: TokenUsageDelta): void;
}

/** Concrete implementation of SessionCostTracker. */
export class SimpleSessionCostTracker implements SessionCostTracker {
  readonly usage: TokenUsageDelta = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0 };
  addUsage(d: TokenUsageDelta): void {
    this.usage.input_tokens += d.input_tokens;
    this.usage.output_tokens += d.output_tokens;
    this.usage.cache_read += d.cache_read;
    this.usage.cache_create += d.cache_create;
  }
}

/** Request-scoped context injected into web tool services. */
export interface WebToolContext {
  sessionId: string;
  apiKey: string;
  apiUrl: string;
  model: string;
  anthropic: Anthropic;
  sessionCost: SessionCostTracker;
  binaryWriter?: WebFetchBinaryWriter;
  signal?: AbortSignal;
}

/** Hands-backed writer for binary web_fetch artifacts (P6). */
export interface WebFetchBinaryWriter {
  writeArtifact(input: {
    filename: string;
    contentType: string;
    data: Buffer;
  }): Promise<{ path: string; bytes: number; sha256: string }>;
}

/** Unified search hit returned by all providers. */
export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Filled by a web tool with whether it failed: the router's `RouteOutcome`. Set only for a failure whose text is entirely the
 * tool's own words (fixed phrases, numbers, and what the model itself asked for), never for one that carries anything a remote
 * server or a search backend sent (a status text, a body, an error message, a certificate field, a redirect target), since a
 * failed call counts as having read nothing (`ReadTaint`).
 */
export interface WebToolOutcome {
  isError: boolean;
  /**
   * What the call read, as sources (`tools/citations.ts`): the pages a search answered with, the page a fetch read whole. Set only
   * by this code, from what it parsed, never from the text it returns. Each one a `CiteSource`, in the type the router's
   * `RouteOutcome` takes them in, which also holds what an MCP server listed.
   */
  sources?: unknown[];
}

/** Provider interface — each backend implements this. */
export interface WebSearchProvider {
  readonly name: string;
  search(query: string, opts: {
    maxResults?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    freshness?: string;
  }): Promise<SearchHit[]>;
}
