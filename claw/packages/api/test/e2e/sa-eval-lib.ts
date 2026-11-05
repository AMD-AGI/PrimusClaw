// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The parts of the super-agent evaluation (`sa-eval.ts`) that are not calls to a deployment: the case format, how
 * cases are loaded, how what the assistant did for one case is read from the events it left, how the route (answered,
 * work item, review, confirmation) is told apart, and the deterministic checks a case is graded by. Kept apart so
 * they are tested offline (`test/sa-eval.test.ts`).
 *
 * A case is one JSON object per line of a `*.jsonl` file:
 *
 *   id               unique, <pipeline>-<area>-<kind>-<nnn>
 *   pipeline         real | catalog | public | sim | team | capture   (where the case came from)
 *   area             safe | dispatron | autopilot | pulse | agent-board | github | review | merge | memory | items | settings | chitchat | general
 *   lang             zh | en | mixed                                   (the user's language)
 *   turns            [{user, after_ms}]                                 one or more user messages; after_ms from the first
 *   route            answer | item | review | confirm | clarify         expected handling of the last turn
 *   tools_must       tool names the last turn must each call; `*` matches anything, `a|b` either
 *   tools_must_not   tool names the last turn must not call (read-only questions list work_create)
 *   facts            [{claim, oracle: {kind: static|api|fixture, value?, query?}}]; the final answer must name the value.
 *                    An `api` oracle is a Claw API GET run with the eval identity at run time, `<path>#<pick>`, e.g.
 *                    `/v1/work-items?state=in_progress#data.length` or `/v1/me#name`; a fact without a value or a
 *                    query (or with a query that is not of that form) is for the judge only.
 *   cards            none | accept | confirm                            what the user may be shown to press in the last turn
 *   style            {reply_lang: follow_user, max_chars, no_ids}
 *   latency_budget_s {first, final, each}                               seconds from the last turn's sending (each: per turn)
 *   source           {kind: real|synthetic|public, hash, ref}
 *   notes            why the case exists
 * and, for this runner only (all optional): `rubric` (what a judge model grades, `EVAL_JUDGE_*`), `modes` (the modes the
 * case runs in, default both), `needs` (an environment variable whose value fills `{NAME}` in the turns; skipped
 * without it), `item_wait_s` (how long to wait for an item's result), `items_closed` (every item the case started
 * is closed when it is graded: an interrupt that stopped it).
 *
 * route, tools, cards, the final answer and its latency are the LAST turn's: earlier turns are context and may start
 * items of their own. Leaks are looked for in everything the case showed, and `items_closed` covers every item.
 *
 * What a case is graded on is only what a user's channel sees or what the API records: the `AssistantSay` events of
 * the assistant's session (the messages the user would get, with the item and the confirmation they carry, which is
 * what a channel turns into a card), the tool calls of the Router's turns and of the workers of the items the case
 * started, the items on the board, and the time each message arrived here.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { percentile, traceOf, type EventRow, type ToolCall } from "./agent-eval-lib.js";

export type Route = "answer" | "item" | "review" | "confirm" | "clarify";
export type Mode = "assistant" | "baseline";
export type Cards = "none" | "accept" | "confirm";

export interface Turn { user: string; after_ms?: number }
export interface Oracle { kind: "static" | "api" | "fixture"; value?: string; query?: string }
export interface Fact { claim: string; oracle?: Oracle }

export interface EvalCase {
  id: string;
  pipeline: string;
  area: string;
  lang: "zh" | "en" | "mixed";
  turns: Turn[];
  route?: Route;
  tools_must?: string[];
  tools_must_not?: string[];
  facts?: Fact[];
  cards?: Cards;
  style?: { reply_lang?: "follow_user"; max_chars?: number; no_ids?: boolean };
  latency_budget_s?: { first?: number; final?: number; each?: number };
  source?: { kind: string; hash?: string; ref?: string };
  notes?: string;
  variant_of?: string;
  rubric?: string;
  modes?: Mode[];
  needs?: string;
  item_wait_s?: number;
  items_closed?: boolean;
}

// --- Loading ------------------------------------------------------------------------------------------------------

