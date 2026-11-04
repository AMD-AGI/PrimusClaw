// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The parts of the review-tools evaluation (`assistant-review-eval.ts`) that are not the model call: what the Router is
 * given, a stand-in for its tools, the loop, and the scoring. Tested offline (`assistant-review-eval.test.ts`).
 *
 * What the Router is given is imported, not restated: `renderRouterSystem` and `renderReviewContext` joined as the role
 * profile joins them, the tool definitions the MCP server lists with the review tools on, and the user's turn as the
 * Router evaluation builds it. The stand-in refuses what the real tools refuse with the same checks
 * (`review-tools.ts`'s grounding), and stands in for the review service (C1) only in what it answers: a repository that
 * does not exist and a person who lets nobody act for them are refused there.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CLAW_ASSISTANT_ROUTER_MAX_TURNS } from "../../src/config.js";
import { parseItemRef } from "../../src/assistant/item-ref.js";
import { createAssistantMcpServer } from "../../src/assistant/mcp.js";
import { renderReviewContext, renderRouterSystem, WORK_EVENT_PREFIX } from "../../src/assistant/prompts.js";
import { mentionsNumber, modelGrounded, parsePrs, prGrounded, repoGrounded } from "../../src/assistant/review-tools.js";
import { ASSISTANT_MCP_SERVER } from "../../src/assistant/role-profile.js";
import type { Block, Llm, Message, ModelResponse, ToolSchema } from "./assistant-router-eval-lib.js";
import { promptFor, userTurn } from "./assistant-router-eval-lib.js";
import type { ExpectedCall, ReviewEvalCase } from "./assistant-review-eval-cases.js";

export const SELF = "eval-user";
const KNOWN_REPOS = new Set(["amd-agi/primusclaw", "amd-agi/primus-turbo"]);
const ACTING = new Set(["review_start", "review_restart", "confirmation_answer", "review_mode_set", "channel_action"]);
const WRITES = new Set([...ACTING, "work_stop", "work_create", "work_send"]);

/** The router's tools with the review tools on, as Brain offers them: `mcp__<server>__<tool>`, sorted by name. */
export async function reviewRouterTools(): Promise<ToolSchema[]> {
  const server = createAssistantMcpServer({ sid: "eval", mid: "eval", task_id: "eval", exp: 4102444800, role: "router" }, true);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "assistant-review-eval", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return (await client.listTools()).tools
      .map((t) => ({
        name: `mcp__${ASSISTANT_MCP_SERVER}__${t.name}`,
        description: t.description || t.name,
        input_schema: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
      }))
      .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  } finally {
    await client.close();
    await server.close();
  }
}

/** The system message of the case's turn, joined as `applySessionRoleToTask` joins its parts. */
export function systemFor(c: ReviewEvalCase): string {
  return `${renderRouterSystem(c.items ?? [])}\n\n${renderReviewContext({
    confirmations: (c.confirmations ?? []).map((x) => ({ ...x, expires_at: "2026-11-05T00:00:00.000Z" })),
    reviewMode: c.reviewMode ?? "high_risk_confirm",
    people: c.attended === false ? [] : c.people ?? [],
    actions: c.attended === false ? [] : c.actions ?? [],
    repos: c.attended === false ? [] : c.repos ?? [],
  })}`;
}

export interface Call { tool: string; input: Record<string, any>; refused: boolean; result: unknown; item?: number; confirmation?: number }

