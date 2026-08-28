// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Haiku-based content summarization for web_fetch.
 *
 * The guideline tier is chosen per host: preapproved documentation sites get
 * the relaxed prompt, everything else the strict one. See tools/web/preapproved.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { isPreapprovedHost } from "./preapproved.js";
import { WEB_FETCH_SUMMARIZE_MODEL } from "../../config.js";
import type { SessionCostTracker } from "./types.js";
import pino from "pino";

const logger = pino({ name: "web-summarize" });

export const MAX_MARKDOWN_LENGTH = 100_000;

const GUIDELINE_PREAPPROVED =
  "Be concise. Include relevant code examples and documentation details.";

const GUIDELINE_STRICT =
  "Quote at most 125 characters from the source. Paraphrase or summarize instead. " +
  "Do not reproduce song lyrics, full articles, or legal commentary.";

export interface SummarizeOpts {
  markdown: string;
  prompt: string;
  url: string;
  anthropic: Anthropic;
  sessionCost: SessionCostTracker;
  signal?: AbortSignal;
}

/**
 * Summarize web content via a small fast model (Haiku by default).
 * Returns summarized text, or raw markdown on failure with a diagnostic header.
 */
export async function summarizeContent(opts: SummarizeOpts): Promise<string> {
  const { url, prompt, anthropic, sessionCost, signal } = opts;

  let text = opts.markdown;
  if (text.length > MAX_MARKDOWN_LENGTH) {
    text = text.slice(0, MAX_MARKDOWN_LENGTH) + "\n\n[Content truncated due to length...]";
  }

  let guidelines = GUIDELINE_STRICT;
  try {
    const parsed = new URL(url);
    if (isPreapprovedHost(parsed.hostname, parsed.pathname)) {
      guidelines = GUIDELINE_PREAPPROVED;
    }
  } catch {
    // malformed URL — use strict guidelines
  }

  const userContent = `Web page content:\n---\n${text}\n---\n\n${prompt}\n\n${guidelines}`;

  try {
    const resp = await anthropic.messages.create(
      {
        model: WEB_FETCH_SUMMARIZE_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: userContent }],
      },
      { signal },
    );

    const rawUsage = resp.usage as unknown as Record<string, number>;
    sessionCost.addUsage({
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      cache_read: rawUsage.cache_read_input_tokens ?? 0,
      cache_create: rawUsage.cache_creation_input_tokens ?? 0,
    });

    const textBlocks = resp.content.filter((b) => b.type === "text");
    if (textBlocks.length === 0) return "No response from model";
    return textBlocks.map((b) => b.text).join("\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url, err: msg }, "summarization_failed");
    return `Summarized: failed (${msg})\n---\n${text}`;
  }
}
