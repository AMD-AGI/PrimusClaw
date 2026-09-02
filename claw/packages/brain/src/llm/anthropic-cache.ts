// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Message } from "@claw/protocol";
import { isMarkableBlock, planCacheBreakpoints, type CachePlan, type CacheTtl } from "./cache-plan.js";

/**
 * Render a cache plan into the shape the Anthropic Messages API wants.
 *
 * Two jobs, both of which have to happen here rather than upstream:
 *
 *  1. Attach `cache_control` to the planned blocks, copying only the path it
 *     touches. The array handed in is frequently `AgentLoop.workingMessages`
 *     itself and that array is checkpointed by reference, so a marker written
 *     in place is persisted, restored on resume, and re-sent every turn after
 *     -- until the request carries more than four markers and the API rejects
 *     it. That failure appears only after a resume, on a conversation long
 *     enough to have accumulated five, which is to say never in a unit test
 *     and never in a short staging run.
 *
 *  2. Lift a leading `role:"system"` run out of `messages` into the top-level
 *     `system` parameter. The Messages API has no "system" role; the gateway
 *     has been rewriting it for us, and two comments elsewhere in this repo
 *     already record that the API rejects it. Hoisting it ourselves is what
 *     makes the tools+system prefix addressable at all -- the render order is
 *     tools -> system -> messages, so a marker on the last system block caches
 *     the tool definitions with it.
 *
 * On the task-dispatch path there is no system message: `engine.ts` builds one
 * only from rules / rules_text / system_append, all empty by default. There the
 * anchor lands on `messages[0]`, whose content is a bare string, which is why
 * the widening below is not an edge case.
 */

/** `{type:"ephemeral"}` is Anthropic's 5-minute default; "1h" adds the `ttl` field. */
function cacheControlFor(ttl: CacheTtl): Record<string, unknown> {
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

export interface PreparedAnthropicRequest {
  /** Present only when the input carried a leading `role:"system"` run. */
  system?: Array<Record<string, unknown>>;
  messages: Message[];
  /**
   * Markers counted off the rendered structure, not off the plan.
   *
   * A plan/render divergence is the most likely way this quietly reverts to
   * sending nothing, and counting the plan would report success either way.
   */
  breakpointsApplied: number;
  /**
   * Where those markers landed, as ordinals in a flat walk over every block
   * the request actually carries (hoisted system run first, then messages).
   *
   * A count answers "did we send markers"; only the positions answer "could
   * they have worked". The chain breaks when the distance between two
   * consecutive markers exceeds the provider's lookback -- one turn that
   * appends many blocks at once is enough -- and that failure is invisible in
   * the count, which stays at its healthy maximum throughout.
   *
   * Same rule as the count: read off the rendered structure, never off the
   * plan, so a marker the renderer refused is absent here too.
   */
  markerBlockOffsets: number[];
  /** Total blocks in that same flat walk, so the tail gap is computable. */
  totalBlocks: number;
}

/** Widen a message's content to a block array without touching the original. */
function contentBlocks(content: Message["content"]): Array<Record<string, unknown>> {
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: content }];
}

function isMarked(b: unknown): boolean {
  return !!b && typeof b === "object" && "cache_control" in (b as Record<string, unknown>);
}

/** Append `blocks` to the flat walk, recording the ordinal of each marked one. */
function tallyMarkers(
  blocks: ReadonlyArray<Record<string, unknown>>,
  out: { markerBlockOffsets: number[]; totalBlocks: number },
): void {
  for (const b of blocks) {
    if (isMarked(b)) out.markerBlockOffsets.push(out.totalBlocks);
    out.totalBlocks++;
  }
}

/**
 * Attach the plan's markers and hoist the system run.
 *
 * Split from planning so the two can disagree in a test. They cannot disagree
 * on any input the planner produces today -- it only ever selects blocks this
 * function accepts -- but "the renderer silently dropped a planned marker" is
 * exactly the regression `breakpointsApplied` exists to make visible, and a
 * counter whose failure mode is unreachable is a counter nobody can trust.
 * With the plan injectable, the refusal path and the count that reports it are
 * both exercised.
 */
export function renderCacheMarkers(
  messages: readonly Message[],
  plan: CachePlan,
): PreparedAnthropicRequest {
  // messageIndex -> block indices to mark. Built from the plan, which addresses
  // the array as handed in, so markers are applied BEFORE the system run is
  // split off and the indices shift.
  const marks = new Map<number, Set<number>>();
  for (const bp of plan.breakpoints) {
    let set = marks.get(bp.messageIndex);
    if (!set) marks.set(bp.messageIndex, (set = new Set()));
    set.add(bp.blockIndex);
  }

  const cacheControl = cacheControlFor(plan.ttl);
  const rendered: Message[] = messages.map((message, i) => {
    const wanted = marks.get(i);
    if (!wanted || wanted.size === 0) return message; // untouched: same object
    const source = contentBlocks(message.content);
    const blocks = source.map((block, b) => {
      if (!wanted.has(b)) return block; // untouched: same object
      if (!isMarkableBlock(block)) return block;
      return { ...block, cache_control: { ...cacheControl } };
    });
    return { ...message, content: blocks };
  });

  // Counted off the rendered structure, never off the plan: a marker the
  // planner asked for and the renderer refused must show up as a shortfall.
  const out: PreparedAnthropicRequest = {
    messages: rendered, breakpointsApplied: 0, markerBlockOffsets: [], totalBlocks: 0,
  };

  if (plan.systemRunLength > 0) {
    const systemBlocks: Array<Record<string, unknown>> = [];
    for (let i = 0; i < plan.systemRunLength; i++) {
      systemBlocks.push(...contentBlocks(rendered[i].content));
    }
    out.system = systemBlocks;
    out.messages = rendered.slice(plan.systemRunLength);
    tallyMarkers(systemBlocks, out);
  }

  // A string-content message is one block and cannot carry a marker, but it
  // still occupies a slot in the walk -- skipping it would shorten every gap
  // measured past it.
  for (const m of out.messages) tallyMarkers(contentBlocks(m.content), out);

  out.breakpointsApplied = out.markerBlockOffsets.length;
  return out;
}

/**
 * Strip every `cache_control` marker from a rendered request.
 *
 * The undecorated retry the provider falls back to when the gateway rejects a
 * marker. Rebuilding from the original messages would be equivalent but would
 * also re-run the planner, and the point of the fallback is to change exactly
 * one thing.
 */
export function stripCacheControl(prepared: PreparedAnthropicRequest): PreparedAnthropicRequest {
  const clean = (blocks: Array<Record<string, unknown>>) =>
    blocks.map((b) => {
      if (!b || typeof b !== "object" || !("cache_control" in b)) return b;
      const { cache_control: _dropped, ...rest } = b;
      return rest;
    });
  return {
    system: prepared.system ? clean(prepared.system) : undefined,
    messages: prepared.messages.map((m) =>
      Array.isArray(m.content) ? { ...m, content: clean(m.content) } : m,
    ),
    breakpointsApplied: 0,
    markerBlockOffsets: [],
    totalBlocks: prepared.totalBlocks,
  };
}

export function prepareAnthropicRequest(
  messages: readonly Message[],
  opts: { ttl: CacheTtl; maxBreakpoints?: number },
): PreparedAnthropicRequest {
  return renderCacheMarkers(messages, planCacheBreakpoints(messages, opts));
}