/** Answers the tools as the real ones would for this case. */
export function standIn(c: ReviewEvalCase) {
  const items = [...(c.items ?? [])];
  const refuse = (error: string, message = error) => ({ result: { ok: false, error, message }, refused: true });
  const ok = (result: Record<string, unknown> = {}) => ({ result: { ok: true, ...result }, refused: false });
  const seqOf = (ref: unknown): number | null => {
    const parsed = parseItemRef(typeof ref === "string" ? ref : String(ref ?? ""));
    if (!parsed.ok) return null;
    const named = parsed.ref;
    const item = named.by === "id" ? items.find((i) => i.itemId === named.itemId) : items.find((i) => i.seq === named.seq);
    return item?.seq ?? null;
  };
  return (tool: string, input: Record<string, any>): Omit<Call, "tool" | "input"> => {
    if (ACTING.has(tool) && c.attended === false) return refuse("not_attended");
    const text = c.text;
    switch (tool) {
      case "say": case "work_recall": return ok();
      case "work_create": return ok({ item_id: "kwi_evalnew", seq: 99 });
      case "work_send": {
        const seq = seqOf(input.item_id);
        if (seq === null) return refuse("item_not_found");
        if (items.find((i) => i.seq === seq)?.review) return { ...refuse("review_item"), item: seq };
        return { ...ok(), item: seq };
      }
      case "work_stop": {
        const seq = seqOf(input.item_id);
        if (seq !== null && c.attended === false && items.find((i) => i.seq === seq)?.review) return refuse("not_attended");
        return seq === null ? refuse("item_not_found") : { ...ok({ outcome: "stopped" }), item: seq };
      }
      case "review_start": {
        let prs;
        try { prs = parsePrs(input.prs); } catch (err) { return refuse((err as { code: string }).code); }
        if (typeof input.merge !== "boolean") return refuse("invalid_arguments");
        for (const pr of prs) {
          if (!prGrounded(text, pr)) return refuse("pr_not_in_message");
          if (!repoGrounded(text, pr, c.repos ?? [], [])) return refuse("repo_not_grounded");
          if (!KNOWN_REPOS.has(`${pr.owner}/${pr.repo}`.toLowerCase())) return refuse("pr_check_failed", "github_not_found: no such repository");
        }
        if (input.model && !modelGrounded(text, input.model)) return refuse("model_not_in_message");
        if (input.reviewer && input.reviewer !== SELF) {
          const person = (c.people ?? []).find((p) => p.user_id === input.reviewer);
          if (!person) return refuse("reviewer_not_in_message");
          if (c.noConsent?.includes(input.reviewer)) return refuse("pr_check_failed", "delegation_off: that person does not let others act for them");
        }
        return ok({ items: prs.map((p, i) => ({ item_id: `kwi_evalr${i}`, seq: 50 + i, pr: p })) });
      }
      case "review_restart": {
        const seq = seqOf(input.item_id);
        const item = items.find((i) => i.seq === seq);
        if (!item) return refuse("item_not_found");
        if (!item.review) return refuse("not_a_review_item");
        const n = Number(item.review.pr.split("#")[1]);
        const reviews = items.filter((i) => i.review);
        if (!mentionsNumber(text, n) && !text.includes(`#${item.seq}`) && reviews.length !== 1) return { ...refuse("item_not_in_message"), item: seq ?? undefined };
        if (input.model && !modelGrounded(text, input.model)) return { ...refuse("model_not_in_message"), item: item.seq };
        return { ...ok({ item: { item_id: "kwi_evalnew", seq: 60 } }), item: item.seq };
      }
      case "confirmation_answer": {
        const pending = c.confirmations ?? [];
        if (!pending.length) return refuse("no_pending_confirmation");
        let pick = input.confirmation_id ? pending.find((x) => x.id === input.confirmation_id) : undefined;
        if (!input.confirmation_id && input.pr) {
          const n = Number(String(input.pr).split("#").pop());
          pick = pending.find((x) => x.pr === n);
        }
        if (!input.confirmation_id && !input.pr) pick = pending.length === 1 ? pending[0] : undefined;
        if (!pick) return refuse("confirmation_not_found");
        if (input.decision === "allow" && !mentionsNumber(text, pick.pr) && pending.length !== 1) return refuse("pr_not_in_message");
        return { ...ok({ status: input.decision === "allow" ? "merged" : "denied" }), confirmation: pick.pr };
      }
      case "review_mode_set":
        return input.mode === "high_risk_confirm" ? ok({ review_mode: "high_risk_confirm" }) : refuse(input.mode === "fully_auto" ? "needs_the_person" : "invalid_arguments");
      case "channel_action": {
        const name = String(input.name ?? "").replace(/^\/+/, "");
        return (c.actions ?? []).some((a) => a.name === name) ? ok({ event_id: "e1" }) : refuse("action_not_offered");
      }
      default:
        return refuse("unknown_tool");
    }
  };
}

