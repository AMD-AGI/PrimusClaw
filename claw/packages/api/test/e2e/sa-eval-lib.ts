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
 *                    An `api` oracle is read at run time with the eval identity, in one of three forms (`oracleQuery`):
 *                      `/v1/...#<pick>`                a Claw API GET, e.g. `/v1/work-items?state=in_progress#data.length`
 *                      `gh:/...#<pick>`                a GitHub REST GET, e.g. `gh:/search/issues?q=is:pr+author:{EVAL_GH_LOGIN}#total_count`
 *                      `mcp:<server>/<tool>?k=v#<pick>` a read tool of the plugin's MCP server, e.g. `mcp:safe/node_get?name=n1#phase`
 *                    A static or fixture value is a value to find in the answer (a number, a name); a description of what
 *                    the answer should say belongs in the rubric. A fact without a value or a runnable query is graded by the
 *                    judge, with the oracle's text as what it is checked against.
 *   cards            none | accept | confirm                            what the user may be shown to press in the last turn
 *   style            {reply_lang: follow_user, max_chars, no_ids}
 *   latency_budget_s {first, final, each}                               seconds from the last turn's sending (each: per turn)
 *   source           {kind: real|synthetic|public, hash, ref}
 *   notes            why the case exists
 * and, for this runner only (all optional): `rubric` (what a judge model grades, `EVAL_JUDGE_*`), `modes` (the modes the
 * case runs in, default both: a case that needs the assistant's own tools or items says `["assistant"]`), `needs` (one or
 * more variables it needs besides those its text names), `item_wait_s` (how long to wait for an item's result),
 * `items_closed` (every item the case started is closed when it is graded: an interrupt that stopped it), `blocked` (why
 * a tool the case must call cannot be reached on its arm yet: the static check reports it instead of failing on it),
 * `may_deny` (saying it cannot do something is a right answer here: a refusal of an unsafe request),
 * `hold` (assistant mode: the case's item holds a request for its person, a write to approve or a question, and the
 * runner answers it as the person's channel does, see {@link HoldSpec}).
 *
 * Placeholders fill turns, claims, values, oracle queries and the rubric: `{NAME}` is an environment variable, `{{name}}`
 * (also `{{a.b}}`) a run variable from EVAL_VARS_FILE or EVAL_VAR_<NAME>. A case with a placeholder that has no value
 * is skipped, and says which.
 *
 * Every case is also held to one rule (`CAPABILITY_DENIAL`, and the judge's prompt): the answer must not say it cannot reach
 * or do something it has a tool for, unless it tried and the tool failed.
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
import { readdirSync, readFileSync } from "node:fs";
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
  needs?: string | string[];
  item_wait_s?: number;
  items_closed?: boolean;
  blocked?: string;
  may_deny?: boolean;
  hold?: HoldSpec;
}

/**
 * A request the case's item holds for its person (an entry of the item's `params.holds`, `assistant/holds.ts`): which tool, and how the
 * runner answers it, through the routes a channel answers with (`POST /v1/sessions/<worker>/messages`, a `decision` or an
 * `answer`). `wait_s` leaves it waiting that long first, to show the wait outlasts the minutes a console user gets.
 * `answers` maps a question id to the answer; `*` as the id answers every question with its first option.
 */
export interface HoldSpec {
  tool: string;
  decide: "allow" | "deny" | "answer";
  answers?: Record<string, string>;
  wait_s?: number;
}

/** What the runner saw of a case's hold. */
export interface HoldSeen {
  /** The held tool, or null when the item never held a request the case named. */
  tool: string | null;
  /** From Brain asking (its `ts`) to the item holding it for the person (the hold's event, written with the request's announcement). */
  cardMs: number | null;
  /** The status the answer was given with; null when it was not given. */
  answered: number | null;
  /** With `wait_s`: whether the item still held the same request when the wait was over. */
  heldAfterWait: boolean | null;
  /** Whether the held call ran (for a question: whether the answer reached the worker); null when it could not be told. */
  ran: boolean | null;
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
  if (c.hold !== undefined) {
    const h = c.hold as Partial<HoldSpec>;
    if (typeof h.tool !== "string" || !h.tool) out.push("hold without a tool");
    if (!["allow", "deny", "answer"].includes(String(h.decide))) out.push(`hold decide ${h.decide}`);
    if (h.decide === "answer" && (!h.answers || typeof h.answers !== "object" || !Object.keys(h.answers).length)) out.push("hold answer without answers");
    if (h.wait_s !== undefined && !(Number.isInteger(h.wait_s) && h.wait_s >= 0 && h.wait_s <= 7200)) out.push(`hold wait_s ${h.wait_s}`);
  }
  return out;
}

/** The request a worker raised under this id, as its session's events stored it: Brain's `ts` and the tool, or null. */
export function heldRequest(rows: readonly EventRow[], toolUseId: string): { ts: number; tool: string; questions: unknown } | null {
  for (const r of rows) {
    const d = r.data ?? {};
    const type = d.type ?? r.event_type;
    if (type === "permissionRequest" && (d.tool_use_id === toolUseId || d.actionId === toolUseId)) {
      return { ts: Number(d.ts), tool: String(d.tool ?? ""), questions: null };
    }
    if (type === "userQuestion" && d.actionId === toolUseId) return { ts: Number(d.ts), tool: "ask_user_question", questions: d.questions };
  }
  return null;
}

/**
 * Whether the held call ran after its answer: a successful result of that very call (the same id). A denied call ends with
 * Brain's `decisionResult` and, at most, an error result. Null while neither has happened.
 */
export function heldCallRan(rows: readonly EventRow[], toolUseId: string): boolean | null {
  let ended = false;
  for (const r of rows) {
    const d = r.data ?? {};
    const type = d.type ?? r.event_type;
    if (type === "toolUsed" && d.actionId === toolUseId && d.status !== "start") {
      if (d.status === "success") return true;
      ended = true;
    }
    if (type === "decisionResult" && (d.tool_use_id === toolUseId || d.actionId === toolUseId) && d.decision !== "allow" && d.action !== "allow") ended = true;
  }
  return ended ? false : null;
}

/** The answers a question card would send for `spec`: `*` answers each question with its first option's label. */
export function holdAnswers(spec: HoldSpec, questions: unknown): Record<string, string> {
  const given = spec.answers ?? {};
  if (!("*" in given)) return { ...given };
  const out: Record<string, string> = {};
  for (const q of Array.isArray(questions) ? questions : []) {
    const first = Array.isArray(q?.options) ? q.options[0] : undefined;
    if (typeof q?.id === "string" && first) out[q.id] = String(first.label ?? first.id);
  }
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
    // The entry's own type, read with the listing: no separate stat that a change between the two could make stale.
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      const name = entry.name;
      const p = join(d, name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && name.endsWith(".jsonl")) {
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

/** Where placeholders come from: environment variables (`{NAME}`) and run variables (`{{name}}`, or EVAL_VAR_<NAME>). */
export type Vars = Readonly<Record<string, string | undefined>>;

/** `{{name}}` (group 1) or `{NAME}` (group 2). A placeholder's name, as `needs` and a skip say it, is `repo` for `{{repo}}`. */
const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.-]*)\s*\}\}|\{([A-Z][A-Z0-9_]*)\}/g;
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER.source);
const envName = (name: string): string => `EVAL_VAR_${name.toUpperCase().replace(/[.-]/g, "_")}`;
const valueOf = (vars: Vars, name: string, run: boolean): string | undefined => {
  const v = run ? (vars[name] ?? vars[envName(name)]) : vars[name];
  return v === undefined || v === "" ? undefined : v;
};

