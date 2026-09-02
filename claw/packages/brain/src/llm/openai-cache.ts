// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { planCacheBreakpoints, type CachePlan, type CacheTtl } from "./cache-plan.js";
import type { Message } from "@claw/protocol";

/**
 * Prompt-cache markers for the OpenAI-shaped wire.
 *
 * Planned AFTER the message transform, not before, and that is the whole
 * design decision. `toOpenAiMessages` is not a 1:1 mapping -- one canonical
 * user message holding N tool_result blocks fans out into N separate
 * role:"tool" messages, several block types are folded into a joined string,
 * and `tool_use` blocks vanish into `tool_calls` where no content part exists
 * to mark. A canonical (message, block) address therefore names positions that
 * have no wire equivalent at all, so carrying a position map across the
 * transform would still leave the caller writing the "nowhere to put it"
 * fallback. Planning against what will actually be sent removes the question.
 *
 * The placement policy itself is not duplicated: the wire messages are
 * projected into a one-block-per-message view and handed to the same
 * planCacheBreakpoints the Anthropic path uses, so the anchor, the rolling
 * marks, the block-counted stride budget and the four-breakpoint cap stay in
 * one place with one set of tests.
 */

/** Wire roles whose content can carry a marker. */
// `tool` is here because a tool loop is made of it. Its content is the tool
// result as a string, and the gateway turns it into an Anthropic `tool_result`
// block -- already on the native path's allowlist, so marking one asks nothing
// new of the API. Leaving it out was what kept rolling breakpoints from
// rolling: in a tool loop nearly every message is a tool result or an
// assistant that only calls tools, so almost nothing was markable and almost
// nothing counted as distance.
const MARKABLE_WIRE_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);

type WireMessage = Record<string, unknown>;

/**
 * A block type deliberately absent from the planner's markable allowlist, used
 * to give an unmarkable wire message its real width in the stride budget.
 */
const UNMARKABLE_BLOCK = "_claw_unmarkable";

/**
 * Would a marker on this wire message reach the model?
 *
 * `role:"tool"` is excluded even though the SDK's types accept a text-parts
 * array there. Nobody has confirmed that a gateway honours a marker in that
 * position, and an unverified marker is worse than a missing one: it would be
 * counted as sent while buying nothing. The cost of leaving it out is reach,
 * not correctness -- tool messages interleave with assistant messages, so a
 * mark still lands within a message or two of the tail. Probe it before
 * including it.
 */
function markableWire(msg: WireMessage): boolean {
  if (!MARKABLE_WIRE_ROLES.has(String(msg.role))) return false;
  // toOpenAiMessages emits a string or null, never a parts array (see its
  // four push sites), so a string is the only shape there is to widen.
  return typeof msg.content === "string" && msg.content.length > 0;
}

/**
 * The projection handed to the planner: one markable block per wire message
 * that can hold a marker, and none for the rest, so the planner's block-counted
 * stride budget measures real distance on this wire.
 */