const ROUTES: readonly string[] = ["answer", "item", "review", "confirm", "clarify"];
const CARDS: readonly string[] = ["none", "accept", "confirm"];

/** What is wrong with a case, or [] when it can run. */
export function problemsOf(c: Partial<EvalCase>): string[] {
  const out: string[] = [];
  if (!c.id || typeof c.id !== "string") out.push("no id");
  if (!Array.isArray(c.turns) || !c.turns.length || c.turns.some((t) => typeof t?.user !== "string" || !t.user.trim())) out.push("no turns");
  else if (c.turns.slice(1).some((t) => !(Number(t.after_ms) > 0))) out.push("a later turn without after_ms");
  if (c.route !== undefined && !ROUTES.includes(c.route)) out.push(`route ${c.route}`);
  if (c.cards !== undefined && !CARDS.includes(c.cards)) out.push(`cards ${c.cards}`);
  return out;
}

/** Parse one `.jsonl` text: the cases, and the lines that are not one (with why). Blank lines and `//` lines are skipped. */
export function parseCases(text: string, file = ""): { cases: EvalCase[]; bad: string[] } {
  const cases: EvalCase[] = [];
  const bad: string[] = [];
  text.split("\n").forEach((line, n) => {
    if (!line.trim() || line.trim().startsWith("//")) return;
    try {
      const c = JSON.parse(line) as EvalCase;
      const why = problemsOf(c);
      if (why.length) bad.push(`${file}:${n + 1} ${c.id ?? "?"}: ${why.join(", ")}`);
      else cases.push(c);
    } catch (err) {
      bad.push(`${file}:${n + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { cases, bad };
}

/** Every case in the `*.jsonl` files under `dir`, with the subdirectory each came from (`real`, `catalog`, ...). */
export function loadCases(dir: string): { cases: Array<EvalCase & { dir: string }>; bad: string[] } {
  const cases: Array<EvalCase & { dir: string }> = [];
  const bad: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) {
        const got = parseCases(readFileSync(p, "utf8"), relative(dir, p));
        bad.push(...got.bad);
        const sub = relative(dir, d).split("/")[0] || "";
        cases.push(...got.cases.map((c) => ({ ...c, dir: sub })));
      }
    }
  };
  walk(dir);
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) bad.push(`duplicate id ${c.id}`);
    ids.add(c.id);
  }
  return { cases, bad };
}

/** Select by id, area or pipeline (any of them) and by subdirectory, and drop variants unless asked for. */
export function select<T extends EvalCase & { dir?: string }>(cases: readonly T[], only: ReadonlySet<string>, dirs: ReadonlySet<string>, variants: boolean): T[] {
  return cases.filter((c) => (!only.size || only.has(c.id) || only.has(c.area) || only.has(c.pipeline))
    && (!dirs.size || dirs.has(c.dir ?? c.pipeline)) && (variants || !c.variant_of));
}

/** The case's turns with `{NAME}` filled from `env`; null when the case needs a variable that is not set. */
export function turnsOf(c: EvalCase, env: Record<string, string | undefined>): Turn[] | null {
  if (c.needs && !env[c.needs]) return null;
  return c.turns.map((t) => ({ ...t, user: t.user.replace(/\{([A-Z_]+)\}/g, (all, name: string) => env[name] ?? all) }));
}

/** A short, stable hash of what the case says (for a case that does not carry one). */
export const caseHash = (c: Pick<EvalCase, "turns">): string =>
  createHash("sha256").update(c.turns.map((t) => t.user).join("\n")).digest("hex").slice(0, 16);

// --- Patterns and facts --------------------------------------------------------------------------------------------

/** A tool pattern: `*` matches anything, `a|b` either; the whole name must match. */
export function toolPattern(p: string): RegExp {
  const alts = p.split("|").map((a) => a.trim().replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
  return new RegExp(`^(?:${alts.join("|")})$`);
}

/**
 * The Claw API read of an `api` oracle (`/v1/...#pick`), or null when the query is not one this runner can run (a
 * description of a read a person or another tool makes): such a fact is graded by the judge only.
 */
export function apiQuery(o: Oracle | undefined): { path: string; at: string } | null {
  const m = o?.kind === "api" ? /^(\/v1\/[^#\s]*)#(\S+)$/.exec(o.query ?? "") : null;
  return m ? { path: m[1]!, at: m[2]! } : null;
}

/** Values picked from JSON by a dotted path: `data.length`, `name`, `data.*.title` (every element), `data.0.seq`. */
export function pick(json: unknown, path: string): string[] {
  let cur: unknown[] = [json];
  for (const part of path.split(".")) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (part === "*" && Array.isArray(v)) next.push(...v);
      else if (part === "length" && Array.isArray(v)) next.push(v.length);
      else if (v !== null && typeof v === "object") next.push((v as Record<string, unknown>)[part]);
    }
    cur = next.filter((v) => v !== undefined && v !== null);
  }
  return cur.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)));
}

/** Does the answer name the value? Case-insensitive, spaces ignored; a number must stand on its own (12 is not 120). */
export function names(answer: string, value: string): boolean {
  const a = answer.toLowerCase().replace(/\s+/g, "");
  const v = value.toLowerCase().replace(/\s+/g, "");
  if (!v) return false;
  if (/^\d+$/.test(v)) return new RegExp(`(^|[^\\d])${v}([^\\d]|$)`).test(a);
  return a.includes(v);
}

// --- What the assistant said --------------------------------------------------------------------------------------

/**
 * Text that must never reach a user: tool and protocol names, ids, the Router's own bookkeeping. A user sees an item by
 * its title in plain words ("#12 修复登录超时"), not a bare number or an id.
 */
export const INTERNAL_TEXT: ReadonlyArray<[string, RegExp]> = [
  ["tool name", /\bmcp__[a-z0-9_-]+/i],
  ["router tool", /\b(work_create|work_send|work_stop|work_list|review_start|review_restart|confirmation_answer)\b/],
  ["work_event marker", /\[work_event\]/],
  ["item id field", /\bitem_id\b/],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["claw message id", /\bclaw-(pending-)?\d+\b/],
  ["prompt leak", /system prompt|<\/?(system|tool_result|function_calls)>/i],
];
/** With `style.no_ids`: an item named only by its number ("编号 #178", "#178。") rather than by its title. */
export const BARE_NUMBER = /编号\s*#?\d+|#\d+(?=\s*($|[，。、,.;；:：)）!！?？]))/m;

/** One event of a session as it arrived on the live stream (`at`: when this runner received it). */
export interface LiveEvent { at: number; eventId: string; data: Record<string, any> }

export interface Say {
  at: number;
  sayId: string;
  turn: string;
  text: string;
  itemId: string | null;
  itemState: string | null;
  canAccept: boolean;
  confirm: boolean;
  fallback: boolean;
}

export const saysOf = (events: readonly LiveEvent[]): Say[] => events
  .filter((e) => e.data?.type === "AssistantSay")
  .map((e) => ({
    at: e.at, sayId: String(e.data.say_id ?? e.eventId), turn: String(e.data.turn_message_id ?? ""), text: String(e.data.text ?? ""),
    itemId: e.data.item?.item_id ? String(e.data.item.item_id) : null,
    itemState: e.data.item?.board_state ? String(e.data.item.board_state) : null,
    canAccept: e.data.item?.can_accept === true,
    confirm: !!e.data.confirm_action,
    fallback: e.data.fallback === true,
  }));

/** The tool calls of the turns that answered these messages (live events carry the turn's message id). */
export function turnCalls(events: readonly LiveEvent[], messageIds: readonly string[]): ToolCall[] {
  const ids = new Set(messageIds);
  const rows: EventRow[] = events
    .filter((e) => ids.has(String(e.data?.message_id ?? "")))
    .map((e) => ({ event_type: String(e.data.type ?? ""), created_at: new Date(e.at).toISOString(), data: e.data }));
  return traceOf(rows).calls;
}

/** A turn that ended, by its message id. */
export const turnEnded = (events: readonly LiveEvent[], messageId: string): boolean =>
  events.some((e) => e.data?.type === "exec_complete" && e.data.message_id === messageId);

export interface ItemSeen { item_id: string; seq: number; title: string; kind: string; board_state: string; can_accept: boolean; result_version: number; outcome: string | null }

/** How the case was handled: a review item, any other item, a command put to the user to confirm, or an answer. */
export function routeOf(items: readonly ItemSeen[], calls: readonly ToolCall[], says: readonly Say[]): Exclude<Route, "clarify"> {
  if (items.some((i) => i.kind === "review") || calls.some((c) => /(^|__)review_(start|restart)$/.test(c.name) && c.ok === true)) return "review";
  if (items.length || calls.some((c) => /(^|__)work_create$/.test(c.name) && c.ok === true)) return "item";
  if (says.some((s) => s.confirm)) return "confirm";
  return "answer";
}

/**
 * The items a turn started: those whose id or number a successful work_create / review_start / review_restart call of
 * the turn answered with (`{"item_id": ..., "seq": ...}`), among the case's items. A call whose answer cannot be read
 * still makes the route an item (`routeOf`); it just names no item here.
 */
export function itemsStartedBy(calls: readonly ToolCall[], items: readonly ItemSeen[]): ItemSeen[] {
  const ids = new Set<string>();
  const seqs = new Set<number>();
  for (const c of calls) {
    if (c.ok !== true || !/(^|__)(work_create|review_start|review_restart)$/.test(c.name)) continue;
    for (const m of c.result.matchAll(/"item_id"\s*:\s*"([^"]+)"/g)) ids.add(m[1]!);
    for (const m of c.result.matchAll(/"seq"\s*:\s*(\d+)/g)) seqs.add(Number(m[1]));
  }
  return items.filter((i) => ids.has(i.item_id) || seqs.has(i.seq));
}

/** What the user was offered to press, as a channel draws it: Accept on a result that waits, Run on a command to confirm. */
export function cardsOf(says: readonly Say[]): Cards {
  if (says.some((s) => s.confirm)) return "confirm";
  if (says.some((s) => s.canAccept)) return "accept";
  return "none";
}

/**
 * The final answer of the case. With items: the last say about one of them once it left "in progress" (a result, a
 * question, a failure). Otherwise, or when there is none: the last say of the case's own turns.
 */
export function finalSay(says: readonly Say[], messageIds: readonly string[], itemIds: readonly string[]): Say | null {
  const items = new Set(itemIds);
  const aboutItems = says.filter((s) => s.itemId !== null && items.has(s.itemId) && s.itemState !== "in_progress");
  if (aboutItems.length) return aboutItems.at(-1)!;
  const turns = new Set(messageIds);
  return says.filter((s) => turns.has(s.turn)).at(-1) ?? null;
}

/** Everything said to the user in the case: its own turns' says and every say about its items. */
export function caseSays(says: readonly Say[], messageIds: readonly string[], itemIds: readonly string[]): Say[] {
  const turns = new Set(messageIds);
  const items = new Set(itemIds);
  return says.filter((s) => turns.has(s.turn) || (s.itemId !== null && items.has(s.itemId)));
}

// --- Grading -------------------------------------------------------------------------------------------------------

export interface Observed {
  mode: Mode;
  /** Undefined in baseline: a plain session has no route and no cards. */
  route?: Exclude<Route, "clarify">;
  cards?: Cards;
  calls: ToolCall[];
  /** Every text the user was shown in the case (in baseline: the session's answers). */
  shown: string[];
  final: string;
  firstReplyMs: number | null;
  finalMs: number | null;
  /** Per turn: when its own first reply arrived, from when it was sent. */
  replyMs: Array<number | null>;
  /** The case's items as they stood when it was graded (before any cleanup). */
  items: ItemSeen[];
  /** The values of the case's facts, in order: an oracle's at run time, a static one's as written; null when there is none. */
  factValues: Array<string[] | null>;
}

export interface Check { name: string; pass: boolean; skipped?: true; detail?: string }

const CJK = /[㐀-鿿]/g;

/** The deterministic checks of a case. Checks that do not apply in a mode are listed as skipped, never as passed silently. */
export function grade(c: EvalCase, o: Observed): Check[] {
  const out: Check[] = [];
  const skip = (name: string): void => { out.push({ name, pass: true, skipped: true }); };
  const called = o.calls.map((x) => x.name);
  if (c.route) {
    const name = `route=${c.route}`;
    if (o.mode === "baseline") skip(name);
    else if (c.route === "clarify") out.push({ name, pass: o.route === "answer" && /[?？]/.test(o.final), detail: `was ${o.route}` });
    else out.push({ name, pass: o.route === c.route, detail: `was ${o.route}` });
  }
  // A question answered in the chat starts no work, whatever the case lists.
  const mustNot = [...new Set([...(c.tools_must_not ?? []), ...(c.route === "answer" || c.route === "clarify" ? ["mcp__assistant__work_create"] : [])])];
  for (const p of c.tools_must ?? []) out.push({ name: `tool ${p}`, pass: called.some((n) => toolPattern(p).test(n)), detail: [...new Set(called)].join(",") || "no calls" });
  for (const p of mustNot) {
    const hit = called.filter((n) => toolPattern(p).test(n));
    out.push({ name: `no tool ${p}`, pass: hit.length === 0, detail: hit.join(",") });
  }
  out.push({ name: "answered", pass: o.final.trim().length > 0 });
  (c.facts ?? []).forEach((f, k) => {
    const values = o.factValues[k] ?? null;
    const name = `fact ${f.claim}`.slice(0, 80);
    if (values === null) { skip(name); return; }
    const want = values.slice(0, 10);
    // An oracle's value is the identity's own data: the result says only how many were expected, never what.
    const detail = f.oracle?.kind === "api" ? `expected ${want.length} oracle value(s)` : `expected ${want.join(", ").slice(0, 80)}`;
    out.push({ name, pass: want.length > 0 && want.every((v) => names(o.final, v)), detail });
  });
  if (c.cards) {
    if (o.mode === "baseline") skip(`cards=${c.cards}`);
    else out.push({ name: `cards=${c.cards}`, pass: o.cards === c.cards, detail: `was ${o.cards}` });
  }
  const shownText = o.shown.join("\n");
  for (const [label, re] of INTERNAL_TEXT) {
    const m = re.exec(shownText);
    out.push({ name: `no internal text: ${label}`, pass: m === null, detail: m ? m[0] : undefined });
  }
  if (c.style?.no_ids) {
    const m = BARE_NUMBER.exec(shownText);
    out.push({ name: "items named by title", pass: m === null, detail: m ? m[0] : undefined });
  }
  if (c.style?.reply_lang === "follow_user" && c.lang !== "mixed") {
    const letters = o.final.replace(/\s/g, "").length;
    const ratio = letters ? (o.final.match(CJK)?.length ?? 0) / letters : 0;
    out.push({ name: `reply in ${c.lang}`, pass: letters > 0 && (c.lang === "zh" ? ratio >= 0.2 : ratio < 0.05), detail: `cjk ${ratio.toFixed(2)}` });
  }
  if (c.style?.max_chars !== undefined) out.push({ name: `<= ${c.style.max_chars} chars`, pass: o.final.length <= c.style.max_chars, detail: `${o.final.length}` });
  const b = c.latency_budget_s ?? {};
  if (b.first !== undefined) out.push({ name: `first reply <= ${b.first}s`, pass: o.firstReplyMs !== null && o.firstReplyMs <= b.first * 1000, detail: `${o.firstReplyMs}ms` });
  if (b.final !== undefined) out.push({ name: `final <= ${b.final}s`, pass: o.finalMs !== null && o.finalMs <= b.final * 1000, detail: `${o.finalMs}ms` });
  if (b.each !== undefined) {
    const each = b.each * 1000;
    out.push({ name: `each reply <= ${b.each}s`, pass: o.replyMs.length > 0 && o.replyMs.every((ms) => ms !== null && ms <= each), detail: o.replyMs.join(",") });
  }
  if (c.items_closed) {
    if (o.mode === "baseline") skip("items closed");
    else out.push({ name: "items closed", pass: o.items.length > 0 && o.items.every((i) => i.board_state === "done"), detail: o.items.map((i) => `${i.board_state}/${i.outcome}`).join(",") || "no item" });
  }
  return out;
}

export const passed = (checks: readonly Check[]): boolean => checks.every((c) => c.pass);

/** What cleaning up an item means: accept a result that waits, stop anything still open, leave a closed one. */
export function cleanupOf(item: Pick<ItemSeen, "board_state" | "can_accept" | "result_version">): { op: "accept"; version: number } | { op: "stop" } | null {
  if (item.board_state === "done") return null;
  if (item.can_accept) return { op: "accept", version: item.result_version };
  return { op: "stop" };
}

/** Text with every secret replaced, and anything shaped like an API key masked even if it is not one of them. */
export function scrub(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const k of secrets) if (k) out = out.split(k).join("<redacted>");
  return out.replace(/\b(ak|sk)-[A-Za-z0-9_-]{12,}/g, "<redacted>");
}

