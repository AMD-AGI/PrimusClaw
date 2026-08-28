// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { db } from "../infra/db.js";
import type { Message } from "@claw/protocol";

import { getMemoryEntries, getProfileEntry } from "../memory/service.js";
import { CLAW_MEMORY_ENABLED } from "../config.js";
import pino from "pino";
import { estimateTokens } from "../shared/tokens.js";

const logger = pino({ name: "context-builder" });

const CONTEXT_WINDOW_TOKENS = 200_000;
const CONTEXT_OUTPUT_HEADROOM_TOKENS = 16_000;
const CONTEXT_TOOL_SCHEMA_TOKENS = 10_000;
const CONTEXT_AVAILABLE_TOKENS =
  CONTEXT_WINDOW_TOKENS - CONTEXT_OUTPUT_HEADROOM_TOKENS - CONTEXT_TOOL_SCHEMA_TOKENS;

function isMissingRelationError(err: any): boolean {
  const code = err?.code || "";
  return code === "42P01" /* undefined_table */ || code === "42703" /* undefined_column */;
}

/** Pure reconstruction of Claude-protocol message blocks from stored turns.
 *
 * Input is the raw rows of `claw_conversation_turns` for one session, ordered
 * by `turn_index DESC` (newest first). events/consumer.ts stores assistant
 * turns with `tool_calls` (the model's tool_use blocks) and `tool_results`
 * (the matching tool_result payloads) as JSONB. Without this reconstruction,
 * replaying history would feed the LLM bare assistant text with no preceding
 * tool_use ↔ tool_result pairing, producing incoherent (or 400-rejecting)
 * follow-up turns.
 *
 * Output shape per turn (assistant turn with N tools), in chronological order:
 *   { role: "assistant", content: [ {type:"text", text:...}, ...tool_use ] }
 *   { role: "user",      content: [ ...tool_result ] }
 *
 * Plain user turns and assistant turns without tools are returned as-is.
 *
 * Pulled out as a pure function so it is unit-testable without a database.
 */
export function reconstructHistory(
  turns: Array<{
    role: string;
    content: string;
    tool_calls?: unknown;
    tool_results?: unknown;
    token_count?: number;
  }>,
  maxTokens: number,
): Message[] {
  const selected: Message[] = [];
  let total = 0;
  for (const turn of turns) {
    const tokens = turn.token_count || estimateTokens(turn.content);
    if (total + tokens > maxTokens) break;

    const toolCalls = parseJsonbArray(turn.tool_calls);
    const toolResults = parseJsonbArray(turn.tool_results);

    if (turn.role === "assistant" && (toolCalls.length || toolResults.length)) {
      // Assistant block: text + tool_use entries.
      const assistantContent: Array<Record<string, unknown>> = [];
      if (turn.content) assistantContent.push({ type: "text", text: turn.content });
      for (const tc of toolCalls) {
        // Stored shape from agent-loop is {type:"toolUsed", tool, actionId, status, ...}.
        // Reconstruct as {type:"tool_use", id, name, input}.
        const id = (tc as any).actionId ?? (tc as any).id;
        const name = (tc as any).tool ?? (tc as any).name;
        const input = (tc as any).argumentsDetail?.[name] ?? (tc as any).input ?? {};
        if (id && name) assistantContent.push({ type: "tool_use", id, name, input });
      }

      // Build the matching user `tool_result` block.
      const resultBlocks: Array<Record<string, unknown>> = [];
      for (const tc of toolCalls) {
        const id = (tc as any).actionId ?? (tc as any).id;
        if (!id) continue;
        const matching = toolResults.find((r: any) => (r.actionId ?? r.id) === id);
        const text = matching ? (matching as any).description ?? (matching as any).content ?? "" : "";
        resultBlocks.push({ type: "tool_result", tool_use_id: id, content: String(text) });
      }

      // The outer loop walks turns DESC and we `reverse()` at the end. To
      // make the final order [..., assistant_with_tool_use, user_tool_result, ...]
      // (Anthropic requires every tool_result to immediately follow its
      // matching tool_use), push the within-turn pair in REVERSE here:
      // user_tool_result first, assistant block second.
      if (resultBlocks.length) selected.push({ role: "user", content: resultBlocks as any });
      selected.push({ role: "assistant", content: assistantContent as any });
    } else {
      selected.push({ role: turn.role as Message["role"], content: turn.content });
    }
    total += tokens;
  }
  return selected.reverse();
}

