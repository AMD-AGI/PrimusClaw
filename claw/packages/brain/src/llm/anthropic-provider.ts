// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  ContentBlock,
  MessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import { STREAM_FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from "../config.js";
import type { LlmContentBlock, LlmProvider, LlmSession, LlmSessionOptions, LlmTurnResult } from "./provider.js";
import {
  headerModelFromStream,
  resolveRoutedModel,
  wrapFetchCaptureRoutedModel,
  type RoutedModelSink,
} from "./routed-model.js";
import pino from "pino";

const logger = pino({ name: "anthropic-provider" });

/**
 * Streaming LLM call. Replaces the legacy non-streaming fetch path that hit
 * the gateway's 60s headers timeout when first-byte time exceeded the deadline
 * (large skill prompts + Opus thinking can take 60–180s end-to-end). With
 * streaming, the gateway flushes SSE headers within ~1s so we get steady
 * progress even on slow LLM compute. Returns the same shape (content blocks,
 * stop_reason, usage) the surrounding loop already consumes — no other code
 * changes needed.
 */
async function streamingTurn(
  client: Anthropic,
  model: string,
  messages: MessageParam[],
  tools: AnthropicTool[],
  signal: AbortSignal | undefined,
  capture: RoutedModelSink,
): Promise<LlmTurnResult> {
  // Outer abort controller so first-byte / idle watchdogs can kill the stream
  // independently of the caller-supplied signal.
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }

  // First-byte deadline: with stream:true the gateway must flush SSE headers
  // promptly. If it doesn't, we abort and let the caller handle the failure.
  const t0 = Date.now();
  const firstByteTimer = setTimeout(() => {
    ctrl.abort(new Error(`stream first-byte timeout after ${STREAM_FIRST_BYTE_TIMEOUT_MS}ms`));
  }, STREAM_FIRST_BYTE_TIMEOUT_MS);

  let stream;
  try {
    stream = await client.messages.create(
      { model, messages, tools, max_tokens: 16384, stream: true },
      { signal: ctrl.signal },
    );
  } catch (err) {
    clearTimeout(firstByteTimer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
    throw err;
  }

  // Reset watchdog: from here on it's an idle timer.
  clearTimeout(firstByteTimer);
  const firstByteMs = Date.now() - t0;

  // Idle watchdog: abort if no event arrives within STREAM_IDLE_TIMEOUT_MS.
  // Reset on every chunk; cleared in the finally block.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      ctrl.abort(new Error(`stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`));
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  armIdleTimer();

  // Per-block accumulators. tool_use blocks need their input JSON to be
  // assembled from a stream of input_json_delta strings then JSON.parse'd at
  // content_block_stop. text blocks just append text_delta. thinking blocks
  // append thinking_delta + signature_delta.
  const blocks: ContentBlock[] = [];
  const toolJsonBuf: Map<number, string> = new Map();
  let stopReason: string | null = null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 };
  let bodyModel: string | undefined;

  try {
    for await (const evt of stream as AsyncIterable<RawMessageStreamEvent>) {
      armIdleTimer();
      if (signal?.aborted) break;

      switch (evt.type) {
        case "message_start": {
          bodyModel = evt.message.model || bodyModel;
          const u = evt.message.usage;
          if (u) {
            usage.input_tokens = u.input_tokens ?? 0;
            usage.cache_create = u.cache_creation_input_tokens ?? 0;
            usage.cache_read = u.cache_read_input_tokens ?? 0;
          }
          break;
        }
        case "content_block_start": {
          const b = evt.content_block as ContentBlock;
          blocks[evt.index] = structuredClone(b);
          if (b.type === "tool_use") toolJsonBuf.set(evt.index, "");
          break;
        }
        case "content_block_delta": {
          const cur = blocks[evt.index];
          if (!cur) break;
          const d = evt.delta as unknown as Record<string, unknown>;
          if (cur.type === "text" && d.type === "text_delta") {
            cur.text += String(d.text ?? "");
          } else if (cur.type === "thinking" && d.type === "thinking_delta") {
            cur.thinking += String(d.thinking ?? "");
          } else if (cur.type === "thinking" && d.type === "signature_delta") {
            cur.signature = (cur.signature ?? "") + String(d.signature ?? "");
          } else if (cur.type === "tool_use" && d.type === "input_json_delta") {
            toolJsonBuf.set(evt.index, (toolJsonBuf.get(evt.index) ?? "") + String(d.partial_json ?? ""));
          }
          break;
        }
        case "content_block_stop": {
          const cur = blocks[evt.index];
          if (cur && cur.type === "tool_use") {
            const buf = toolJsonBuf.get(evt.index) ?? "";
            try {
              cur.input = buf.length ? JSON.parse(buf) : {};
            } catch (e) {
              logger.warn({ idx: evt.index, buf: buf.slice(0, 500) }, "tool_use.json_parse_failed");
              cur.input = { _raw: buf };
            }
            toolJsonBuf.delete(evt.index);
          }
          break;
        }
        case "message_delta": {
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          if (evt.usage?.output_tokens != null) usage.output_tokens = evt.usage.output_tokens;
          break;
        }
        case "message_stop":
          break;
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }

  const finalBlocks = blocks.filter(Boolean);

  // Stream-truncation defenses. The gateway / SDK can cut a stream mid-flight
  // (proxy-side timeout, network blip, very large output past gateway window
  // — observed at ~92s / 4641 output_tokens). When that happens stop_reason
  // is null and any in-progress tool_use block ends up with empty input.
  // Submitting that to MCP triggers `Invalid arguments: command undefined`
  // and the agent loop burns turns retrying the same broken state. We treat
  // it as transient and let the caller's retry/backoff handle it.
  if (stopReason === null) {
    const err: any = new Error(`stream truncated: stop_reason=null after ${Date.now() - t0}ms (output_tokens=${usage.output_tokens})`);
    err.code = "STREAM_TRUNCATED";
    throw err;
  }
  for (const b of finalBlocks) {
    if ((b as any).type === "tool_use") {
      const input = (b as any).input;
      if (!input || (typeof input === "object" && Object.keys(input).length === 0)) {
        const err: any = new Error(`tool_use[${(b as any).name}] has empty input — likely truncated`);
        err.code = "TOOL_INPUT_EMPTY";
        throw err;
      }
      // input.{_raw} is set by content_block_stop when JSON.parse fails on a
      // partial stream — treat the same as empty.
      if (typeof input === "object" && "_raw" in input && Object.keys(input).length === 1) {
        const err: any = new Error(`tool_use[${(b as any).name}] input JSON parse failed (raw=${String(input._raw).slice(0, 120)})`);
        err.code = "TOOL_INPUT_PARSE_FAILED";
        throw err;
      }
    }
  }

  return {
    content: finalBlocks as unknown as LlmContentBlock[],
    stopReason,
    usage,
    firstByteMs,
    routedModel: resolveRoutedModel({
      bodyModel,
      headerModel: capture.headerModel ?? headerModelFromStream(stream),
    }),
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;

  createSession(opts: LlmSessionOptions): LlmSession {
    const { model, apiUrl, apiKey, userId, sessionId } = opts;

    // Observability: LiteLLM headers — every messages.create call carries
    // the same tags for spend/log attribution.
    const litellmTags = ["product:primus-claw", "executor:brain", `engine:${model.split("-")[0]}`].join(",");
    const litellmMeta = JSON.stringify({ session_id: sessionId || "", user_id: userId || "" });

    // Constructed once per session so per-user litellm headers don't leak
    // across concurrent agent loops in the brain process. maxRetries=2 lets
    // the SDK absorb transient network noise (DNS hiccups / ECONNRESET /
    // 503), which previously surfaced as `task.failed` after dozens of
    // successful turns and forced the task to restart via NATS redelivery.
    const capture: RoutedModelSink = {};
    const client = new Anthropic({
      apiKey,
      baseURL: apiUrl,
      maxRetries: 2,
      fetch: wrapFetchCaptureRoutedModel(capture),
      defaultHeaders: {
        "anthropic-version": "2023-06-01",
        "x-litellm-tags": litellmTags,
        "x-litellm-spend-logs-metadata": litellmMeta,
        "x-litellm-end-user-id": userId || "",
        // The Auto Router pins a session to one backend only when it can read
        // a session id, and it reads exactly one place: metadata.session_id,
        // which the proxy fills from x-litellm-trace-id / x-litellm-session-id.
        // The id inside x-litellm-spend-logs-metadata above is a JSON blob the
        // router never looks at, so without this header session_affinity is
        // configured but inert and the backend can change mid-conversation --
        // which is what breaks Anthropic thinking replay and the prompt cache.
        "x-litellm-session-id": sessionId || "",
        // Tells LiteLLM gateway to auto-mark longest cacheable prefix with
        // cache_control. Cuts TTFT for follow-up turns from 90s+ to a few
        // seconds and avoids tripping the idle-stream watchdog above.
        "x-auto-prompt-caching": "true",
      },
    });

    return {
      streamTurn: (messages, tools, signal) =>
        streamingTurn(
          client,
          model,
          messages as unknown as MessageParam[],
          tools as unknown as AnthropicTool[],
          signal,
          capture,
        ),
      async complete(systemPrompt, userText, maxTokens) {
        const resp = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userText }],
        });
        const text = resp.content
          .filter((b) => b.type === "text")
          .map((b) => (b as any).text as string)
          .join("\n\n")
          .trim();
        if (!text) throw new Error("completion returned empty text");
        return text;
      },
    };
  }
}
