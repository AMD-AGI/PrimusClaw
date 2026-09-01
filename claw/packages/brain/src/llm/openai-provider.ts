// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Message, ToolSchema } from "@claw/protocol";
import { STREAM_FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from "../config.js";
import type {
  LlmContentBlock,
  LlmProvider,
  LlmSession,
  LlmSessionOptions,
  LlmToolUseBlock,
  LlmTurnResult,
} from "./provider.js";
import {
  headerModelFromStream,
  resolveRoutedModel,
  wrapFetchCaptureRoutedModel,
  type RoutedModelSink,
} from "./routed-model.js";

/**
 * finish_reason (OpenAI) -> stop_reason (canonical, Anthropic-shaped) so
 * agent/agent-loop.ts's `stopReason === "end_turn"` / "max_tokens" checks work
 * unchanged regardless of which provider produced the turn.
 */
function normalizeStopReason(finishReason: string | null): string | null {
  switch (finishReason) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    default: return finishReason;
  }
}

/**
 * Canonical content-block messages -> OpenAI wire messages. This is the only
 * real shape difference between the two APIs: Anthropic embeds tool_use /
 * tool_result as content blocks inside ordinary assistant/user messages,
 * while OpenAI expects tool calls on `assistant.tool_calls` and tool results
 * as standalone `role: "tool"` messages.
 */
function toOpenAiMessages(messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as ChatCompletionMessageParam);
      continue;
    }
    const blocks = m.content as Array<Record<string, unknown>>;
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id),
          type: "function" as const,
          function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      } as ChatCompletionMessageParam);
      continue;
    }
    // user/system role: tool_result blocks become standalone `tool`
    // messages; any remaining blocks (plain text, brain-synthesized
    // sandbox-rebuild notices, etc.) collapse into one user/system message.
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    for (const tr of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: String(tr.tool_use_id),
        content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? ""),
      });
    }
    const rest = blocks.filter((b) => b.type !== "tool_result");
    if (rest.length) {
      const text = rest.map((b) => (b.type === "text" ? String(b.text ?? "") : JSON.stringify(b))).join("\n");
      out.push({ role: m.role === "system" ? "system" : "user", content: text } as ChatCompletionMessageParam);
    }
  }
  return out;
}