/** The placeholders a text names. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? m[2]!))];
}

/** The text with every placeholder that has a value filled; one without a value is left as written. */
export function fill(text: string, vars: Vars): string {
  return text.replace(PLACEHOLDER, (all, run: string | undefined, env: string | undefined) => valueOf(vars, run ?? env!, run !== undefined) ?? all);
}

/** Every text of a case a placeholder can sit in. */
const textsOf = (c: EvalCase): string[] => [
  ...c.turns.map((t) => t.user), c.rubric ?? "",
  ...(c.facts ?? []).flatMap((f) => [f.claim, f.oracle?.value ?? "", f.oracle?.query ?? ""]),
];

/** The variables a case needs that have no value, sorted: its placeholders and its `needs`. */
export function missingVars(c: EvalCase, vars: Vars): string[] {
  const out = new Set<string>();
  for (const t of textsOf(c)) {
    for (const m of t.matchAll(PLACEHOLDER)) if (valueOf(vars, m[1] ?? m[2]!, m[1] !== undefined) === undefined) out.add(m[1] ?? m[2]!);
  }
  for (const n of [c.needs ?? []].flat()) if (valueOf(vars, n, !/^[A-Z][A-Z0-9_]*$/.test(n)) === undefined) out.add(n);
  return [...out].sort();
}

