// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Message } from "@claw/protocol";

/**
 * Where prompt-cache breakpoints go, decided once and rendered per provider.
 *
 * This module is deliberately provider-neutral and side-effect free: it reads a
 * canonical `Message[]` and returns positions. The Anthropic renderer turns
 * those into `cache_control` markers; a future OpenAI renderer would turn the
 * same plan into whatever that wire format wants. Keeping the policy in one
 * place is what makes it testable -- the alternative, deciding placement inside
 * each provider, is how the two drift.
 *
 * Nothing here mutates its input. The array handed to us is frequently
 * `AgentLoop.workingMessages` itself (filterResumeNotices returns it by
 * reference when there are few enough notices), and that array is serialized
 * verbatim into the task checkpoint. A marker written into it would be
 * persisted, restored on resume, and re-sent on every later turn until the
 * request exceeds the four-breakpoint cap and the API rejects it -- a failure
 * that appears only after a resume, on a conversation long enough to have
 * accumulated five marks.
 */

/** Cache lifetime for a breakpoint. "5m" is Anthropic's default (no `ttl` field). */
export type CacheTtl = "5m" | "1h";

/**
 * Content-block types Anthropic accepts a `cache_control` marker on.
 *
 * An allowlist, not a denylist of `thinking` / `redacted_thinking`. A marker on
 * an ineligible block is an unconditional 400, so a block type we have not seen
 * before must default to "do not mark" rather than "mark and hope". This is not
 * hypothetical: claude-sonnet-5 runs adaptive thinking by default and supports
 * interleaved thinking, so a thinking block can be the *last* block of an
 * assistant message even though the code never asks for thinking.
 */
const MARKABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "tool_use",
  "tool_result",
  "image",
  "document",
]);

/** Anthropic's hard limit on `cache_control` markers per request. */
export const MAX_BREAKPOINTS = 4;

/**
 * Maximum distance in content blocks between two consecutive markers.
 *
 * A breakpoint searches backwards at most 20 blocks for an existing cache
 * entry, so markers further apart than that stop chaining and the request
 * silently rewrites the prefix it meant to read. 18 leaves margin.
 *
 * The budget is in BLOCKS, not messages, and the difference is load-bearing: a
 * single user message carries one `tool_result` per tool call in the batch, so
 * "mark every message boundary" can put two markers 25 blocks apart while
 * looking correct.
 *
 * It bounds the STEP the walk takes back, not the resulting distance. When
 * every block inside the window is ineligible -- a run of thinking blocks --
 * the mark lands further back than this, and no placement can do better,
 * because there is nowhere legal to mark in between. The real API window is
 * 20, so a run of up to two is absorbed by the margin; a longer one costs one
 * full-price request and then self-heals.
 */
export const MAX_STRIDE_BLOCKS = 18;

/**
 * Rolling markers, walking back from the tail.
 *
 * Three, not two: the anchor plus MAX_BREAKPOINTS already caps the total at
 * four, so a smaller number just forfeits a slot. Measured on a turn that
 * appends 51 blocks (25 parallel tool calls), two rolling markers leave a
 * 32-block gap between the anchor and the next mark -- past the lookback, so
 * the chain breaks and the history is recomputed, which is the exact cost this
 * module exists to avoid.
 */
const ROLLING_TARGET = 3;

export interface CacheBreakpoint {
  /** Index into the leading `role:"system"` run, or into `messages`. */
  kind: "system" | "message";
  messageIndex: number;
  /**
   * Index of the content block within that message. A message whose `content`
   * is a bare string has exactly one block, at index 0.
   */
  blockIndex: number;
  /**
   * The message's `content` is a string and the renderer must widen it to
   * `[{type:"text", text}]` before attaching the marker. A string cannot carry
   * `cache_control`, and indexing into one yields a character.
   */
  wrapStringContent: boolean;
}

export interface CachePlan {
  /** Ordered from the front of the prompt to the back. Never longer than MAX_BREAKPOINTS. */
  breakpoints: CacheBreakpoint[];
  ttl: CacheTtl;
  /**
   * Length of the leading `role:"system"` run the renderer must hoist into the
   * top-level `system` parameter. Zero on the task-dispatch path, which builds
   * no system message at all.
   */
  systemRunLength: number;
}

/** One content block's address, in a flattened walk over the whole array. */
interface FlatPosition {
  messageIndex: number;
  blockIndex: number;
  markable: boolean;
  wrapStringContent: boolean;
}

function blocksOf(message: Message): Array<Record<string, unknown>> | null {
  return Array.isArray(message.content) ? message.content : null;
}

/**
 * Exported so the renderer can re-check independently. The planner deciding
 * correctly is not a guarantee the renderer receives a plan the planner made:
 * a marker on an ineligible block is a hard 400 on every request, so both
 * sides check rather than one trusting the other.
 */
export function isMarkableBlock(block: unknown): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  const type = (block as Record<string, unknown>).type;
  return typeof type === "string" && MARKABLE_BLOCK_TYPES.has(type);
}

/**
 * Flatten to one entry per content block, in prompt order.
 *
 * A string `content` counts as exactly one markable block: the renderer widens
 * it, so it can carry a marker, and counting it as one keeps the stride budget
 * honest. A message with an empty block array contributes nothing.
 */