function selectHistoryTokens(
  turns: Array<{ content: string; token_count?: number }>,
  maxTokens: number,
): { selectedTokens: number; selectedTurns: number; totalTurns: number; omittedTurns: number } {
  let total = 0;
  let selectedTurns = 0;
  for (const turn of turns) {
    const tokens = turn.token_count || estimateTokens(turn.content);
    if (total + tokens > maxTokens) break;
    total += tokens;
    selectedTurns++;
  }
  return {
    selectedTokens: total,
    selectedTurns,
    totalTurns: turns.length,
    omittedTurns: Math.max(turns.length - selectedTurns, 0),
  };
}

/** Build history from conversation turns (sliding window, newest first until budget). */
export async function buildHistory(sessionId: string, maxTokens = 100_000): Promise<Message[]> {
  const turns = (await db.query(
    "SELECT role, content, tool_calls, tool_results, token_count FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL ORDER BY turn_index DESC",
    [sessionId],
  )).rows;
  return reconstructHistory(turns, maxTokens);
}

/** Tolerant JSONB → array parser. Accepts already-parsed arrays, JSON strings,
 *  or null/undefined; never throws. */
function parseJsonbArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.length) {
    try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
  }
  return [];
}

const MEMORY_BUDGET = 3_000;

async function buildSystemContextParts(
  sessionId: string,
  userId: string,
  rulesText = "",
  systemAppend = "",
  recordMemoryAccess = true,
): Promise<{
  parts: string[];
  profileTokens: number;
  memoryTokens: number;
  summaryTokens: number;
  rulesTokens: number;
}> {
  const parts: string[] = [];
  let profileTokens = 0;
  let memoryTokens = 0;
  let summaryTokens = 0;
  let rulesTokens = 0;

  // Long-term memory injection (profile + entries) is gated by CLAW_MEMORY_ENABLED.
  // When OFF: skip both DB queries and emit nothing — system prompt drops these sections.
  if (CLAW_MEMORY_ENABLED) {
    // 1. User profile
    try {
      const profileContent = await getProfileEntry(userId);
      if (profileContent) {
        const block = `## User Profile\n${profileContent}`;
        parts.push(block);
        profileTokens = estimateTokens(block);
      }
    } catch (err: any) {
      if (!isMissingRelationError(err)) {
        logger.error({ err, userId }, "memory.profile_query_failed");
      }
    }

    // 2. Long-term memory (top-K by importance, excluding user_profile)
    try {
      const memories = (await getMemoryEntries(userId, 30))
        .filter((m: any) => m.category !== "user_profile");

      if (memories.length) {
        const selected: any[] = [];
        let accumulated = 0;
        for (const m of memories) {
          const line = `- [${m.category}] ${m.content}`;
          const lineTokens = estimateTokens(line);
          if (accumulated + lineTokens > MEMORY_BUDGET) break;
          selected.push(m);
          accumulated += lineTokens;
        }

        if (selected.length) {
          const memoryBlock = selected.map((m: any) => `- [${m.category}] ${m.content}`).join("\n");
          const block = `## Long-term Memory\n${memoryBlock}`;
          parts.push(block);
          memoryTokens = estimateTokens(block);
          logger.info({
            userId, injected: selected.length, total: memories.length,
            categories: selected.map((m: any) => m.category),
            truncated: selected.length < memories.length,
          }, "memory.injected");
          // access_count update: best-effort on local PG, skipped for remote
          const ids = selected.map((m: any) => m.id).filter((id: any) => typeof id === "number");
          if (recordMemoryAccess && ids.length) {
            db.query(
              "UPDATE claw_memory_entries SET access_count = access_count + 1, last_accessed = NOW() WHERE id = ANY($1)",
              [ids]
            ).catch((err) => logger.warn({ err, userId }, "memory.access_update_failed"));
          }
        }
      }
    } catch (err: any) {
      if (!isMissingRelationError(err)) {
        logger.error({ err, userId }, "memory.query_failed");
      }
    }
  }

  // 3. Session summary
  const summaryRow = (await db.query(
    "SELECT summary FROM claw_session_summaries WHERE session_id = $1 AND deleted_at IS NULL", [sessionId],
  )).rows[0];
  if (summaryRow?.summary) {
    const block = `## Session Summary\nEarlier in this session:\n${summaryRow.summary}`;
    parts.push(block);
    summaryTokens = estimateTokens(block);
  }

  // 4. Rules / System Append
  const rulesParts = [rulesText, systemAppend].filter(Boolean);
  if (rulesParts.length) {
    const block = rulesParts.join("\n\n");
    parts.push(block);
    rulesTokens = estimateTokens(block);
  }

  return { parts, profileTokens, memoryTokens, summaryTokens, rulesTokens };
}