function toOpenAiTools(tools: ToolSchema[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

async function streamingTurn(
  client: OpenAI,
  model: string,
  messages: Message[],
  tools: ToolSchema[],
  signal: AbortSignal | undefined,
  capture: RoutedModelSink,
): Promise<LlmTurnResult> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  const t0 = Date.now();
  const firstByteTimer = setTimeout(() => {
    ctrl.abort(new Error(`stream first-byte timeout after ${STREAM_FIRST_BYTE_TIMEOUT_MS}ms`));
  }, STREAM_FIRST_BYTE_TIMEOUT_MS);

  let stream;
  try {
    stream = await client.chat.completions.create(
      {
        model,
        messages: toOpenAiMessages(messages),
        tools: tools.length ? toOpenAiTools(tools) : undefined,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 16384,
      },
      { signal: ctrl.signal },
    );
  } catch (err) {
    clearTimeout(firstByteTimer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    throw err;
  }

  clearTimeout(firstByteTimer);
  const firstByteMs = Date.now() - t0;

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      ctrl.abort(new Error(`stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`));
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  armIdleTimer();

  let textBlock: { type: "text"; text: string } | null = null;
  let thinkingBlock: { type: "thinking"; thinking: string } | null = null;
  // tool_calls stream in by `index`; buffer name once + arguments chunks,
  // JSON.parse only at the end (mirrors Anthropic's input_json_delta
  // accumulation in llm/anthropic-provider.ts).
  const toolCallBuf = new Map<number, { id: string; name: string; argsBuf: string }>();
  let stopReason: string | null = null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 };
  let bodyModel: string | undefined;
  let sawUsage = false;

  try {
    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      armIdleTimer();
      if (signal?.aborted) break;

      if (chunk.model) bodyModel = chunk.model;

      // Only present (non-null) on the final chunk when stream_options.
      // include_usage=true — see openai SDK ChatCompletionChunk docs.
      if (chunk.usage) {
        sawUsage = true;
        usage.input_tokens = chunk.usage.prompt_tokens ?? 0;
        usage.output_tokens = chunk.usage.completion_tokens ?? 0;
        usage.cache_read = (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta as Record<string, unknown>;

      if (typeof delta.content === "string" && delta.content) {
        if (!textBlock) textBlock = { type: "text", text: "" };
        textBlock.text += delta.content;
      }
      // Best-effort: some OpenAI-compatible gateways (vLLM reasoning
      // parsers, DeepSeek-style APIs) stream a non-standard
      // `reasoning_content` delta for reasoning models. Map it to a
      // `thinking` block when present; silently absent otherwise.
      const reasoning = (delta as any).reasoning_content;
      if (typeof reasoning === "string" && reasoning) {
        if (!thinkingBlock) thinkingBlock = { type: "thinking", thinking: "" };
        thinkingBlock.thinking += reasoning;
      }
      for (const tc of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
        const idx = tc.index as number;
        const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
        const existing = toolCallBuf.get(idx);
        if (!existing) {
          toolCallBuf.set(idx, {
            id: String(tc.id ?? `call_${idx}`),
            name: String(fn.name ?? ""),
            argsBuf: String(fn.arguments ?? ""),
          });
        } else {
          if (fn.name) existing.name = String(fn.name);
          if (fn.arguments) existing.argsBuf += String(fn.arguments);
        }
      }

      if (choice.finish_reason) stopReason = normalizeStopReason(choice.finish_reason);
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }

  const content: LlmContentBlock[] = [];
  if (thinkingBlock) content.push(thinkingBlock);
  if (textBlock) content.push(textBlock);
  const toolUseBlocks: LlmToolUseBlock[] = [...toolCallBuf.values()].map((tc) => {
    let input: Record<string, unknown>;
    try {
      input = tc.argsBuf.length ? JSON.parse(tc.argsBuf) : {};
    } catch {
      input = { _raw: tc.argsBuf };
    }
    return { type: "tool_use", id: tc.id, name: tc.name, input };
  });
  content.push(...toolUseBlocks);

  // Same stream-truncation defenses as llm/anthropic-provider.ts — see its
  // docstring for rationale (transient; caller's retry/backoff handles it).
  if (stopReason === null) {
    const err: any = new Error(`stream truncated: finish_reason=null after ${Date.now() - t0}ms (output_tokens=${usage.output_tokens})`);
    err.code = "STREAM_TRUNCATED";
    throw err;
  }
  for (const b of toolUseBlocks) {
    if (!b.input || (typeof b.input === "object" && Object.keys(b.input).length === 0)) {
      const err: any = new Error(`tool_use[${b.name}] has empty input — likely truncated`);
      err.code = "TOOL_INPUT_EMPTY";
      throw err;
    }
    if ("_raw" in b.input && Object.keys(b.input).length === 1) {
      const err: any = new Error(`tool_use[${b.name}] input JSON parse failed (raw=${String((b.input as any)._raw).slice(0, 120)})`);
      err.code = "TOOL_INPUT_PARSE_FAILED";
      throw err;
    }
  }

  return {
    content,
    stopReason,
    usage,
    firstByteMs,
    routedModel: resolveRoutedModel({
      bodyModel,
      headerModel: capture.headerModel ?? headerModelFromStream(stream),
    }),
    // OpenAI's prompt_tokens already counts cached tokens, unlike Anthropic's
    // input_tokens, which reports only the uncached remainder. Adding the
    // cache fields on top here would double-count and halve the effective
    // compaction threshold on this path.
    //
    // `undefined` rather than 0 when no usage arrived at all, for the reason
    // spelled out in the Anthropic provider: a gateway that omits usage would
    // otherwise pin the compaction trigger at zero for the whole run.
    // stream_options.include_usage is requested, but not every
    // OpenAI-compatible gateway honours it.
    promptTokens: sawUsage ? usage.input_tokens : undefined,
    cacheReport: {
      // No markers are rendered on this path: toOpenAiMessages is not a 1:1
      // mapping (a tool_result message fans out into N role:"tool" messages)
      // and it collapses content to strings, which cannot carry a marker.
      breakpointsSent: 0,
      enabled: false,
      // `cache_create` is initialised above and never assigned -- this
      // transport has no way to report a cache write. Declaring that is the
      // difference between "we cannot see writes" and "there were no writes";
      // a dashboard averaging the second is the exact shape of the incident
      // this whole change exists to prevent.
      reported: ["cache_read"] as const,
    },
  };
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai" as const;

  createSession(opts: LlmSessionOptions): LlmSession {
    const { model, apiUrl, apiKey, userId, sessionId } = opts;

    const litellmTags = ["product:primus-claw", "executor:brain", `engine:${model.split("-")[0]}`].join(",");
    const litellmMeta = JSON.stringify({ session_id: sessionId || "", user_id: userId || "" });

    // baseURL empty string would make the SDK reject construction; pass
    // undefined so it falls back to the SDK default (api.openai.com) when
    // truly unset (should not happen given getProvider()'s selection logic,
    // but keeps this class safe to construct standalone/in tests).
    const capture: RoutedModelSink = {};
    const client = new OpenAI({
      apiKey,
      baseURL: apiUrl || undefined,
      maxRetries: 2,
      fetch: wrapFetchCaptureRoutedModel(capture),
      defaultHeaders: {
        "x-litellm-tags": litellmTags,
        "x-litellm-spend-logs-metadata": litellmMeta,
        "x-litellm-end-user-id": userId || "",
        // See llm/anthropic-provider.ts: the Auto Router's session_affinity reads
        // metadata.session_id, which the proxy fills only from this header.
        "x-litellm-session-id": sessionId || "",
      },
    });

    return buildOpenAiSession(client, model, capture);
  }
}

/**
 * The session, over a client someone else built.
 *
 * Same seam as the Anthropic provider's, and for the same reason: without it
 * nothing can assert what this path puts on the wire or what it claims about
 * its own usage numbers. The loop's `LoopOptions.llmSession` seam sits above
 * the provider and never sees either.
 */
export function buildOpenAiSession(
  client: OpenAI,
  model: string,
  capture: RoutedModelSink = {},
): LlmSession {
  return {
    streamTurn: (messages, tools, signal) =>
      streamingTurn(client, model, messages, tools, signal, capture),
      async complete(systemPrompt, userText, maxTokens) {
        const resp = await client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userText },
          ],
        });
        const text = resp.choices[0]?.message?.content?.trim();
        if (!text) throw new Error("completion returned empty text");
        return text;
      },
  };
}