export interface ReviewTrace { calls: Call[]; turns: number; error?: string; said: string[] }

/** Runs the Router on one case until it stops calling tools or the turn budget is spent. */
export async function runReviewCase(c: ReviewEvalCase, llm: Llm, tools: ToolSchema[], maxTurns = CLAW_ASSISTANT_ROUTER_MAX_TURNS): Promise<ReviewTrace> {
  const answer = standIn(c);
  const prompt = c.text.startsWith(WORK_EVENT_PREFIX) ? c.text : await promptFor({ text: c.text });
  const messages: Message[] = [{ role: "user", content: userTurn(prompt) }];
  const trace: ReviewTrace = { calls: [], turns: 0, said: [] };
  const prefix = `mcp__${ASSISTANT_MCP_SERVER}__`;
  const system = systemFor(c);
  for (let turn = 1; turn <= maxTurns; turn++) {
    let reply: ModelResponse;
    try { reply = await llm({ system, messages, tools }); } catch (err) {
      trace.error = err instanceof Error ? err.message : String(err);
      return trace;
    }
    trace.turns = turn;
    const uses = reply.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
    if (!uses.length) return trace;
    messages.push({ role: "assistant", content: reply.content });
    const results: Block[] = [];
    for (const use of uses) {
      const short = use.name.startsWith(prefix) ? use.name.slice(prefix.length) : use.name;
      const out = answer(short, (use.input ?? {}) as Record<string, any>);
      trace.calls.push({ tool: short, input: (use.input ?? {}) as Record<string, any>, ...out });
      if (short === "say" && !out.refused) trace.said.push(String((use.input as { text?: unknown }).text ?? ""));
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out.result), ...(out.refused ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return trace;
}

const prsOf = (input: Record<string, any>): string[] => {
  try { return parsePrs(input.prs).map((p) => `${p.owner}/${p.repo}#${p.number}`.toLowerCase()).sort(); } catch { return []; }
};

/** Whether one call that went through is the one expected, argument by argument. */
export function matches(call: Call, e: ExpectedCall): boolean {
  if (call.tool !== e.tool) return false;
  const a = e.args;
  for (const [k, v] of Object.entries(a)) {
    if (k === "prs") { if (JSON.stringify(prsOf(call.input)) !== JSON.stringify((v as string[]).map((s) => s.toLowerCase()).sort())) return false; continue; }
    if (k === "item") { if (call.item !== v) return false; continue; }
    if (k === "confirmation") { if (call.confirmation !== v) return false; continue; }
    if (k === "model") { if (typeof call.input.model !== "string" || !call.input.model.toLowerCase().includes(String(v))) return false; continue; }
    if (k === "reviewer") { const r = call.input.reviewer; if (v === null ? r !== undefined && r !== SELF : r !== v) return false; continue; }
    if (k === "args") { if (String(call.input.args ?? "").trim() !== v) return false; continue; }
    if (k === "name") { if (String(call.input.name ?? "").replace(/^\/+/, "") !== v) return false; continue; }
    if (call.input[k] !== v) return false;
  }
  // What the user did not ask for must not be asked of the tool either.
  if (e.tool === "review_start" || e.tool === "review_restart") {
    if (!("model" in a) && call.input.model !== undefined) return false;
    if (e.tool === "review_start" && !("reviewer" in a) && call.input.reviewer !== undefined && call.input.reviewer !== SELF) return false;
    if (e.tool === "review_restart" && !("merge" in a) && call.input.merge !== undefined) return false;
  }
  return true;
}

/** The writes that went through equal one of the accepted sets exactly: the same calls, no more. */
export function scoreReviewCase(c: ReviewEvalCase, t: ReviewTrace): { ok: boolean; writes: Call[] } {
  const writes = t.calls.filter((x) => WRITES.has(x.tool) && !x.refused);
  if (t.error) return { ok: false, writes };
  const ok = [c.expect, ...(c.also ?? [])].some((want) => {
    if (want.length !== writes.length) return false;
    const left = [...writes];
    return want.every((e) => {
      const i = left.findIndex((w) => matches(w, e));
      if (i < 0) return false;
      left.splice(i, 1);
      return true;
    });
  });
  return { ok, writes };
}