function project(wire: readonly WireMessage[]): Message[] {
  return wire.map((m) => ({
    role: (m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user") as Message["role"],
    // A message that cannot hold a marker still OCCUPIES the prompt, so it
    // still costs stride. Projecting it to no blocks at all made an assistant
    // turn that only calls tools -- content null, the commonest message in a
    // tool loop -- free, and the planner then spread its markers far wider
    // than the 18-block budget it believes it is keeping. Measured: 52 wire
    // messages produced two breakpoints, both at the head, so the cache chain
    // ended past Anthropic's 20-block lookback and every later turn re-read
    // nothing. One non-markable block per such message restores the distance
    // while leaving it unmarkable.
    content: markableWire(m)
      ? [{ type: "text", text: "" }]
      : [{ type: UNMARKABLE_BLOCK }],
  }));
}

/**
 * The marker, in whichever dialect the endpoint speaks.
 *
 * A gateway forwarding to Anthropic reads `cache_control`; genuine OpenAI
 * reads `prompt_cache_breakpoint`, and only when the request also carries
 * `prompt_cache_options.mode = "explicit"` -- see `PROMPT_CACHE_OPTIONS`.
 * Which dialect an endpoint speaks is a deployment fact; the URL cannot be
 * asked.
 */
function markerFor(style: "anthropic" | "native", ttl: CacheTtl): Record<string, unknown> {
  return style === "anthropic"
    ? { cache_control: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" } }
    : { prompt_cache_breakpoint: { mode: "explicit" } };
}

/**
 * Request-level opt-in that the native dialect requires.
 *
 * Breakpoints without it are accepted and ignored, which is the worst of the
 * three outcomes: it looks like caching is configured and bills like it is
 * not. It travels with the messages so the two can never be sent apart.
 */
export const PROMPT_CACHE_OPTIONS = { mode: "explicit" } as const;

export interface PreparedOpenAiMessages {
  messages: WireMessage[];
  /** Counted off the rendered messages, never off the plan. */
  breakpointsApplied: number;
}

/**
 * Attach markers to the wire messages, copying only what is touched.
 *
 * String content is widened into a single text part, which this gateway
 * accepts transparently -- measured: token counts and output are identical
 * either way, the only difference being the cache accounting the marker buys.
 */
export function planOpenAiCacheBreakpoints(
  wire: readonly WireMessage[],
  opts: { ttl: CacheTtl; maxBreakpoints?: number },
): CachePlan {
  return planCacheBreakpoints(project(wire), opts);
}

/**
 * Apply a plan. Split from planning so the two can disagree in a test: on any
 * input the planner produces they cannot, because the projection hides every
 * position this refuses -- but "the renderer silently dropped a planned
 * marker" is exactly what breakpointsApplied exists to surface, and a counter
 * whose failure mode is unreachable is one nobody can trust.
 */
export function renderPlannedOpenAiMarkers(
  wire: readonly WireMessage[],
  plan: CachePlan,
  opts: { style: "anthropic" | "native"; ttl: CacheTtl },
): PreparedOpenAiMessages {
  // `kind` and `systemRunLength` are ignored on purpose: this wire keeps
  // role:"system" inside the messages array, so there is no hoist to perform
  // and a system message is just another position.
  const wanted = new Set(plan.breakpoints.map((b) => b.messageIndex));
  if (wanted.size === 0) return { messages: [...wire], breakpointsApplied: 0 };

  const marker = markerFor(opts.style, opts.ttl);
  let applied = 0;
  // Widen EVERY markable message, mark only the planned ones.
  //
  // Widening is what carries a marker: string content becomes a one-element
  // parts array. Doing it only where a marker lands makes a message's shape a
  // function of where the breakpoints are -- and the rolling ones move every
  // turn, so a message widened in turn N goes back to a bare string in turn
  // N+1. Measured on this wire: request 1 sent `user:arr | user:arr`, request
  // 2 sent `user:arr | user:str | ...`. Every cached prefix containing that
  // second message is invalidated by its own re-serialisation, which is a
  // cache that pays to write and can never read.
  //
  // Widening unconditionally costs nothing -- token counts and output are
  // identical either way, measured when this path was first added -- and makes
  // the serialisation depend only on the conversation.
  const messages = wire.map((m, i) => {
    if (!markableWire(m)) return m;
    const part: Record<string, unknown> = { type: "text", text: m.content as string };
    if (wanted.has(i)) {
      applied++;
      Object.assign(part, marker);
    }
    return { ...m, content: [part] };
  });
  // Counted off the rendered messages, never off the plan: a plan/render
  // divergence is the likeliest way this quietly stops sending anything, and
  // counting the plan would report success either way.
  return { messages, breakpointsApplied: applied };
}

export function renderOpenAiCacheMarkers(
  wire: readonly WireMessage[],
  opts: { style: "anthropic" | "native"; ttl: CacheTtl; maxBreakpoints?: number },
): PreparedOpenAiMessages {
  return renderPlannedOpenAiMarkers(wire, planOpenAiCacheBreakpoints(wire, opts), opts);
}