/** The case with its placeholders filled; null when one has no value (the case is skipped, `missingVars` says why). */
export function filledCase(c: EvalCase, vars: Vars): EvalCase | null {
  if (missingVars(c, vars).length) return null;
  const f = (s: string): string => fill(s, vars);
  return {
    ...c, turns: c.turns.map((t) => ({ ...t, user: f(t.user) })), ...(c.rubric !== undefined ? { rubric: f(c.rubric) } : {}),
    ...(c.facts ? { facts: c.facts.map((x) => ({ claim: f(x.claim), ...(x.oracle ? { oracle: {
      kind: x.oracle.kind, ...(x.oracle.value !== undefined ? { value: f(x.oracle.value) } : {}), ...(x.oracle.query !== undefined ? { query: f(x.oracle.query) } : {}),
    } } : {}) })) } : {}),
  };
}

/** The case's turns with every placeholder filled; null when the case needs a variable that has no value. */
export function turnsOf(c: EvalCase, vars: Vars): Turn[] | null {
  return filledCase(c, vars)?.turns ?? null;
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

/** An `api` oracle this runner can read at run time, by where it reads (see the case format above). */
export type OracleQuery =
  | { via: "claw"; path: string; at: string }
  | { via: "github"; path: string; at: string }
  | { via: "mcp"; server: string; tool: string; args: Record<string, unknown>; at: string };

/** The read an `api` oracle names, or null for one this runner cannot run (a description, or a placeholder not filled). */
export function oracleQuery(o: Oracle | undefined): OracleQuery | null {
  if (o?.kind !== "api") return null;
  const q = (o.query ?? "").trim();
  if (HAS_PLACEHOLDER.test(q)) return null;
  const claw = apiQuery(o);
  if (claw) return { via: "claw", ...claw };
  const gh = /^gh:(\/[^#\s]*)#(\S+)$/.exec(q);
  if (gh) return { via: "github", path: gh[1]!, at: gh[2]! };
  const mcp = /^mcp:([a-z0-9][a-z0-9_-]*)\/([A-Za-z0-9_]+)(?:\?([^#\s]*))?#(\S+)$/.exec(q);
  if (!mcp) return null;
  const args: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(mcp[3] ?? "")) {
    // A number, a boolean or null as itself; anything else as the text it is.
    args[k] = /^(-?\d+(\.\d+)?|true|false|null)$/.test(v) ? JSON.parse(v) : v;
  }
  return { via: "mcp", server: mcp[1]!, tool: mcp[2]!, args, at: mcp[4]! };
}

/**
 * Where an `mcp:` oracle may connect, and with what: the server's URL when it is https on one of `hosts`, and its headers with the
 * key put only where the spec asks for it by Brain's placeholder (`<SAFE_API_KEY>`, in `token` or a header). A spec without a token
 * gets no authorization. A string says why the server may not be read: a plugin that points a known server name at another host
 * never receives the key.
 */
export function oracleMcpTarget(spec: Record<string, unknown>, hosts: readonly string[], key: string): { url: URL; headers: Record<string, string> } | string {
  let url: URL;
  try { url = new URL(String(spec.url ?? "")); } catch { return "no valid url"; }
  const allowed = hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== "https:" || !allowed.includes(url.host.toLowerCase())) return `${url.host || "its host"} is not an allowed host`;
  const fill = (v: unknown): string => String(v).split("<SAFE_API_KEY>").join(key);
  const raw = spec.headers && typeof spec.headers === "object" ? spec.headers as Record<string, unknown> : {};
  const headers: Record<string, string> = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, fill(v)]));
  if (typeof spec.token === "string" && spec.token) headers.authorization = `Bearer ${fill(spec.token)}`;
  return { url, headers };
}

/** Brain's allow-list matching: an exact name, or a prefix before a trailing `*`. */
const allowedBy = (allow: readonly string[], name: string): boolean => allow.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

/**
 * Whether an `mcp:` oracle may be run: only a tool on the router's list of reads (`assistant/read-tools.ts`, as
 * `tools_allowlist` entries), so an oracle can never write. Anything else is graded by the judge.
 */
export const oracleMayRun = (q: OracleQuery, reads: readonly string[]): boolean => q.via !== "mcp" || allowedBy(reads, `mcp__${q.server}__${q.tool}`);

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
/**
 * An answer in which the assistant says that it itself cannot reach something: it cannot access, read, browse or query a
 * system, has no permission or no tool for it, cannot get on the internet. Said of itself, so a fact about a system ("the node
 * cannot be reached") is not one. Whether it was false is what the tools say: a denial with no failed call in the turn is one
 * (`grade`); a case where refusing is right says `may_deny`.
 */
export const CAPABILITY_DENIAL = new RegExp([
  "我(目前|现在|暂时|这边|这里)?(还)?(无法|不能|没法|没办法|不可以)(直接)?(访问|读取|查看|查询|获取|连接|联网|上网|浏览|打开|拿到)",
  "我(这边|这里)?(访问|读取|查询|连接|读|查|看)不了", "我(这边|这里)?(访问|连接|拿)不到",
  "我(这边|这里)?(没有|无)[^，。,.!！?？\\n]{0,12}?(工具|能力|接口|权限)",
  "(无法|不能|没法)(联网|上网)", "没有(联网|上网)(能力|功能|工具)",
  "\\bI(?: am|'m)? (?:currently |still )?(?:can(?:'|’)?t|cannot|can not|unable to|not able to)(?: directly)? (?:access|read|browse|reach|connect to|query|look up|fetch|check|open|get to)\\b",
  "\\bI (?:don(?:'|’)?t|do not) have (?:any )?(?:access|permission|internet|web access|a tool|the tools?|tools?)\\b",
  "\\bI have no (?:access|internet|web access|tools?)\\b",
].join("|"), "i");

/**
 * The systems a denial can name, and which failed call reaches each: an MCP server's tool, Brain's web tools, or a shell command that
 * itself went to GitHub (`gh`, `git`, a github.com address; a failed `python x.py` is not a failed GitHub call).
 */
const DENIED_SYSTEMS: ReadonlyArray<[RegExp, (c: ToolCall) => boolean]> = [
  [/github|\bgh\b|pull request|\bPRs?\b|仓库|代码库/i, (c) => /^mcp__github__/.test(c.name)
    || (/^bash$/i.test(c.name) && shellReachesGithub(String(c.input?.command ?? "")))],
  [/联网|上网|互联网|网页|网站|internet|\bweb\b|browse|online/i, (c) => /^(web_search|web_fetch)$/.test(c.name)],
  [/safe|workloads?|workspaces?|集群|cluster|节点|\bnodes?\b/i, (c) => /^mcp__safe__/.test(c.name)],
  [/dispatron|计划|\bplans?\b/i, (c) => /^mcp__dispatron__/.test(c.name)],
  [/autopilot/i, (c) => /^mcp__autopilot__/.test(c.name)],
  [/pulse|leaderboard|排行/i, (c) => /^mcp__pulse__/.test(c.name)],
  [/看板|\bboard\b|\bissues?\b/i, (c) => /^mcp__agent-board__/.test(c.name)],
];

/**
 * Whether a shell command itself went to GitHub: one of its commands (split at `;`, `&&`, `||`, `|` and new lines) runs `gh` or
 * `git`, or fetches a github.com address with curl or wget. Text that only mentions them (`echo git status`) does not count.
 */
export function shellReachesGithub(command: string): boolean {
  return command.split(/;|&&|\|\||\||\n/).some((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ["sudo", "env", "time", "command", "exec", "("].includes(words[0]!))) words.shift();
    const program = (words[0] ?? "").replace(/^\(+/, "").split("/").pop() ?? "";
    if (program === "gh" || program === "git") return true;
    return (program === "curl" || program === "wget") && words.some((w) => /(^|[/"'@])(api\.)?github\.com([/:"']|$)/i.test(w));
  });
}

/**
 * Every denial in `final` that the turn's calls do not make true, as the words that said it ([] when there is none). A denial may
 * be true only when a call of the turn failed; when its sentence names systems (GitHub, the web, SaFE, ...), each one it names
 * needs a failed call of its own, so a failure of one system never excuses denying another; a denial that names none is taken as
 * being about whichever call failed. Every denial is checked, not only the first.
 */
export function falseDenials(final: string, calls: readonly ToolCall[]): string[] {
  const failed = calls.filter((x) => x.ok === false);
  const sentences = [...final.matchAll(/[^。！？!?\n]+?(?:[。！？!?\n]|\.(?=\s|$)|$)/g)].map((m) => ({ at: m.index!, text: m[0] }));
  const out: string[] = [];
  for (const m of final.matchAll(new RegExp(CAPABILITY_DENIAL.source, "gi"))) {
    const sentence = sentences.find((x) => m.index! >= x.at && m.index! < x.at + x.text.length)?.text ?? final;
    const named = DENIED_SYSTEMS.filter(([words]) => words.test(sentence)).map(([, reaches]) => reaches);
    const justified = failed.length > 0 && (named.length === 0 || named.every((reaches) => failed.some(reaches)));
    if (!justified) out.push(m[0]);
  }
  return out;
}

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
  /** A case with `hold`: what the runner saw of it (assistant mode only). */
  hold?: HoldSeen;
}

/** The longest an item may take to hold its request for the person, from Brain asking: what a person waits for the card. */
export const HOLD_CARD_MS = 5_000;

/** `unverified`: a check that applies but could not be made here (an API oracle not read: offline). The attempt is then not
 * a pass (`verdictOf`). */
export interface Check { name: string; pass: boolean; skipped?: true; unverified?: true; detail?: string }

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
    if (values === null) {
      if (oracleQuery(f.oracle)) out.push({ name, pass: true, skipped: true, unverified: true, detail: "oracle not read" });
      else skip(name);
      return;
    }
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
  if (!c.may_deny) {
    // A denial can be true when a call to what it denies failed in the turn; any other denial is the failure this rule is for.
    const unjustified = falseDenials(o.final, o.calls);
    out.push({ name: "no false denial", pass: unjustified.length === 0, detail: unjustified[0] });
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
  if (c.hold) {
    const h = c.hold;
    const labels = [`held ${h.tool}`, `held within ${HOLD_CARD_MS / 1000}s`, "answer taken",
      ...(h.wait_s ? [`still held after ${h.wait_s}s`] : []), h.decide === "deny" ? "held call did not run" : h.decide === "answer" ? "answer reached the worker" : "held call ran"];
    if (o.mode === "baseline") labels.forEach(skip);
    else {
      const seen = o.hold;
      out.push({ name: labels[0]!, pass: !!seen?.tool && toolPattern(h.tool).test(seen.tool), detail: seen?.tool ?? "no hold" });
      out.push({ name: labels[1]!, pass: seen?.cardMs != null && seen.cardMs >= 0 && seen.cardMs <= HOLD_CARD_MS, detail: `${seen?.cardMs ?? null}ms` });
      out.push({ name: labels[2]!, pass: seen?.answered === 200, detail: `${seen?.answered ?? "not answered"}` });
      if (h.wait_s) out.push({ name: labels[3]!, pass: seen?.heldAfterWait === true, detail: `${seen?.heldAfterWait ?? null}` });
      out.push({ name: labels.at(-1)!, pass: seen?.ran === (h.decide !== "deny"), detail: `ran ${seen?.ran ?? "unknown"}` });
    }
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
  /** Not fully graded, so not a pass: content only a judge can grade and no judge graded it, or an oracle not read (offline). */
  unjudged?: true;
  error?: string;
}

/** The case has content only a judge can grade: a rubric, or a fact whose value is neither written nor read by an oracle. */
export const needsJudge = (c: EvalCase): boolean => !!c.rubric || judgeFacts(c).length > 0;

/** A fact graded without a judge: a runnable oracle, or a static or fixture value. */
const deterministic = (f: Fact): boolean => !!oracleQuery(f.oracle) || (!!f.oracle && f.oracle.kind !== "api" && f.oracle.value !== undefined);

/**
 * What only a judge can grade, one line per fact: its claim and, where the oracle describes a read this runner cannot make,
 * that description as what the claim is checked against. Without these lines in its prompt a judge would see a case with
 * no rubric as having nothing to grade, and it would stay unjudged for good.
 */
export function judgeFacts(c: EvalCase): string[] {
  return (c.facts ?? []).filter((f) => !deterministic(f))
    .map((f) => (f.oracle?.query || f.oracle?.value ? `${f.claim} (checked against: ${f.oracle.query ?? f.oracle.value})` : f.claim));
}

/** The rule every judged case is held to, besides its own: no false denial of a capability (see CAPABILITY_DENIAL). */
export const NO_FALSE_DENIAL_RULE = "The reply must not say that it cannot reach or do something (GitHub, the web, a platform, the user's own data) "
  + "when it has a tool for that, unless it tried the tool and the tool failed. Declining an unsafe or forbidden request is not such a denial.";

/** The judge's prompt for one case: the user's turns, the final reply, the rubric, the facts only it can grade, and the rule. */
export function judgePrompt(c: EvalCase, turns: readonly Turn[], final: string): string {
  const facts = judgeFacts(c);
  return `You grade one reply of an assistant to a user.\nUser said:\n${turns.map((t) => t.user).join("\n")}\n\n`
    + `Assistant's final reply:\n${final}\n\n${c.rubric ? `Rubric: ${c.rubric}\n` : ""}${facts.length ? `The reply must state: ${facts.join("; ")}\n` : ""}`
    + `${c.may_deny ? "" : `Always: ${NO_FALSE_DENIAL_RULE}\n`}`
    + "\nAnswer with one line: PASS or FAIL, a colon, and one short reason.";
}

/**
 * An attempt's verdict: every deterministic check, and, for a case with content only a judge can grade, the judge's
 * PASS. Without a judge such an attempt is never a pass: it is reported as unjudged, so a reply that only looks right
 * (on time, the right route, but without the fact asked for) is not counted as passing.
 */
export function verdictOf(c: EvalCase, checks: readonly Check[], judge: { pass: boolean } | null | undefined): { pass: boolean; unjudged?: true } {
  if (!passed(checks)) return { pass: false };
  if (checks.some((x) => x.unverified)) return { pass: false, unjudged: true };
  if (!needsJudge(c)) return { pass: true };
  if (!judge) return { pass: false, unjudged: true };
  return { pass: judge.pass };
}

/** What a recording keeps of an observation: an api oracle's values are the identity's data, so they are left out (null:
 * an offline grading skips that fact). */
export function forRecording(c: EvalCase, o: Observed): Observed {
  return { ...o, factValues: o.factValues.map((v, k) => (oracleQuery(c.facts?.[k]?.oracle) ? null : v)) };
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
  /** Attempts that passed every deterministic check but whose content no judge graded (not counted as passes). */
  unjudged: number;
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
      unjudged: rs.reduce((n, r) => n + r.attempts.filter((a) => a.unjudged).length, 0),
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
    const unjudged = r.attempts.filter((x) => x.unjudged).length;
    const verdict = `${r.attempts.filter((x) => x.pass).length}/${r.attempts.length}${unjudged ? ` (${unjudged} unjudged)` : ""}`;
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
    const missing = missingVars(c, env);
    const skip = c.modes && !c.modes.includes(mode) ? `skip (${c.modes.join(",")} only)` : missing.length ? `skip (needs ${missing.join(", ")})` : "";
    const filled = filledCase(c, env) ?? c;
    const facts = (filled.facts ?? []).map((f) => {
      const q = oracleQuery(f.oracle);
      return q ? (q.via === "claw" ? "api" : q.via) : f.oracle?.value !== undefined && f.oracle.kind !== "api" ? "value" : "judge";
    });
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

// --- Static checks: what a case asks for against what its arm can do ----------------------------------------------------

/**
 * The tools each arm of the evaluation can call, as `tools_allowlist` entries (an exact name, or a prefix ending in `*`).
 *   router    the assistant's router turn: its own tools and the reads `assistant/read-tools.ts` gives it
 *   worker    a work item's worker, and a plain session: every server of the plugin, and Brain's own tools (any name that is not
 *             an MCP tool's)
 *   baseline  a plain session with the plugin (EVAL_MODE=baseline): the worker's tools, without the assistant's
 */
export interface Arms { router: readonly string[]; worker: readonly string[]; baseline: readonly string[] }

/** An entry that allows every tool that is not an MCP tool (Brain's built-ins: web_search, Bash, ...). */
export const BUILTIN_TOOLS = "<builtin>";

/**
 * Whether some tool name matches both a case's pattern (`*` anywhere, `a|b` either) and an allow-list. A built-in tool is any
 * name that does not start with `mcp__`.
 */
export function reachable(pattern: string, allow: readonly string[]): boolean {
  return pattern.split("|").map((a) => a.trim()).some((alt) => allow.some((entry) => {
    const head = alt.split("*")[0]!;
    // Some name matching alt does not start with mcp__, unless alt's literal head already does.
    if (entry === BUILTIN_TOOLS) return !head.startsWith("mcp__");
    if (!entry.endsWith("*")) return toolPattern(alt).test(entry);
    // A prefix entry: some name starting with it matches alt, when alt's literal head and the prefix agree as far as both go.
    const pre = entry.slice(0, -1);
    return alt.includes("*") ? head.startsWith(pre) || pre.startsWith(head) : alt.startsWith(pre);
  }));
}

/** The arms a case runs on, with the tools each can reach for its last turn: an answer is the router's alone; an item adds its worker. */
export function armsOf(c: EvalCase, arms: Arms): Array<{ arm: "router" | "router+worker" | "baseline"; allow: readonly string[] }> {
  const modes = c.modes ?? ["assistant", "baseline"];
  const out: Array<{ arm: "router" | "router+worker" | "baseline"; allow: readonly string[] }> = [];
  if (modes.includes("assistant")) {
    out.push(c.route === "item" || c.route === "review" ? { arm: "router+worker", allow: [...arms.router, ...arms.worker] } : { arm: "router", allow: arms.router });
  }
  if (modes.includes("baseline")) out.push({ arm: "baseline", allow: arms.baseline });
  return out;
}

/** A static or fixture value that describes what the answer should say instead of being a value to find in it. */
export function descriptiveValue(v: string): boolean {
  const t = v.trim();
  return t.split(/\s+/).length >= 3 || /\||->|>=|<=|\bor\b/.test(t)
    || /^(asks?|no|not|does|doesn't|states?|mentions?|lists?|names?|covers?|refuses?|declines?|offers?|says?|explains?|either|any|at least|reply|answer|regex)\b/i.test(t);
}

export interface CaseFinding { id: string; kind: "unreachable" | "assistant-only" | "descriptive-value" | "blocked" | "judge-only" | "needs-vars"; detail: string }

/**
 * What can be told about cases without running them. Problems (the check fails on them):
 *   unreachable        a tools_must pattern no tool of the case's arm matches (the case can never pass there), unless `blocked`
 *   assistant-only     one only the assistant's own tools match, on a case that also runs in baseline: it needs modes ["assistant"]
 *   descriptive-value  a static or fixture value that is a description: it belongs in the rubric
 * Notes (said, not failed): blocked (with its reason), judge-only (a fact no oracle can read), needs-vars (skipped without them).
 */
export function staticFindings(cases: readonly EvalCase[], arms: Arms, vars: Vars = {}): { problems: CaseFinding[]; notes: CaseFinding[] } {
  const problems: CaseFinding[] = [];
  const notes: CaseFinding[] = [];
  for (const c of cases) {
    for (const { arm, allow } of armsOf(c, arms)) {
      for (const p of c.tools_must ?? []) {
        if (reachable(p, allow)) continue;
        const assistantOnly = arm === "baseline" && reachable(p, arms.router) && p.split("|").every((a) => a.trim().startsWith("mcp__assistant__"));
        if (assistantOnly) problems.push({ id: c.id, kind: "assistant-only", detail: `${p}: only the assistant has it; set modes ["assistant"]` });
        else if (c.blocked) notes.push({ id: c.id, kind: "blocked", detail: `${p} on ${arm}: ${c.blocked}` });
        else problems.push({ id: c.id, kind: "unreachable", detail: `${p} on ${arm}` });
      }
    }
    for (const f of c.facts ?? []) {
      const o = f.oracle;
      if (o && o.kind !== "api" && o.value !== undefined && descriptiveValue(o.value)) problems.push({ id: c.id, kind: "descriptive-value", detail: `${f.claim}`.slice(0, 80) });
      // Runnable once its placeholders are filled, whatever they are filled with.
      else if (o?.kind === "api" && !oracleQuery({ ...o, query: (o.query ?? "").replace(PLACEHOLDER, "x") })) {
        notes.push({ id: c.id, kind: "judge-only", detail: `${f.claim}`.slice(0, 80) });
      }
    }
    if (c.blocked && armsOf(c, arms).every(({ allow }) => (c.tools_must ?? []).every((p) => reachable(p, allow)))) {
      notes.push({ id: c.id, kind: "blocked", detail: `reachable now on every arm: drop "blocked" (${c.blocked})` });
    }
    const missing = missingVars(c, vars);
    if (missing.length) notes.push({ id: c.id, kind: "needs-vars", detail: missing.join(", ") });
  }
  return { problems, notes };
}
