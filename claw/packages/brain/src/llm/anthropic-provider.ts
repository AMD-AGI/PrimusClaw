// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import Anthropic from "@anthropic-ai/sdk";
import type {
  RawMessageStreamEvent,
  ContentBlock,
  MessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import { LLM_CACHE_TTL, PROMPT_CACHE_ENABLED, STREAM_FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from "../config.js";
import { looksLikeCacheRejection } from "./cache-rejection.js";
import { requiredArgToolNames } from "./tool-schema.js";
import { prepareAnthropicRequest, stripCacheControl, type PreparedAnthropicRequest } from "./anthropic-cache.js";
import type { Message } from "@claw/protocol";
import type { LlmCacheReport, LlmContentBlock, LlmProvider, LlmSession, LlmSessionOptions, LlmTurnResult } from "./provider.js";
import {
  headerModelFromStream,
  resolveRoutedModel,
  wrapFetchCaptureRoutedModel,
  type RoutedModelSink,
} from "./routed-model.js";
import { metrics } from "../infra/metrics.js";
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
/**
 * Per-session state for the cache-marker kill switch.
 *
 * Session-scoped rather than global: a rejection is evidence about this
 * gateway and this model, and one bad session should not silently switch
 * caching off for every other run in the process.
 */
interface SessionCacheState {
  disabled: boolean;
  /** Consecutive failures seen while sending markers. Reset by any success. */
  decoratedFailures: number;
}

/**
 * Does this failure look like the gateway objecting to a cache marker?
 *
 * Matched against the whole serialized error, and deliberately NOT gated on
 * HTTP 400. This gateway is documented in agent-loop.ts to re-wrap upstream
 * failures as 502/503/504 and even as a 401, and every one of those is in the
 * loop's transient set -- so a status-gated latch would never arm while the
 * loop cheerfully re-sent the same rejected body up to twelve times a turn.
 */

async function streamingTurn(
  client: Anthropic,
  model: string,
  messages: MessageParam[],
  tools: AnthropicTool[],
  signal: AbortSignal | undefined,
  capture: RoutedModelSink,
  cacheState: SessionCacheState,
): Promise<LlmTurnResult> {
  // One abort controller PER ATTEMPT, not per turn.
  //
  // The first-byte watchdog aborts the controller it is watching, and an
  // AbortController is one-shot. Sharing one across attempts means the
  // undecorated fallback below inherits an already-aborted signal and rejects
  // before a request leaves the process -- so the probe that decides whether
  // the markers were at fault never actually runs, and the latch arms or does
  // not on the strength of a request that was never sent.
  let activeCtrl: AbortController | undefined;
  const onParentAbort = () => activeCtrl?.abort(signal?.reason);
  if (signal && !signal.aborted) {
    signal.addEventListener("abort", onParentAbort, { once: true });
  }

  // The system hoist is NOT conditional on caching.
  //
  // The Messages API has no "system" role; leaving one in `messages` works
  // only because the gateway rewrites it. That is a correctness fix in its own
  // right, so it must survive PROMPT_CACHE_ENABLED=false and the session latch
  // -- otherwise turning caching off silently reverts the request to a shape
  // the API does not accept. Only the markers are gated.
  const prepared = prepareAnthropicRequest(messages as unknown as Message[], { ttl: LLM_CACHE_TTL });
  const useMarkers = PROMPT_CACHE_ENABLED && !cacheState.disabled;
  const decorated = useMarkers ? prepared : stripCacheControl(prepared);

  // First-byte deadline: with stream:true the gateway must flush SSE headers
  // promptly. If it doesn't, we abort and let the caller handle the failure.
  // Each attempt gets its own budget, not the remainder of the previous one's.
  const t0 = Date.now();
  const openStream = async (body: PreparedAnthropicRequest) => {
    const ctrl = new AbortController();
    activeCtrl = ctrl;
    if (signal?.aborted) ctrl.abort(signal.reason);
    const timer = setTimeout(() => {
      ctrl.abort(new Error(`stream first-byte timeout after ${STREAM_FIRST_BYTE_TIMEOUT_MS}ms`));
    }, STREAM_FIRST_BYTE_TIMEOUT_MS);
    try {
      return await client.messages.create(
        {
          model,
          ...(body.system ? { system: body.system as any } : {}),
          messages: body.messages as unknown as MessageParam[],
          tools,
          max_tokens: 16384,
          stream: true,
        },
        { signal: ctrl.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let stream;
  let breakpointsSent = decorated.breakpointsApplied;
  // Moves with the count, never independently: the undecorated retry below
  // zeroes one, and positions left over from the decorated attempt would say
  // markers were sent on a request that carried none.
  let markerBlockOffsets: ReadonlyArray<number> = decorated.markerBlockOffsets;
  try {
    stream = await openStream(decorated);
    cacheState.decoratedFailures = 0;
  } catch (err) {
    // Two independent reasons to suspect the markers, because the obvious one
    // is not reliable here. The first is the error saying so. The second is a
    // second consecutive failure while decorated -- which we test by actually
    // dropping the markers and seeing whether the request goes through, rather
    // than by assuming. If the bare request fails too, the markers were not
    // the problem and the session keeps them.
    const suspect = breakpointsSent > 0
      && (looksLikeCacheRejection(err) || cacheState.decoratedFailures >= 1);
    if (!suspect) {
      if (breakpointsSent > 0) cacheState.decoratedFailures++;
      if (signal) signal.removeEventListener("abort", onParentAbort);
      throw err;
    }
    logger.warn(
      { err: (err as Error)?.message, breakpoints: breakpointsSent },
      "llm.cache_control.retry_undecorated",
    );
    try {
      stream = await openStream(stripCacheControl(prepared));
      cacheState.disabled = true;
      cacheState.decoratedFailures = 0;
      breakpointsSent = 0;
      markerBlockOffsets = [];
      metrics.onLlmCacheDisabled();
      logger.error({ model }, "llm.cache_control.disabled_for_session");
    } catch (bareErr) {
      // Deliberately does NOT reset decoratedFailures. That attempt did fail
      // while decorated, so it is evidence, and zeroing it discards the very
      // thing that arms the probe. On a gateway that both rejects markers and
      // is slow -- and this one re-wraps upstream failures as 502/503/504 and
      // 401 -- resetting leaves the latch permanently one failure short of
      // arming, which is the end state the status-gated design was rejected
      // for.
      if (signal) signal.removeEventListener("abort", onParentAbort);
      throw bareErr;
    }
  }

  const firstByteMs = Date.now() - t0;

  // Idle watchdog: abort if no event arrives within STREAM_IDLE_TIMEOUT_MS.
  // Reset on every chunk; cleared in the finally block.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      activeCtrl?.abort(new Error(`stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`));
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
  let sawUsage = false;
  let created5m: number | undefined;
  let created1h: number | undefined;
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
            sawUsage = true;
            usage.input_tokens = u.input_tokens ?? 0;
            usage.cache_create = u.cache_creation_input_tokens ?? 0;
            usage.cache_read = u.cache_read_input_tokens ?? 0;
            // A 1h marker that comes back as a 5m write is a silent downgrade:
            // the request succeeds, the cache works, it just expires under the
            // sleep it was chosen to outlast.
            const split = (u as Record<string, any>).cache_creation;
            if (split && typeof split === "object") {
              created5m = split.ephemeral_5m_input_tokens ?? undefined;
              created1h = split.ephemeral_1h_input_tokens ?? undefined;
            }
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
  // A tool_use that arrived with zero JSON fragments is not evidence of a
  // truncated stream. Truncation leaves stop_reason null and is rejected
  // above; a fragment that arrived and did not parse becomes `_raw` and is
  // rejected as TOOL_INPUT_PARSE_FAILED below. What is left is a model calling
  // a tool with no arguments -- correct for every tool whose schema marks none
  // required. `ls` is one: its single property is optional and its description
  // names a default. Blaming truncation there spent four retries on a call
  // that was right the first time, then failed the session, because every
  // retry did the same legitimate thing. So the question is asked of the
  // schema we published, not of the emptiness.
  const requiresArgs = requiredArgToolNames(tools);
  for (const b of finalBlocks) {
    if ((b as any).type === "tool_use") {
      const input = (b as any).input;
      const empty = !input || (typeof input === "object" && Object.keys(input).length === 0);
      if (empty && requiresArgs.has(String((b as any).name))) {
        const err: any = new Error(`tool_use[${(b as any).name}] has empty input but its schema requires arguments`);
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
    // Anthropic's input_tokens is the uncached remainder; the whole prompt is
    // the three added together.
    // `undefined`, not 0, when the response carried no usage at all.
    //
    // A missing number and a real zero are different facts, and the caller's
    // `?? input_tokens` fallback cannot separate them: 0 is not nullish, so a
    // usage-less turn would pin the compaction trigger at zero and leave that
    // entire run with no context guard -- growing until the model rejects the
    // request with a 400 that streamTurnWithRetry does not retry. Compaction
    // is the only such guard in Brain, so "we do not know how big this prompt
    // was" must not read as "it was empty".
    promptTokens: sawUsage
      ? usage.input_tokens + usage.cache_read + usage.cache_create
      : undefined,
    cacheReport: {
      breakpointsSent,
      enabled: PROMPT_CACHE_ENABLED && !cacheState.disabled,
      // This path reads both numbers straight off message_start.
      reported: ["cache_read", "cache_create"] as const,
      markerBlockOffsets,
      promptBlocks: decorated.totalBlocks,
      createdEphemeral5m: created5m,
      createdEphemeral1h: created1h,
    } satisfies LlmCacheReport,
  };
}

/**
 * The headers every request carries.
 *
 * A named function so that what is NOT here is a line a test can hold down.
 * `x-auto-prompt-caching: true` used to be: a header asking the gateway to
 * pick cache breakpoints on our behalf, whose implementation landed two months
 * after the header and has never once fired. It read in the diff, and to
 * everyone who came after, as "caching is on".
 *
 * It is removed rather than left as a harmless no-op. Now that Brain places
 * its own markers, a gateway hook that started working would add its own on
 * top -- and four is the hard cap, so the two together are a 400.
 */
export function anthropicDefaultHeaders(opts: {
  litellmTags: string;
  litellmMeta: string;
  userId?: string;
  sessionId?: string;
}): Record<string, string> {
  return {
    "anthropic-version": "2023-06-01",
    "x-litellm-tags": opts.litellmTags,
    "x-litellm-spend-logs-metadata": opts.litellmMeta,
    "x-litellm-end-user-id": opts.userId || "",
    // The Auto Router pins a session to one backend only when it can read a
    // session id, and it reads exactly one place: metadata.session_id, which
    // the proxy fills from x-litellm-trace-id / x-litellm-session-id. Without
    // it session_affinity is configured but inert and the backend can change
    // mid-conversation -- which breaks thinking replay and splits the prompt
    // cache, since cache entries are scoped to the model that wrote them.
    "x-litellm-session-id": opts.sessionId || "",
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
      defaultHeaders: anthropicDefaultHeaders({ litellmTags, litellmMeta, userId, sessionId }),
    });

    return buildAnthropicSession(client, model, capture);
  }
}

/**
 * The session, over a client someone else built.
 *
 * Split out so a test can drive a stub client and read the request body that
 * actually goes on the wire. Nothing in this repo could do that before, which
 * is how a header everybody believed was enabling prompt caching ran for two
 * years without one request ever carrying a breakpoint. The seam the loop
 * tests use (`LoopOptions.llmSession`) sits above the provider and cannot see
 * a body at all.
 */
export function buildAnthropicSession(
  client: Anthropic,
  model: string,
  capture: RoutedModelSink = {},
): LlmSession {
  const cacheState: SessionCacheState = { disabled: false, decoratedFailures: 0 };
  return {
    streamTurn: (messages, tools, signal) =>
      streamingTurn(
        client,
        model,
        messages as unknown as MessageParam[],
        tools as unknown as AnthropicTool[],
        signal,
        capture,
        cacheState,
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