function flatten(messages: readonly Message[]): FlatPosition[] {
  const out: FlatPosition[] = [];
  for (let m = 0; m < messages.length; m++) {
    const message = messages[m];
    const blocks = blocksOf(message);
    if (blocks === null) {
      if (typeof message.content === "string" && message.content.length > 0) {
        out.push({ messageIndex: m, blockIndex: 0, markable: true, wrapStringContent: true });
      }
      continue;
    }
    for (let b = 0; b < blocks.length; b++) {
      out.push({
        messageIndex: m,
        blockIndex: b,
        markable: isMarkableBlock(blocks[b]),
        wrapStringContent: false,
      });
    }
  }
  return out;
}

/** Length of the leading run of `role:"system"` messages. */
export function leadingSystemRun(messages: readonly Message[]): number {
  let n = 0;
  while (n < messages.length && messages[n].role === "system") n++;
  return n;
}

/** Last markable position at or before `from`, or -1. */
function lastMarkableAtOrBefore(flat: readonly FlatPosition[], from: number): number {
  for (let i = Math.min(from, flat.length - 1); i >= 0; i--) {
    if (flat[i].markable) return i;
  }
  return -1;
}

/** Index in `flat` of the first block belonging to `messageIndex`, or -1. */
function firstBlockOfMessage(flat: readonly FlatPosition[], messageIndex: number): number {
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].messageIndex === messageIndex) return i;
  }
  return -1;
}

function toBreakpoint(p: FlatPosition, systemRunLength: number): CacheBreakpoint {
  return {
    kind: p.messageIndex < systemRunLength ? "system" : "message",
    messageIndex: p.messageIndex,
    blockIndex: p.blockIndex,
    wrapStringContent: p.wrapStringContent,
  };
}

/**
 * Decide where the `cache_control` markers go.
 *
 * Two kinds of marker, for two different jobs:
 *
 *  - One ANCHOR at the end of the stable prefix -- the last system block when a
 *    leading system run exists, otherwise the last markable block of
 *    `messages[0]`. It never moves for the life of a session, so every request
 *    reads it at the same offset. Tool definitions render before both, so the
 *    anchor caches them too and they need no marker of their own.
 *
 *  - Up to two ROLLING markers walking back from the tail, so the turn that was
 *    just appended becomes a read point for the next request.
 *
 * The result is deterministic: `streamTurnWithRetry` re-enters the provider up
 * to four times per turn, and a marker that moved between attempts would turn
 * each retry from a cache read into a paid cache write.
 */
export function planCacheBreakpoints(
  messages: readonly Message[],
  opts: { ttl: CacheTtl; maxBreakpoints?: number },
): CachePlan {
  const maxBreakpoints = opts.maxBreakpoints ?? MAX_BREAKPOINTS;
  const systemRunLength = leadingSystemRun(messages);
  const plan: CachePlan = { breakpoints: [], ttl: opts.ttl, systemRunLength };
  if (messages.length === 0 || maxBreakpoints <= 0) return plan;

  const flat = flatten(messages);
  if (flat.length === 0) return plan;

  // --- anchor -------------------------------------------------------------
  // The stable prefix ends with the system run when there is one, and with
  // messages[0] otherwise. Both are assembled once per run and never rewritten.
  const anchorScopeEnd = systemRunLength > 0
    ? firstBlockOfMessage(flat, systemRunLength) - 1  // last block before the first non-system message
    : firstBlockOfMessage(flat, 1) - 1;               // last block of messages[0]
  const anchorLimit = anchorScopeEnd >= 0 ? anchorScopeEnd : flat.length - 1;
  const anchor = lastMarkableAtOrBefore(flat, anchorLimit);

  const chosen: number[] = [];
  if (anchor >= 0) chosen.push(anchor);

  // --- rolling ------------------------------------------------------------
  // Walk backwards from the tail. A message boundary is the preferred landing
  // spot, but only a *preference*: inside the chosen message we still fall back
  // to the last markable block, and a message with no markable block at all is
  // skipped rather than marked. Those two rules disagree exactly when a message
  // ends in a thinking block, which is why the walk resolves within the message
  // instead of trusting the boundary.
  let cursor = flat.length - 1;
  let rolling = 0;
  while (
    rolling < ROLLING_TARGET
    && chosen.length < maxBreakpoints
    && cursor > anchor
  ) {
    const mark = lastMarkableAtOrBefore(flat, cursor);
    if (mark <= anchor) break;
    chosen.push(mark);
    rolling++;

    // Step back a full window. Landing on a message boundary is deliberately
    // NOT preferred: the walk already resolves to the last eligible block
    // inside whatever message it lands in, which is what handles a trailing
    // thinking block, so the preference bought nothing and cost reach -- on a
    // 40-block turn it put two markers one block apart and wasted a slot.
    //
    // Always strictly less than `cursor`, and `rolling++` bounds the loop
    // regardless, so no separate no-progress guard is needed -- and one that
    // cannot fire is one no test can hold in place.
    cursor = mark - MAX_STRIDE_BLOCKS;
  }

  chosen.sort((a, b) => a - b);
  // No trailing slice: the `chosen.length < maxBreakpoints` guard on the
  // rolling loop is what enforces the cap, and the anchor is a single entry
  // pushed before it. A second cap here would be unreachable, and an
  // unreachable guard is one no test can hold in place.
  plan.breakpoints = chosen.map((i) => toBreakpoint(flat[i], systemRunLength));
  return plan;
}