/** Parse SSE text into frames; returns the frames and the unparsed tail (a frame not yet complete). */
export function sseFrames(buffer: string): { frames: Array<{ id: string; event: string; data: string }>; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames = parts.map((p) => {
    let id = "", event = "";
    const data: string[] = [];
    for (const line of p.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    return { id, event, data: data.join("\n") };
  }).filter((f) => f.event || f.data);
  return { frames, rest };
}

// --- Results ---------------------------------------------------------------------------------------------------------

export interface Attempt {
  pass: boolean;
  checks: Check[];
  route?: string;
  cards?: string;
  tools: string[];
  /** The final answer: kept only with EVAL_KEEP_TEXT (it is the identity's own data); otherwise null and its length. */
  final: string | null;
  finalChars: number;
  firstReplyMs: number | null;
  finalMs: number | null;
  items: Array<Pick<ItemSeen, "seq" | "kind" | "board_state"> & { cleanup: string }>;
  judge?: { pass: boolean; why: string } | null;
  error?: string;
}

export interface CaseResult {
  id: string;
  area: string;
  pipeline: string;
  mode: Mode;
  hash: string;
  attempts: Attempt[];
  skipped?: string;
}

/** pass@1: the share of a case's attempts that passed. pass^k: the case passed every one of its k attempts. */
export const passAt1 = (r: CaseResult): number => (r.attempts.length ? r.attempts.filter((a) => a.pass).length / r.attempts.length : 0);
export const passAll = (r: CaseResult): boolean => r.attempts.length > 0 && r.attempts.every((a) => a.pass);

export interface Totals {
  cases: number;
  /** Mean over cases of pass@1. */
  passAt1: number;
  /** Cases that passed all of their attempts. */
  passAllK: number;
  errors: number;
  firstReplyP50Ms: number | null;
  firstReplyP90Ms: number | null;
  finalP50Ms: number | null;
  finalP90Ms: number | null;
}

export function totals(results: readonly CaseResult[]): Record<string, Totals> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    if (r.skipped) continue;
    for (const k of [r.area, "all"]) groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Record<string, Totals> = {};
  const nums = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null);
  for (const [k, rs] of groups) {
    const attempts = rs.flatMap((r) => r.attempts.filter((a) => !a.error));
    out[k] = {
      cases: rs.length,
      passAt1: rs.reduce((s, r) => s + passAt1(r), 0) / rs.length,
      passAllK: rs.filter(passAll).length,
      errors: rs.reduce((n, r) => n + r.attempts.filter((a) => a.error).length, 0),
      firstReplyP50Ms: percentile(nums(attempts.map((a) => a.firstReplyMs)), 50),
      firstReplyP90Ms: percentile(nums(attempts.map((a) => a.firstReplyMs)), 90),
      finalP50Ms: percentile(nums(attempts.map((a) => a.finalMs)), 50),
      finalP90Ms: percentile(nums(attempts.map((a) => a.finalMs)), 90),
    };
  }
  return out;
}