function extractUserMessageText(event: any): string {
  const blocks = event?.data?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

export interface ContextUsageBreakdown {
  system_prompt: number;
  tools: number;
  rules: number;
  skills: number;
  mcp: number;
  subagents: number;
  summarized_conversation: number;
  conversation: number;
  current_prompt: number;
}

export interface ContextUsageSnapshot {
  session_id: string;
  context_window_tokens: number;
  available_input_tokens: number;
  reserved_output_tokens: number;
  used_tokens: number;
  remaining_tokens: number;
  usage_percent: number;
  estimated: boolean;
  selected_turns: number;
  total_turns: number;
  omitted_turns: number;
  updated_at: string;
  breakdown: ContextUsageBreakdown;
}

/**
 * Read-only context usage snapshot for frontend display.
 *
 * This mirrors the current API-side context budget used by buildMessages().
 * Tool/schema and future skill/MCP prompt costs are represented as estimates
 * because they are finalized in Brain per task after plugin/skill resolution.
 */
export async function getContextUsageSnapshot(
  sessionId: string,
  userId = "default",
  rulesText = "",
  systemAppend = "",
): Promise<ContextUsageSnapshot> {
  const system = await buildSystemContextParts(sessionId, userId, rulesText, systemAppend, false);

  const lastCompleteRow = (await db.query(
    "SELECT COALESCE(MAX(id), 0) AS id FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND event = 'exec_complete'",
    [sessionId],
  )).rows[0];
  const lastCompleteId = Number(lastCompleteRow?.id || 0);

  const activeUserEvents = (await db.query(
    "SELECT data FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND event = 'UserMessage' AND id > $2 ORDER BY id",
    [sessionId, lastCompleteId],
  )).rows;
  const currentPromptTokens = activeUserEvents.reduce(
    (sum: number, row: any) => sum + estimateTokens(extractUserMessageText(row.data)),
    0,
  );

  const fixedTokens =
    estimateTokens(system.parts.join("\n\n"))
    + currentPromptTokens;
  const historyBudget = Math.max(CONTEXT_AVAILABLE_TOKENS - fixedTokens, 10_000);
  const turns = (await db.query(
    "SELECT content, token_count FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL ORDER BY turn_index DESC",
    [sessionId],
  )).rows;
  const history = selectHistoryTokens(turns, historyBudget);

  const breakdown: ContextUsageBreakdown = {
    system_prompt: system.profileTokens + system.memoryTokens,
    tools: CONTEXT_TOOL_SCHEMA_TOKENS,
    rules: system.rulesTokens,
    skills: 0,
    mcp: 0,
    subagents: 0,
    summarized_conversation: system.summaryTokens,
    conversation: history.selectedTokens,
    current_prompt: currentPromptTokens,
  };
  const usedTokens = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const remainingTokens = Math.max(CONTEXT_WINDOW_TOKENS - usedTokens, 0);

  return {
    session_id: sessionId,
    context_window_tokens: CONTEXT_WINDOW_TOKENS,
    available_input_tokens: CONTEXT_AVAILABLE_TOKENS,
    reserved_output_tokens: CONTEXT_OUTPUT_HEADROOM_TOKENS,
    used_tokens: usedTokens,
    remaining_tokens: remainingTokens,
    usage_percent: Math.min(100, Math.round((usedTokens / CONTEXT_WINDOW_TOKENS) * 1000) / 10),
    estimated: true,
    selected_turns: history.selectedTurns,
    total_turns: history.totalTurns,
    omitted_turns: history.omittedTurns,
    updated_at: new Date().toISOString(),
    breakdown,
  };
}

/** Build full messages array: system(profile+memory+summary+rules) + history + user(prompt). */
export async function buildMessages(
  sessionId: string,
  prompt: string,
  userId = "default",
  rulesText = "",
  systemAppend = "",
): Promise<Message[]> {
  const messages: Message[] = [];
  const system = await buildSystemContextParts(sessionId, userId, rulesText, systemAppend);
  const systemParts = system.parts;

  const fixedTokens = estimateTokens(systemParts.join("\n\n")) + estimateTokens(prompt);
  const remaining = CONTEXT_AVAILABLE_TOKENS - fixedTokens;

  if (systemParts.length) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  // History (sliding window)
  const history = await buildHistory(sessionId, Math.max(remaining, 10_000));
  messages.push(...history);

  // New user prompt
  messages.push({ role: "user", content: prompt });
  return messages;
}