/** A Markdown table of the run, one row per case (the first attempt's details, and how many attempts passed). */
export function renderTable(results: readonly CaseResult[]): string {
  const sec = (ms: number | null): string => (ms === null ? "-" : (ms / 1000).toFixed(1));
  const rows = results.map((r) => {
    const a = r.attempts[0];
    if (r.skipped || !a) return `| ${r.id} | - | - | - | - | SKIP ${r.skipped ?? ""} | |`;
    const failed = r.attempts.flatMap((x) => (x.error ? [`error: ${x.error.slice(0, 80)}`]
      : x.checks.filter((c) => !c.pass).map((c) => c.name + (c.detail ? ` (${c.detail.slice(0, 60)})` : ""))));
    const tools = [...new Set(a.tools)].map((t) => t.replace(/^mcp__/, "")).join(" ").slice(0, 120);
    const verdict = `${r.attempts.filter((x) => x.pass).length}/${r.attempts.length}`;
    return `| ${r.id} | ${a.route ?? "-"} | ${tools || "-"} | ${sec(a.firstReplyMs)} | ${sec(a.finalMs)} | ${verdict} | ${[...new Set(failed)].join("; ").replace(/\|/g, "/").slice(0, 300)} |`;
  });
  return ["| case | route | tools | first (s) | final (s) | passed | failed checks |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

// --- Safety, plans and recordings ----------------------------------------------------------------------------------

/** Who the key is, as `GET /v1/me` says, and what of theirs could carry the run's messages to a person. */
export interface Identity { name?: string; email?: string }
export interface Subscription { enabled?: boolean; event_types?: string[] }

/**
 * Why the live run must not start with this identity, or null when it may. The run talks to the identity's own
 * assistant and starts work on its board, so it must be a test identity and nobody's own:
 *   - EVAL_IDENTITY_ACK must be `test:<email or name>` of exactly this identity: the operator says which identity it is
 *     and that it is a test one (a key file that changed hands is refused, not used);
 *   - an identity in EVAL_IDENTITY_DENY (comma list of emails or names) is refused whatever the acknowledgement says;
 *   - an enabled notification subscription is refused (EVAL_ALLOW_SUBSCRIBED=1 overrides it): a channel such as a chat
 *     app pushes what the assistant says to a person, so the run would write into somebody's chat.
 */
export function identityRefusal(me: Identity, subs: readonly Subscription[], env: Record<string, string | undefined>): string | null {
  const who = [me.email, me.name].filter((x): x is string => !!x).map((x) => x.trim().toLowerCase());
  if (!who.length) return "GET /v1/me names nobody: the identity cannot be acknowledged";
  const deny = new Set((env.EVAL_IDENTITY_DENY ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  if (who.some((w) => deny.has(w))) return "this identity is on EVAL_IDENTITY_DENY";
  const ack = (env.EVAL_IDENTITY_ACK ?? "").trim().toLowerCase();
  if (!ack.startsWith("test:") || !who.includes(ack.slice(5))) {
    return "set EVAL_IDENTITY_ACK=test:<the email of this key's identity> to confirm it is a test identity (never a person's own)";
  }
  const pushing = subs.filter((s) => s.enabled !== false);
  if (pushing.length && env.EVAL_ALLOW_SUBSCRIBED !== "1") {
    return `this identity has ${pushing.length} enabled notification subscription(s): what the assistant says would be pushed to a channel`;
  }
  return null;
}

/** What a run would do, without doing it (EVAL_DRY_RUN): one line per case. */
export function planOf(cases: readonly EvalCase[], mode: Mode, env: Record<string, string | undefined>): string[] {
  return cases.map((c) => {
    const turns = turnsOf(c, env);
    const skip = c.modes && !c.modes.includes(mode) ? `skip (${c.modes.join(",")} only)` : turns === null ? `skip (needs ${c.needs})` : "";
    const facts = (c.facts ?? []).map((f) => (apiQuery(f.oracle) ? "api" : f.oracle?.value !== undefined && f.oracle.kind !== "api" ? "value" : "judge"));
    return [c.id, skip || `${c.turns.length} turn(s)`, `route=${c.route ?? "-"}`, `tools=${(c.tools_must ?? []).join(",") || "-"}`,
      `facts=${facts.join(",") || "-"}`, `budget=${JSON.stringify(c.latency_budget_s ?? {})}`].join("  ");
  });
}

/**
 * One attempt as it was observed, so it can be graded again offline (EVAL_OFFLINE) after the cases or the grader
 * change. It holds what the identity was shown, so it is written only where the operator asks (EVAL_RECORD_DIR).
 */
export interface Recording { case_id: string; mode: Mode; attempt: number; at: string; observed: Observed }

export function parseRecordings(text: string): Recording[] {
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Recording)
    .filter((r) => typeof r.case_id === "string" && r.observed && Array.isArray(r.observed.calls));
}
