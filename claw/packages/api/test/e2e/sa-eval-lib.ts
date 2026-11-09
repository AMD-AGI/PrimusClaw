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
 *   turns            [{user, after_ms, files?}]                         one or more user messages; after_ms from the first; files
 *                    [{fixture, name?, media_type?}] are sent with the message as a channel sends them (uploaded to the assistant's
 *                    session, named in channel_context.files); fixture is a path relative to the cases directory
 *   route            answer | item | review | confirm | clarify         expected handling of the last turn
 *   tools_must       tool names the last turn must each call; `*` matches anything, `a|b` either
 *   tools_must_not   tool names the last turn must not call (read-only questions list work_create)
 *   said             true: the last turn must have answered with a message of its own: a say of the router's, or the plain text it
 *                    ended with, which the server says for it (`deliverUnsaidAnswer`). The system's own lines never count: the "on it"
 *                    line (`turnAckSayId`) and its notice for a turn that failed, was declined or said nothing (`SYSTEM_TURN_NOTICES`).
 *   facts            [{claim, oracle: {kind: static|api|fixture, value?, query?}}]; the final answer must name the value.
 *                    An `api` oracle is read at run time with the eval identity, in one of three forms (`oracleQuery`):
 *                      `/v1/...#<pick>`                a Claw API GET, e.g. `/v1/work-items?state=in_progress#data.length`
 *                      `gh:/...#<pick>`                a GitHub REST GET, e.g. `gh:/search/issues?q=is:pr+author:{EVAL_GH_LOGIN}#total_count`
 *                      `mcp:<server>/<tool>?k=v#<pick>` a read tool of the plugin's MCP server, e.g. `mcp:safe/node_get?name=n1#phase`
 *                      `ghql:<query>#<pick>`           a read-only GitHub GraphQL query (a review thread's state is only there)
 *                    A pick may be followed by `|`-separated steps (`ORACLE_STEPS`): `where:<path>=<v>` (or `!=`) keeps the picked
 *                    elements whose field is (not) v (`~<re>` / `!~<re>`: matches a regex, `\|` for its alternation), `get:<path>` picks
 *                    within each, `sort:<path>` (`-<path>` descending), `first` and `take:<n>` keep the first ones, `count` is how many
 *                    there are, `b64` decodes (a file's content), `match:<re>`
 *                    takes a regex's first group (or the match), `map:<from>=<to>;...` says a value in words (`true=merged`), and
 *                    `empty:<text>` stands for an empty list (`empty:none||没有`). A value with `||` is named when any one of its
 *                    alternatives is.
 *                    A static or fixture value is a value to find in the answer (a number, a name); a description of what
 *                    the answer should say belongs in the rubric. A fact without a value or a runnable query is graded by the
 *                    judge, with the oracle's text as what it is checked against.
 *   cards            none | accept | confirm                            what the user may be shown to press in the last turn
 *   style            {reply_lang: follow_user, max_chars, min_chars, no_ids}   min_chars: the final answer is at least that long (whole)
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
 * runner answers it as the person's channel does, see {@link HoldSpec}), `setup` (assistant mode: what the identity must have before each
 * attempt, made by the runner through the API and removed after it; `triggers`: [{name, schedule, timezone, prompt?, action?}], made with
 * `POST /v1/triggers`, see {@link CaseSetup}), `delivers` ([{name?, type?}]: files the last turn's
 * items must hand the user, each matched by a name pattern and a media type prefix, from the files the assistant's messages
 * carry). A case with files runs on the assistant path only.
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

export interface TurnFile { fixture: string; name?: string; media_type?: string }
export interface Turn { user: string; after_ms?: number; files?: TurnFile[] }
export interface Delivers { name?: string; type?: string }
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
  said?: boolean;
  facts?: Fact[];
  cards?: Cards;
  style?: { reply_lang?: "follow_user"; max_chars?: number; min_chars?: number; no_ids?: boolean };
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
  setup?: CaseSetup;
  delivers?: Delivers[];
}

/**
 * What the identity must already have when an attempt of the case starts (a scheduled task the user asks to cancel), made by the runner
 * through the API before every attempt and removed after it. `triggers` are made with `POST /v1/triggers` (`action` run, the default, or
 * brief); a name the identity already has a trigger under makes the attempt an error, never a second trigger the case did not mean.
 */
export interface SetupTrigger { name: string; schedule: string; timezone: string; prompt?: string; action?: "run" | "brief" }
export interface CaseSetup { triggers?: SetupTrigger[] }
/** The most triggers a case's setup makes (the server's own cap per user is higher; a case needs one or two). */
export const SETUP_TRIGGERS_MAX = 5;

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
  for (const f of (Array.isArray(c.turns) ? c.turns : []).flatMap((t) => t?.files ?? [])) {
    if (typeof f?.fixture !== "string" || !f.fixture || f.fixture.startsWith("/") || f.fixture.split("/").includes("..")) {
      out.push(`a file without a fixture inside the cases directory (${String(f?.fixture)})`);
    }
  }
  if (c.delivers !== undefined && (!Array.isArray(c.delivers) || c.delivers.some((d) => !d || (typeof d.name !== "string" && typeof d.type !== "string")))) {
    out.push("delivers needs a name or a type for each file");
  }
  if (c.said !== undefined && typeof c.said !== "boolean") out.push(`said ${String(c.said)}`);
  if (c.route !== undefined && !ROUTES.includes(c.route)) out.push(`route ${c.route}`);
  if (c.cards !== undefined && !CARDS.includes(c.cards)) out.push(`cards ${c.cards}`);
  if (c.hold !== undefined) {
    const h = c.hold as Partial<HoldSpec>;
    if (typeof h.tool !== "string" || !h.tool) out.push("hold without a tool");
    if (!["allow", "deny", "answer"].includes(String(h.decide))) out.push(`hold decide ${h.decide}`);
    if (h.decide === "answer" && (!h.answers || typeof h.answers !== "object" || !Object.keys(h.answers).length)) out.push("hold answer without answers");
    if (h.wait_s !== undefined && !(Number.isInteger(h.wait_s) && h.wait_s >= 0 && h.wait_s <= 7200)) out.push(`hold wait_s ${h.wait_s}`);
  }
  if (c.setup !== undefined) out.push(...setupProblems(c.setup));
  return out;
}

function setupProblems(setup: unknown): string[] {
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) return ["setup is not an object"];
  const out: string[] = [];
  const { triggers, ...rest } = setup as CaseSetup & Record<string, unknown>;
  if (Object.keys(rest).length) out.push(`setup ${Object.keys(rest).join(",")} unknown`);
  if (triggers === undefined) return out;
  if (!Array.isArray(triggers) || !triggers.length || triggers.length > SETUP_TRIGGERS_MAX) return [...out, `setup triggers is a list of 1 to ${SETUP_TRIGGERS_MAX}`];
  const names = new Set<string>();
  for (const t of triggers as Array<Partial<SetupTrigger>>) {
    const str = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
    if (!str(t?.name) || !str(t?.schedule) || !str(t?.timezone)) out.push("a setup trigger without a name, schedule and timezone");
    else if (names.has(t.name!.trim())) out.push(`setup trigger ${t.name} twice`);
    else names.add(t.name!.trim());
    if (t?.prompt !== undefined && !str(t.prompt)) out.push("a setup trigger with an empty prompt");
    if (t?.action !== undefined && t.action !== "run" && t.action !== "brief") out.push(`setup trigger action ${String(t.action)}`);
    if (t?.action !== "brief" && t?.prompt === undefined) out.push(`setup trigger ${String(t?.name)} runs nothing: a run trigger needs a prompt`);
  }
  return out;
}

/** The body of `POST /v1/triggers` for a setup trigger. */
export function setupTriggerBody(t: SetupTrigger): Record<string, unknown> {
  return { name: t.name.trim(), schedule: t.schedule.trim(), timezone: t.timezone, action: t.action ?? "run", ...(t.prompt !== undefined ? { prompt: t.prompt } : {}) };
}

/**
 * EVAL_FRESH_SESSION_EVERY: a number of cases per assistant session (0: one for the run), or `attempt`: every attempt (and the second
 * try of one) in a new session, with the cards waiting from before closed first where they can be (`closableCards`). Null when it is
 * neither.
 */
export function freshSessionEvery(raw: string | undefined): { cases: number; attempt: boolean } | null {
  const v = (raw ?? "").trim();
  if (v === "attempt") return { cases: 1, attempt: true };
  if (v === "") return { cases: 0, attempt: false };
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? { cases: n, attempt: false } : null;
}

/**
 * A card waiting for the identity's answer: a write held on a card by the assistant (`GET /v1/assistant/confirmations`: a scheduled
 * task, a comment, an instruction for a machine) or a held GitHub write of a review (`GET /v1/github-review/confirmations`). The
 * assistant is shown every one of them, in every conversation of the identity, until it is answered or lapses (a day): a case that
 * asks for the same write again is answered with "it is already waiting", and shows no card.
 */
export interface WaitingCard { id: string; kind: string; source: "assistant" | "github" }

/** The cards of the two listings' bodies (`data` of the assistant's, `data.items` or `items` of the review's); what is not a list is none. */
export function waitingCards(assistantBody: unknown, githubBody: unknown): WaitingCard[] {
  const out: WaitingCard[] = [];
  const a = (assistantBody as { data?: unknown } | null)?.data;
  for (const c of Array.isArray(a) ? a : []) {
    if (typeof c?.confirmation_id === "string" && c.confirmation_id) out.push({ id: c.confirmation_id, kind: String(c.kind ?? ""), source: "assistant" });
  }
  const g = githubBody as { data?: { items?: unknown }; items?: unknown } | null;
  const items = Array.isArray(g?.data?.items) ? g!.data!.items as unknown[] : Array.isArray(g?.items) ? g!.items as unknown[] : [];
  for (const c of items as Array<Record<string, unknown>>) {
    if (typeof c?.id === "string" && c.id && (c.status === undefined || c.status === "pending")) out.push({ id: c.id, kind: String(c.kind ?? ""), source: "github" });
  }
  return out;
}

/**
 * Why an attempt is not graded on its cards, or null: the case expects a card, and a card an earlier attempt of the same case made (`own`:
 * the cards that appeared during those attempts) is still waiting. The assistant then says that write is already waiting and shows none,
 * so a miss would be the run's, not the assistant's. Every other card waiting (another case's, one from before the run) is said
 * (`cardsWaiting`) but not held against the attempt: the assistant still proposes a different write while one waits.
 */
export function cardsLeftError(c: Pick<EvalCase, "cards">, waiting: readonly WaitingCard[], own: ReadonlySet<string>): string | null {
  if (c.cards !== "confirm" && c.cards !== "accept") return null;
  const left = waiting.filter((w) => own.has(w.id));
  if (!left.length) return null;
  const kinds = [...new Set(left.map((w) => w.kind || w.source))].join(",");
  return `infra: ${left.length} card(s) an earlier attempt of this case left waiting (${kinds}) could not be closed before this one `
    + "(closing one is the person's answer: EVAL_SEND_TOKEN_CMD), so the assistant is shown them: not graded";
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
 * Whether the held call ran after its answer: a result of that very call (the same id) that the tool itself answered, whether it
 * worked ("success") or its tool answered an error (Brain's "error" with `is_error`). A denied call ends with Brain's `decisionResult`
 * and, at most, an error result without `is_error`. Null while neither has happened.
 */
export function heldCallRan(rows: readonly EventRow[], toolUseId: string): boolean | null {
  let ended = false;
  for (const r of rows) {
    const d = r.data ?? {};
    const type = d.type ?? r.event_type;
    if (type === "toolUsed" && d.actionId === toolUseId && d.status !== "start") {
      if (d.status === "success" || (d.status === "error" && d.is_error === true)) return true;
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
  // A run variable set to no value (a null read just now, `flatVars`) is no value: EVAL_VAR_<NAME> does not stand in for it.
  const v = run && !Object.hasOwn(vars, name) ? vars[envName(name)] : vars[name];
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

/**
 * A JSON object's values as run variables: nested objects give `a.b`. A null is no value, and is kept as one: merged over earlier
 * variables it takes theirs away, so a value that could not be read now is never graded with one read before.
 */
export function flatVars(json: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const flat = (o: unknown, at: string): void => {
    if (o !== null && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flat(v, at ? `${at}.${k}` : k);
    else if (at) out[at] = o === null || o === undefined ? undefined : String(o);
  };
  flat(json, "");
  return out;
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
export function apiQuery(o: Oracle | undefined): { path: string; at: string; steps?: string[] } | null {
  const m = o?.kind === "api" ? /^(\/v1\/[^#\s]*)#(.+)$/s.exec((o.query ?? "").trim()) : null;
  const tail = m ? pickAndSteps(m[2]!) : null;
  return m && tail ? { path: m[1]!, ...tail } : null;
}

/** An `api` oracle this runner can read at run time, by where it reads (see the case format above). */
export type OracleQuery = (
  | { via: "claw"; path: string; at: string }
  | { via: "github"; path: string; at: string }
  | { via: "github-graphql"; query: string; at: string }
  | { via: "mcp"; server: string; tool: string; args: Record<string, unknown>; at: string }
) & { steps?: string[] };

/**
 * The steps an oracle's pick may be followed by (`#<pick>|step|step`), in order, over what was picked. Each one either keeps some
 * of the values or turns them into others; a step this runner does not know makes the oracle one it cannot run.
 */
export const ORACLE_STEPS = /^(?:count|first|b64|get:\S+|sort:-?\S+|take:\d+|where:[^=!~]+(?:!?=|!?~).*|match:.+|map:.+|empty:.+)$/s;

/** `#<pick>` and its `|` steps, split; null when a step is not one of `ORACLE_STEPS`. */
function pickAndSteps(tail: string): { at: string; steps?: string[] } | null {
  // A single `|` separates steps; `||` inside one (alternatives of a word: `map:true=merged||已合并`) belongs to it, and so does `\|`
  // (an alternation in a regex: `where:title~行数\|line`).
  const [at, ...steps] = tail.split(/(?<![|\\])\|(?!\|)/).map((x) => x.replace(/\\\|/g, "|"));
  if (!at || /\s/.test(at) || !steps.every((x) => ORACLE_STEPS.test(x))) return null;
  return steps.length ? { at, steps } : { at };
}

/** The read an `api` oracle names, or null for one this runner cannot run (a description, or a placeholder not filled). */
export function oracleQuery(o: Oracle | undefined): OracleQuery | null {
  if (o?.kind !== "api") return null;
  const q = (o.query ?? "").trim();
  if (HAS_PLACEHOLDER.test(q)) return null;
  const claw = apiQuery(o);
  if (claw) return { via: "claw", ...claw };
  const gh = /^gh:(\/[^#\s]*)#(.+)$/s.exec(q);
  if (gh) { const t = pickAndSteps(gh[2]!); return t ? { via: "github", path: gh[1]!, ...t } : null; }
  // A query only: a mutation is never sent (`githubReadOnlyQuery`).
  const ql = /^ghql:([^#]+)#(.+)$/s.exec(q);
  if (ql) { const t = pickAndSteps(ql[2]!); return t && githubReadOnlyQuery(ql[1]!) ? { via: "github-graphql", query: ql[1]!.trim(), ...t } : null; }
  const mcp = /^mcp:([a-z0-9][a-z0-9_-]*)\/([A-Za-z0-9_]+)(?:\?([^#\s]*))?#(.+)$/s.exec(q);
  const mcpTail = mcp ? pickAndSteps(mcp[4]!) : null;
  if (!mcp || !mcpTail) return null;
  const args: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(mcp[3] ?? "")) {
    // A number, a boolean or null as itself; anything else as the text it is.
    args[k] = /^(-?\d+(\.\d+)?|true|false|null)$/.test(v) ? JSON.parse(v) : v;
  }
  return { via: "mcp", server: mcp[1]!, tool: mcp[2]!, args, ...mcpTail };
}

/** A GraphQL document that is one query: no mutation or subscription, whatever it is named. */
export const githubReadOnlyQuery = (q: string): boolean => {
  const t = q.trim();
  return /^(query\b[^{]*)?\{/.test(t) && !/\b(mutation|subscription)\b/.test(t);
};

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
  return pickValues(json, path).map(text);
}

const text = (v: unknown): string => (typeof v === "object" ? JSON.stringify(v) : String(v));

/** An oracle's values: its pick, then its steps (`ORACLE_STEPS`) in order. */
export function oracleValues(json: unknown, q: Pick<OracleQuery, "at" | "steps">): string[] {
  let cur = pickValues(json, q.at);
  for (const step of q.steps ?? []) {
    const [op, ...rest] = step.split(":");
    const arg = rest.join(":");
    if (op === "count") cur = [cur.length];
    else if (op === "first") cur = cur.slice(0, 1);
    else if (op === "take") cur = cur.slice(0, Number(arg));
    else if (op === "get") cur = cur.flatMap((v) => pickValues(v, arg));
    else if (op === "sort") {
      // By a field, ascending (`sort:-field` descending); numbers as numbers, anything else as text.
      const desc = arg.startsWith("-");
      const key = (v: unknown): string | number => { const x = pickValues(v, desc ? arg.slice(1) : arg)[0]; return typeof x === "number" ? x : text(x ?? ""); };
      cur = [...cur].sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return desc ? -c : c; });
    }
    else if (op === "b64") cur = cur.map((v) => Buffer.from(String(v).replace(/\s+/g, ""), "base64").toString("utf8"));
    else if (op === "where") {
      // `field=v` / `field!=v` compare the text; `field~re` / `field!~re` test a regex, case-insensitive.
      const m = /^([^=!~]+)(!?)([=~])(.*)$/s.exec(arg)!;
      const [field, not, op2, want] = [m[1]!.trim(), m[2] === "!", m[3], m[4]!];
      const re = op2 === "~" ? new RegExp(want, "i") : null;
      cur = cur.filter((v) => pickValues(v, field).map(text).some((x) => (re ? re.test(x) : x === want)) !== not);
    } else if (op === "match") {
      const re = new RegExp(arg, "m");
      cur = cur.flatMap((v) => { const m = re.exec(text(v)); return m ? [m[1] ?? m[0]] : []; });
    } else if (op === "map") {
      const table = new Map(arg.split(";").map((pair) => { const i = pair.indexOf("="); return [pair.slice(0, i).trim(), pair.slice(i + 1)] as const; }));
      cur = cur.map((v) => table.get(text(v)) ?? v);
    } else if (op === "empty") {
      if (!cur.length) cur = [arg];
    }
  }
  return cur.map(text);
}

function pickValues(json: unknown, path: string): unknown[] {
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
  return cur;
}

/** Does the answer name the value? Case-insensitive, spaces ignored; a number must stand on its own (12 is not 120). */
export function names(answer: string, value: string): boolean {
  if (value.includes("||")) return value.split("||").some((alt) => names(answer, alt));
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
  // Not a sandbox workload's name (`claw-<ms>-sandbox`), which SaFE lists among the person's own workloads.
  ["claw message id", /\bclaw-(pending-)?\d+\b(?!-sandbox)/],
  // The prompt's own tags, or the assistant speaking of its own prompt; "system prompt" as a subject (what one is, how a model
  // server takes one) is not a leak.
  ["prompt leak", /\b(?:my|the assistant's)\s+system\s+prompt\b|我的系统提示词?|<\/?(system|tool_result|function_calls)>/i],
];
/**
 * An answer in which the assistant says that it itself cannot reach something: it cannot access, read, browse or query a
 * system, has no permission or no tool for it, cannot get on the internet. Said of itself, so a fact about a system ("the node
 * cannot be reached") is not one. Whether it was false is what the tools say: a denial with no failed call in the turn is one
 * (`grade`); a case where refusing is right says `may_deny`.
 */
export const CAPABILITY_DENIAL = new RegExp([
  "我(目前|现在|暂时|这边|这里)?(还)?(无法|不能|没法|没办法|不可以)(直接)?(访问|读取|查看|查询|获取|连接|联网|上网|浏览|打开|拿到)(?![^，。！？,.!?]{0,16}?(是否|有没有))",
  "我(这边|这里)?(访问|读取|查询|连接|读|查|看)不了", "我(这边|这里)?(访问|连接|拿)不到",
  "我(这边|这里)?(看不到|看不见|没法看|无法看到?)(你的)?\\s*(GitHub|github|仓库|代码库|PR|拉取请求|SaFE|safe|集群|节点|Dispatron|Autopilot|Pulse|网页|看板)",
  "我(这边|这里)?(没有|无)[^，。,.!！?？\\n]{0,12}?(工具|能力|接口|权限)",
  "(无法|不能|没法)(联网|上网)", "没有(联网|上网)(能力|功能|工具)",
  "\\bI(?: am|'m)? (?:currently |still )?(?:can(?:'|’)?t|cannot|can not|unable to|not able to)(?: directly)? (?:access|read|browse|reach|connect to|query|look up|fetch|check|open|get to)\\b"
    // "I can't check whether there are more PRs beyond this page" is a caveat about what it read, not an inability.
    + "(?!\\s+(?:[^\\s,.;:!?]+\\s+){0,6}?(?:whether|if)\\b)",
  // "see" and "view" only of a system or the user's data, named within a few words: "I can't see any failed runs" is an answer.
  "\\bI(?: am|'m)? (?:currently |still )?(?:can(?:'|’)?t|cannot|can not|unable to|not able to)(?: directly)? (?:see|view) (?!(?:any|anything|no|a single)\\b)(?:[^\\s.!?。，,]+ ){0,6}?"
    + "(?:github\\b|repos?\\b|repositor(?:y|ies)\\b|PRs?\\b|pull requests?\\b|safe\\b|workloads?\\b|clusters?\\b|dispatron\\b|autopilot\\b|pulse\\b|"
    + "(?:the )?web\\b|web ?pages?\\b|internet\\b|(?:the )?board\\b)",
  "\\bI (?:don(?:'|’)?t|do not)(?: (?:currently|yet|really|actually))? have (?:any )?(?:access|permission|internet|web access|a tool|the tools?|tools?)\\b",
  "\\bI have no (?:access|internet|web access|tools?)\\b",
].join("|"), "i");

/**
 * The systems a denial can name, and which failed call reaches each: an MCP server's tool, Brain's web tools, or a shell command that
 * failed at GitHub (`shellFailedAtGithub`; a failed `python x.py` is not a failed GitHub call).
 */
const DENIED_SYSTEMS: ReadonlyArray<[RegExp, (c: ToolCall) => boolean]> = [
  [/github|\bgh\b|pull request|\bPRs?\b|仓库|代码库/i, (c) => /^mcp__github__/.test(c.name)
    || (/^bash$/i.test(c.name) && shellFailedAtGithub(c.result))
    // A page or search of GitHub through the web tools.
    || (/^(web_fetch|web_search)$/.test(c.name) && /github/i.test(JSON.stringify(c.input ?? {})))],
  [/联网|上网|互联网|网页|网站|internet|\bweb\b|browse|online/i, (c) => /^(web_search|web_fetch)$/.test(c.name)],
  [/safe|workloads?|workspaces?|集群|cluster|节点|\bnodes?\b/i, (c) => /^mcp__safe__/.test(c.name)],
  [/dispatron|计划|\bplans?\b/i, (c) => /^mcp__dispatron__/.test(c.name)],
  [/autopilot/i, (c) => /^mcp__autopilot__/.test(c.name)],
  [/pulse|leaderboard|排行/i, (c) => /^mcp__pulse__/.test(c.name)],
  [/看板|\bboard\b|\bissues?\b/i, (c) => /^mcp__agent-board__/.test(c.name)],
];

/**
 * Whether a failed shell call failed at GitHub: one line of what it answered is a failure that names GitHub (`fatal: unable to
 * access 'https://github.com/…'`, `remote: Repository not found` beside a github.com URL, `HTTP 401: Bad credentials
 * (https://api.github.com/…)`, gh's `gh: …` errors, GitHub's JSON error with docs.github.com), whatever program reached it (gh,
 * git, curl, a Python or Node script). That line is the evidence a remote operation was tried and failed; a GitHub URL printed by
 * a local command (`git remote -v`) beside another command's failure, a local `git status` that failed, or text that only
 * mentions git, are not.
 */
export function shellFailedAtGithub(answer: string): boolean {
  return answer.split("\n").some((line) => GITHUB_NAMED.test(line) && GITHUB_FAILED.test(line));
}
const GITHUB_NAMED = /github\.com|api\.github|github cli|gh auth|^\s*gh:/i;
// A failure: an error word, an HTTP 4xx/5xx, or GitHub's own error body (it always carries a docs.github.com documentation_url).
const GITHUB_FAILED = /\b(fatal|error|denied|not found|unable|could not|failed|forbidden|unauthori[sz]ed|bad credentials|rate limit|HTTP [45]\d\d)\b|"documentation_url"\s*:\s*"https:\/\/docs\.github\.com/i;

/**
 * Every denial in `final` that the turn's calls do not make true, as the words that said it ([] when there is none). A denial may
 * be true only when a call of the turn failed; when its sentence names systems (GitHub, the web, SaFE, ...), each one it names
 * needs a failed call of its own, so a failure of one system never excuses denying another; a denial that names none is taken as
 * being about whichever call failed. Every denial is checked, not only the first.
 */
export function falseDenials(final: string, calls: readonly ToolCall[], request = ""): string[] {
  const failed = calls.filter((x) => x.ok === false);
  const sentences = [...final.matchAll(/[^。！？!?\n]+?(?:[。！？!?\n]|\.(?=\s|$)|$)/g)].map((m) => ({ at: m.index!, text: m[0] }));
  const sentenceAt = (at: number): string => sentences.find((x) => at >= x.at && at < x.at + x.text.length)?.text ?? final;
  const systemsOf = (sentence: string) => DENIED_SYSTEMS.filter(([words]) => words.test(sentence)).map(([, reaches]) => reaches);
  const out: string[] = [];
  const seen = new Set<number>();
  const judge = (at: number, words: string, needsSystem: boolean): void => {
    // The clause of the denial, not the whole sentence: "I found two PRs on GitHub, but I can't access SaFE" denies SaFE only.
    const whole = sentenceAt(at);
    const offset = at - (sentences.find((x) => at >= x.at && at < x.at + x.text.length)?.at ?? 0);
    const cuts = [...whole.matchAll(/[;；，,]|\b(?:but|however|although|though|while)\b|但是|但|不过|可是/gi)].map((m) => m.index!);
    const from = Math.max(0, ...cuts.filter((i) => i <= offset));
    const to = Math.min(whole.length, ...cuts.filter((i) => i > offset));
    const clause = whole.slice(from, to);
    const sentence = systemsOf(clause).length ? clause : whole;
    // A denial that names nothing ("I can't access it right now", "I'm not connected to it") is about what the user asked for,
    // when the request names it.
    const named = systemsOf(sentence).length ? systemsOf(sentence) : systemsOf(request);
    if (needsSystem && !named.length) return;   // "I can't …" of nothing it or the request names: an answer, not a denial
    if (needsSystem && CONSENT.test(sentence)) return;   // "I can't delete it on SaFE without your approval": the approval flow
    const start = sentences.find((x) => at >= x.at && at < x.at + x.text.length)?.at ?? -1;
    if (seen.has(start) && needsSystem) return;  // one denial per sentence is enough to grade it
    seen.add(start);
    const justified = failed.length > 0 && (named.length === 0 || named.every((reaches) => failed.some(reaches)));
    if (!justified) out.push(words);
  };
  for (const m of final.matchAll(new RegExp(CAPABILITY_DENIAL.source, "gi"))) judge(m.index!, m[0], false);
  for (const m of final.matchAll(new RegExp(SELF_INABILITY.source, "gi"))) judge(m.index!, m[0], true);
  return out;
}

/** A sentence about waiting for the person's yes, which is how a write goes, not an inability. */
const CONSENT = /approv|confirm|your (?:go-ahead|ok|permission|consent)|批准|确认|同意/i;

/**
 * Broader than CAPABILITY_DENIAL, and only a denial in a sentence that names a system (`DENIED_SYSTEMS`): the assistant says that
 * it itself is not connected, set up or allowed, or cannot or has no way to do something ("I'm not connected to GitHub, so I can't
 * pull the open PRs", "我连不上 GitHub"). "I can't find any…" and "I can't see any failed runs" are answers about what it looked
 * at, not inabilities, and are left out.
 */
export const SELF_INABILITY = new RegExp([
  "\\bI(?:'m|’m| am)? (?:currently |still |really |actually )?(?:not (?:currently |yet )?(?:connected|able|allowed|authori[sz]ed|set up|linked|integrated|signed in|logged in|permitted)"
    + "|unable|can(?:'|’)?t|cannot|can not|have no (?:access|way|tools?|integration|connection)"
    + "|(?:don(?:'|’)?t|do not)(?: (?:currently|yet|really|actually))? have (?:access|permission|a way|the ability|any (?:access|tools?|way)|tools?|an? (?:integration|connection)))\\b"
    // What it could not conclude or promise about what it did read is an answer, not an inability.
    + "(?!\\s+(?:[^\\s,.;:!?]+\\s+){0,6}?(?:whether|if)\\b)"
    + "(?!\\s+(?:to\\s+)?(?:find|locate|spot|tell|say|confirm|verify|determine|know|see any|see a|recall|remember|rule out|exclude|guarantee|promise|"
    + "be (?:sure|certain)|predict|estimate|explain|reproduce))",
  "我(目前|现在|暂时|这边|这里)?(还)?(连不上|接不上|没有接入|没接入|未接入|没有连接|没连接|未连接|没有权限|没权限)",
].join("|"), "i");

/** With `style.no_ids`: an item named only by its number ("编号 #178", "#178。") rather than by its title. */
export const BARE_NUMBER = /编号\s*#?\d+|#\d+(?=\s*($|[，。、,.;；:：)）!！?？]))/m;

/**
 * What says a number is not one of the person's items: a pull request, an issue, a CI run, a board topic, a plan or job, or
 * `owner/repo#n`, earlier in the same clause ("PR #294、#296", "the last pull request was #306"), with no item named after it.
 */
const NOT_AN_ITEM = /\b(?:PRs?|pull requests?|pulls?|issues?|runs?|topics?|jobs?|builds?|plans?|workflows?)\b|[\w.-]+\/[\w.-]+$|拉取请求|合并请求|议题|话题|主题|运行|作业|构建|流水线/gi;
const AN_ITEM = /\b(?:items?|tasks?)\b|事项|任务/i;

/** A line that is an entry of a list: led by a bullet ("- ", "* ", "• "), an ordinal ("1. ", "2、") or a number ("#294 ..."). */
const LIST_ENTRY = /^\s*(?:[-*•·]\s+|\d+[.)、]\s*|#\d+)/;
const LIST_HEADING = /^\s*#{1,6}\s|[:：][\s*_`]*$/;
/** The start of a list entry's line up to its number: nothing, or only its bullet or ordinal. */
const ENTRY_START = /^\s*(?:[-*•·]\s+|\d+[.)、]\s*)?$/;

/**
 * The heading of the list whose entry starts with the number at `at`: the first line above it that is neither an entry nor
 * blank, when that line is a heading (`LIST_HEADING`); null otherwise. In "开着的 PR：\n- #294\n- #296" both numbers are
 * entries of a list of pull requests.
 */
function listHeading(text: string, at: number): string | null {
  const lines = text.slice(0, at).split("\n");
  if (!ENTRY_START.test(lines.pop() ?? "")) return null;
  for (let k = lines.length - 1, seen = 0; k >= 0 && seen < 40; k--, seen++) {
    if (!lines[k]!.trim() || LIST_ENTRY.test(lines[k]!)) continue;
    // A heading introduces its list: it ends with a colon, or is a markdown heading. Any other line ends the list above it.
    return LIST_HEADING.test(lines[k]!) ? lines[k]! : null;
  }
  return null;
}

/** Whether a clause says a number after it is something else's (`NOT_AN_ITEM`), with no item named after that. */
const namesOther = (clause: string): boolean => {
  const other = [...clause.matchAll(NOT_AN_ITEM)].at(-1);
  return !!other && !AN_ITEM.test(clause.slice(other.index! + other[0].length));
};

/**
 * Whether the text names `#n` elsewhere as something else's number: `owner/repo#n`, or right after a pull request or issue
 * ("PR #291", "pull request #291", "议题 #3"). "Review AMD-AGI/PrimusClaw#291 … review-only of #291" speaks of one pull request.
 */
const namedAsOtherElsewhere = (text: string, n: string): boolean =>
  new RegExp(`(?:[\\w.-]+\\/[\\w.-]+|\\b(?:PRs?|pull requests?|pulls?|issues?)\\s*|(?:拉取请求|合并请求|议题)\\s*)#${n}(?!\\d)`, "i").test(text);

/**
 * The first item named only by its number (`BARE_NUMBER`) that is not something else's number (`NOT_AN_ITEM` earlier in its
 * clause, or in the heading of the list it is an entry of, or the same number named elsewhere in the text as a pull request's
 * or an issue's, or, given `seqMax` (the highest item number on the person's board), a number above it); null when none is.
 */
export function bareItemNumber(text: string, seqMax?: number): string | null {
  const re = new RegExp(BARE_NUMBER.source, "gm");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].startsWith("编号")) return m[0];
    // Item numbers count up per person: one above the highest on their board is no item of theirs (an upstream PR, #48043).
    if (seqMax && Number(m[0].match(/\d+/)![0]) > seqMax) continue;
    const clause = text.slice(Math.max(0, m.index - 120), m.index).split(/[。!！?？\n;；]|\.\s/).at(-1) ?? "";
    if (namesOther(clause)) continue;
    const heading = listHeading(text, m.index);
    if (heading !== null && namesOther(heading)) continue;
    if (namedAsOtherElsewhere(text, m[0].slice(1).match(/\d+/)![0])) continue;
    return m[0];
  }
  return null;
}

/**
 * A GitHub read's failure as the router's GitHub tools word it (`github-mcp/tools.ts`, `readFailure`). Brain records such a result
 * as a success, so a failed read would look like one that answered, and a reply that it could not read would look unexplained.
 */
export const GITHUB_READ_FAILURE = /^(?:GitHub answered \d{3}\b|GitHub could not be reached|GitHub refused the request|the call failed; try once more)/;

/** The calls, with a GitHub read that answered its failure (`GITHUB_READ_FAILURE`) counted as failed. */
export const withToolFailures = (calls: readonly ToolCall[]): ToolCall[] => calls.map((c) =>
  (c.ok === true && /(^|__)github__/.test(c.name) && GITHUB_READ_FAILURE.test(c.result.trim()) ? { ...c, ok: false } : c));

/** One event of a session as it arrived on the live stream (`at`: when this runner received it). */
export interface LiveEvent { at: number; eventId: string; data: Record<string, any> }

export interface SaidFile { name: string; content_type: string; item_id: string | null }

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
  /** The files the message hands the user (a worker's deliveries), with the item whose worker delivered each. */
  files: SaidFile[];
}

export const saysOf = (events: readonly LiveEvent[]): Say[] => events
  .filter((e) => e.data?.type === "AssistantSay")
  .map((e) => ({
    at: e.at, sayId: String(e.data.say_id ?? e.eventId), turn: String(e.data.turn_message_id ?? ""), text: String(e.data.text ?? ""),
    itemId: e.data.item?.item_id ? String(e.data.item.item_id) : null,
    itemState: e.data.item?.board_state ? String(e.data.item.board_state) : null,
    canAccept: e.data.item?.can_accept === true,
    // A card the person presses: a channel's command to run (`confirm_action`), a write the router proposed (`confirm_write`), or a
    // write an item's worker holds for them (`held_write`, on the message saying the item needs them).
    confirm: !!e.data.confirm_action || !!e.data.confirm_write || !!e.data.held_write,
    fallback: e.data.fallback === true,
    files: (Array.isArray(e.data.files) ? e.data.files : []).filter((f: any) => f && typeof f.name === "string").map((f: any) => ({
      name: String(f.name), content_type: String(f.content_type ?? ""), item_id: typeof f.item_id === "string" ? f.item_id : null,
    })),
  }));

/** The files the user was handed by these items' messages, in order. */
export const filesFrom = (says: readonly Say[], itemIds: readonly string[]): SaidFile[] =>
  says.flatMap((s) => s.files).filter((f) => f.item_id !== null && itemIds.includes(f.item_id));

/** The tool calls of the turns that answered these messages (live events carry the turn's message id). */
export function turnCalls(events: readonly LiveEvent[], messageIds: readonly string[]): ToolCall[] {
  const ids = new Set(messageIds);
  const rows: EventRow[] = events
    .filter((e) => ids.has(String(e.data?.message_id ?? "")))
    .map((e) => ({ event_type: String(e.data.type ?? ""), created_at: new Date(e.at).toISOString(), data: e.data }));
  return withToolFailures(traceOf(rows).calls);
}

/** The tool calls of these turns in stored events (`?mode=replay`), as `turnCalls` reads them from a stream. */
export function storedTurnCalls(rows: readonly EventRow[], messageIds: readonly string[]): ToolCall[] {
  const ids = new Set(messageIds);
  return withToolFailures(traceOf(rows.filter((r) => ids.has(String(r.data?.message_id ?? "")))).calls);
}

/**
 * An event that closes its turn. The API never forwards `exec_complete` to a live stream (`routes/events.ts`), so there a turn
 * ends with its main agent's `executionStats` (it finished) or its `statusUpdate` to failed; a replay has `exec_complete` as well.
 * A sub-agent's events close nothing.
 */
export const endsTurn = (d: Record<string, any> | undefined): boolean => !!d && !d.subagent_id
  && (d.type === "exec_complete" || d.type === "executionStats" || (d.type === "statusUpdate" && d.agentStatus === "failed"));

/** A turn that ended, by its message id. */
export const turnEnded = (events: readonly LiveEvent[], messageId: string): boolean =>
  events.some((e) => endsTurn(e.data) && e.data.message_id === messageId);

/** The turns that ended, in order: one event per turn, however many of its closing events arrived. */
export function endedTurns(events: readonly LiveEvent[]): LiveEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (!endsTurn(e.data)) return false;
    const turn = String(e.data.message_id || e.eventId);
    if (seen.has(turn)) return false;
    seen.add(turn);
    return true;
  });
}

/**
 * The turns a session's stored events (`?mode=replay`) say ended: its main agent's `exec_complete`, one per turn. A turn whose
 * delivery Brain gave up on ends with that event alone, which a stream never carries; read when a stream showed no end.
 */
export function storedTurnEnds(rows: readonly EventRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const d = r.data ?? {};
    if ((d.type ?? r.event_type) !== "exec_complete" || d.subagent_id) continue;
    const id = String(d.message_id ?? "");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const VERDICT_FIRST = /^[\s*_#>`"']*(?:(?:final\s+)?verdict\s*[:：]\s*)?[*_`]*(PASS|FAIL)\b/i;

/**
 * The judge's verdict: PASS or FAIL as its first word, allowing markdown emphasis and a "Verdict:" label before it; or, from a
 * judge that reasons first, as the first word of its last line. A PASS or FAIL inside a sentence is never one.
 */
export function judgeVerdict(text: string): "PASS" | "FAIL" | undefined {
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return (VERDICT_FIRST.exec(text) ?? VERDICT_FIRST.exec(last))?.[1]?.toUpperCase() as "PASS" | "FAIL" | undefined;
}

/** What a judge's second ask adds when its first answer had no verdict. */
export const JUDGE_RETRY_NOTE = "\n\nYour last answer had no verdict. Answer with exactly one line that starts with PASS or FAIL.";

/**
 * Stored events nothing graded reads: a session's progress (`statusUpdate`, but one that says the turn failed ends it), its
 * sandbox's (`sandboxStatus`), and Brain's own loading of a plugin's servers, rules and hooks (`toolUsed` load_*, a result with
 * no call). A stream that missed one of them showed everything a case is graded on.
 */
export function ungraded(d: Record<string, any>, type: unknown): boolean {
  if (type === "sandboxStatus") return true;
  if (type === "statusUpdate") return d.agentStatus !== "failed";
  return type === "toolUsed" && /^load_(?:mcp|rule|hooks)$/.test(String(d.tool ?? ""));
}

/**
 * The stored events (`?mode=replay`, with their `event_id`, which is the stream's frame id) of the given turns, and of what was
 * said about the given items, that the stream did not deliver: none when it showed everything a case is graded on. A turn's
 * exec_complete and the user's own message are left out: the live part of a stream never carries either (Claw stores a
 * UserMessage and publishes it on core-NATS `sse.events.<session>`, while the stream follows JetStream `events.<session>`; only a
 * stream's history segment replays it), and the runner wrote the message itself. So is what nothing graded reads (`ungraded`).
 * Events that could not be read are a gap too.
 */
export function streamMissed(rows: ReadonlyArray<EventRow & { event_id?: unknown }> | null, events: readonly LiveEvent[],
  messageIds: readonly string[], itemIds: readonly string[] = []): string[] {
  if (!rows) return ["(the stored events could not be read)"];
  const seen = new Set(events.map((e) => e.eventId));
  const turns = new Set(messageIds);
  const items = new Set(itemIds);
  return rows.filter((r) => {
    const d = r.data ?? {};
    const type = d.type ?? r.event_type;
    if (type === "exec_complete" || type === "UserMessage" || ungraded(d, type)) return false;
    const ours = turns.has(String(d.message_id ?? "")) || turns.has(String(d.turn_message_id ?? "")) || (d.item?.item_id !== undefined && items.has(String(d.item.item_id)));
    return ours && !seen.has(String(r.event_id ?? ""));
  }).map((r) => String(r.event_id ?? "?"));
}

/** What the main agent wrote in a plain session (`AssistantMessage`), in order: what its user was shown. */
export const messagesOf = (events: readonly LiveEvent[]): string[] => events
  .filter((e) => e.data?.type === "AssistantMessage" && !e.data.subagent_id)
  .map((e) => (Array.isArray(e.data.data?.content) ? e.data.data.content : []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text)).join(""))
  .filter(Boolean);

// --- Sharing an identity with its hourly say cap and with other runs --------------------------------------------------

const HOUR_MS = 3_600_000;

/** A say the cap counts: its id and when it was made (or seen). */
export interface SayMark { id: string; at: number }

/** The says the cap counts (`claw_assistant_says`, the system's fallbacks excluded), from a live stream. */
export const countedSays = (events: readonly LiveEvent[]): SayMark[] => events
  .filter((e) => e.data?.type === "AssistantSay" && e.data.fallback !== true)
  .map((e) => ({ id: String(e.data.say_id ?? e.eventId), at: e.at }));

/** The same from a session's stored events (`?mode=replay`): the says made before this run was listening. */
export const countedSaysOf = (rows: readonly EventRow[]): SayMark[] => rows
  .filter((r) => (r.data?.type ?? r.event_type) === "AssistantSay" && r.data?.fallback !== true)
  .map((r) => ({ id: String(r.data?.say_id ?? ""), at: Date.parse(r.created_at) }))
  .filter((m) => m.id && Number.isFinite(m.at));

/** Says of several sources as one list: each id once (at its earliest time), only those of the hour before `now`. */
export function mergeSays(lists: ReadonlyArray<readonly SayMark[]>, now: number): SayMark[] {
  const by = new Map<string, number>();
  for (const list of lists) for (const m of list) if (m.at > now - HOUR_MS && m.at <= now) by.set(m.id, Math.min(by.get(m.id) ?? Infinity, m.at));
  return [...by].map(([id, at]) => ({ id, at })).sort((a, b) => a.at - b.at);
}

/**
 * The says an earlier run on this host saw (EVAL_SAY_LOG, one `{"id","at"}` per line). The cap counts an identity's says
 * whatever session they were in, and a run deletes the assistant session it made: the next run cannot read them back from
 * the API. A line that is not a say is left out.
 */
export function parseSayLog(text: string): SayMark[] {
  const out: SayMark[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as Partial<SayMark>;
      if (typeof m.id === "string" && m.id && typeof m.at === "number" && Number.isFinite(m.at)) out.push({ id: m.id, at: m.at });
    } catch { /* not a say */ }
  }
  return out;
}

/**
 * How long to wait before the next case so that the identity's counted says of the last hour, and `reserve` more for the case,
 * stay within `perHour`: the server refuses a say past CLAW_ASSISTANT_SAY_MAX_PER_HOUR in a rolling hour, and a refused say is
 * a case lost to the run, not to the assistant. 0 to go now; `perHour` 0 never waits.
 */
export function sayWaitMs(says: readonly number[], now: number, perHour: number, reserve: number): number {
  if (perHour <= 0) return 0;
  const recent = says.filter((t) => t > now - HOUR_MS && t <= now).sort((a, b) => a - b);
  const over = recent.length + reserve - perHour;
  if (over <= 0) return 0;
  // When the over-th oldest say leaves the hour, enough room is left; a reserve that alone exceeds perHour is refused at start.
  return recent[Math.min(over, recent.length) - 1]! + HOUR_MS - now + 1_000;
}

/** Says a run leaves under the server's cap for what it cannot see: today's 100 of the people's 120. */
export const SERVER_CAP_MARGIN = 20;

/**
 * The pace a run keeps: EVAL_SAY_PER_HOUR (`configured`; 0 is no pace), but never closer than SERVER_CAP_MARGIN to the cap the
 * server answered POST /v1/assistant with (`serverCap`, `say_max_per_hour`): an EVAL_SAY_PER_HOUR raised for an evaluation
 * identity's own cap stays safe against a server that does not give the identity that cap. A server that does not say keeps
 * `configured`.
 */
export function pacedPerHour(configured: number, serverCap: unknown, reserve: number): number {
  if (configured <= 0 || typeof serverCap !== "number" || !Number.isInteger(serverCap) || serverCap <= 0) return configured;
  return Math.min(configured, Math.max(reserve + 1, serverCap - SERVER_CAP_MARGIN));
}

/**
 * The says of the assistant the server refused for its hourly cap since `since`, other than in the turns of the messages in
 * `earlier` (an earlier attempt's, arriving late after a reconnect): an attempt with one is the run's failure.
 */
export const capRefusedSays = (events: readonly LiveEvent[], since: number, earlier: ReadonlySet<string> = new Set()): number => events.filter((e) => e.at >= since
  && !earlier.has(String(e.data?.message_id ?? "")) && e.data?.type === "toolUsed" && e.data.tool === "mcp__assistant__say" && e.data.status === "error"
  && [e.data.result, e.data.description, e.data.brief].some((x) => typeof x === "string" && x.includes("say_rate_limited"))).length;

/**
 * Why a run must not start on the identity's assistant session: someone is using it now (a turn is running, or something
 * happened in it, its making included, less than `quietMs` ago). Two runs on one assistant see each other's messages and items, and a run that
 * cleans up after another one deletes what that one is using; each parallel run needs an identity of its own. Null: free.
 */
export function assistantInUse(session: { agent_status?: unknown; created_at?: unknown } | null, lastEventAt: number | null, now: number, quietMs: number): string | null {
  if (session?.agent_status === "running") return "a turn is running in the identity's assistant session";
  // A session made a moment ago is in use too: another run made it, and has not sent anything yet.
  const made = typeof session?.created_at === "string" ? Date.parse(session.created_at) : NaN;
  if (Number.isFinite(made) && (lastEventAt === null || made > lastEventAt)) lastEventAt = made;
  if (quietMs > 0 && lastEventAt !== null && now - lastEventAt < quietMs) {
    return `the identity's assistant session was active ${Math.round((now - lastEventAt) / 1000)}s ago (EVAL_QUIET_S=${Math.round(quietMs / 1000)})`;
  }
  return null;
}

export interface ApiAnswer { status: number; json: any }

/**
 * Delete one session the run made, and see that it is gone: DELETE answers 200 (or 404, gone already), and only a GET that
 * then answers 404 counts. A refusal (401, 403) ends it; anything else is tried again until `deadlineAt`. Only ever called
 * with an id the run made or was answered for its own item: nothing is deleted by identity.
 */
export async function deleteSessionConfirmed(
  api: (method: string, path: string) => Promise<ApiAnswer>, sessionId: string, deadlineAt: number, everyMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
  for (;;) {
    const del = await api("DELETE", path).catch(() => ({ status: 0, json: null }));
    // Not the run's to delete (or not its key): asking again changes nothing.
    if (del.status === 401 || del.status === 403) return false;
    if (del.status === 200 || del.status === 404) {
      const got = await api("GET", path).catch(() => ({ status: 0, json: null }));
      if (got.status === 404) return true;
    }
    if (Date.now() + everyMs > deadlineAt) return false;
    await sleep(everyMs);
  }
}

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
 * still makes the route an item (`routeOf`); it just names no item here. An answer `"deduplicated": true` names an open
 * item that was there before (work_create finds one with the same title): it counts only when that item is already in
 * `known` (the run's own), since another's would otherwise be closed, and its worker's session deleted, as the run's.
 */
export function itemsStartedBy(calls: readonly ToolCall[], items: readonly ItemSeen[], known: ReadonlySet<string> = new Set()): ItemSeen[] {
  const ids = new Set<string>();
  const seqs = new Set<number>();
  const found = new Set<string>();   // named only by a deduplicated answer
  const foundSeqs = new Set<number>();
  for (const c of calls) {
    if (c.ok !== true || !/(^|__)(work_create|review_start|review_restart)$/.test(c.name)) continue;
    const dedup = /"deduplicated"\s*:\s*true/.test(c.result);
    for (const m of c.result.matchAll(/"item_id"\s*:\s*"([^"]+)"/g)) (dedup ? found : ids).add(m[1]!);
    for (const m of c.result.matchAll(/"seq"\s*:\s*(\d+)/g)) (dedup ? foundSeqs : seqs).add(Number(m[1]));
  }
  return items.filter((i) => ids.has(i.item_id) || seqs.has(i.seq) || ((found.has(i.item_id) || foundSeqs.has(i.seq)) && known.has(i.item_id)));
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

/**
 * The id of the server's "on it" line for the turn answering `messageId` (`lookupAckSayId` in `src/assistant/lookup-ack.ts`): a say in
 * the system's words, said while the turn is still working, that the turn's answer takes the place of (`replaces`). The live stream
 * marks it no differently from an answer, so it is known by its id.
 */
export function turnAckSayId(userId: string, messageId: string): string {
  const h = createHash("sha256").update(`assistant.notice\u0000${userId}\u0000lookup_ack:${messageId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Whether every one of these turns has had its answer shown: a say of the turn other than its "on it" line. A router turn that ended in
 * plain text has its words said by the server a moment after its end, often after that line (E242 memory-chain run 2026-11-08,
 * cat-memory-chain-013: the line at 3.5 s, the answer at 4.2 s, and the grade read "收到，我看一下。" as the whole reply). Without the
 * person's id every say counts, as before.
 */
export function turnsAnswered(says: readonly Say[], messageIds: readonly string[], userId: string | null): boolean {
  return messageIds.every((id) => {
    const ack = userId ? turnAckSayId(userId, id) : null;
    return says.some((s) => s.turn === id && s.sayId !== ack);
  });
}

/**
 * What the server says in its own words when the turn answering the person ended without an answer: that the turn failed, that it was
 * declined, or that it looked things up and put nothing together (`turnLostNotice`, `silentTurnNotice` in
 * `src/assistant/router-turn-end.ts`; `test/sa-eval.test.ts` holds them to those). Published as a say like any other and not marked as
 * the system's, so they are known by their words.
 */
export const SYSTEM_TURN_NOTICES: ReadonlySet<string> = new Set([
  "刚才这条没有处理成功，请再说一次。进行中的事项不受影响。",
  "That message did not go through; please say it again. Your work items are not affected.",
  "这个请求我不能处理：它可能涉及访问内部地址、凭据或其他不安全的操作，所以我没有执行。换个问题或说明你想达到的目的，我可以继续帮你。进行中的事项不受影响。",
  "I can't help with that request: it may involve reaching internal addresses, credentials or something else unsafe, so I did not do it. Ask something else or tell me what you want to achieve, and I'll help. Your work items are not affected.",
  "我查了一些资料，但这次没能整理出答复。请再问我一次，或者把问题说得具体一点。",
  "I looked into it but could not put an answer together this time. Please ask me again, or narrow the question down.",
]);

/**
 * How many of the says of the turn answering `messageId` are its answer: the router's own say, or the plain text the turn ended with,
 * which the server says for it a moment after its end (`deliverUnsaidAnswer`, E242 2026-11-08: the person gets it as one message, in
 * place of the "on it" line). Not the system's own lines: a message about an item that needs the person (`fallback`), the "on it" line
 * (known by its id), and the notice for a turn that failed, was declined or said nothing (`SYSTEM_TURN_NOTICES`). Null without the
 * person's id: the "on it" line cannot be told from an answer.
 */
export function ownSays(says: readonly Say[], messageId: string, userId: string | null): number | null {
  if (!userId) return null;
  const ack = turnAckSayId(userId, messageId);
  return says.filter((s) => s.turn === messageId && !s.fallback && s.sayId !== ack && !SYSTEM_TURN_NOTICES.has(s.text.trim())).length;
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
  /** The files the last turn's items handed the user (assistant mode; absent in baseline). */
  delivered?: SaidFile[];
  /** The highest item number on the person's board when the case was graded (assistant mode; absent when none was read). */
  itemSeqMax?: number;
  /**
   * The last turn's own answers (assistant mode): its says that are not the system's own lines (`ownSays`). Null when they cannot be
   * told apart (the identity's user id was not read, so its "on it" line is not known); absent in baseline.
   */
  ownSays?: number | null;
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
  if (c.said) {
    // Said by the turn itself or for it, not the system's line in its place; a baseline session has no says.
    if (o.mode === "baseline") skip("said");
    else if (o.ownSays === null || o.ownSays === undefined) out.push({ name: "said", pass: false, unverified: true, detail: "the system's own lines could not be told apart" });
    else out.push({ name: "said", pass: o.ownSays > 0, detail: o.ownSays ? `${o.ownSays} message(s)` : "only the system's own lines" });
  }
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
    // The rule is the judge's (it sees the turn's calls). What the detectors find is a denial no failed call explains: they never
    // fail a case by themselves (a caveat they mistake for a denial must not fail a right answer); they make it unverified, so a
    // run without a judge does not count it as a pass, and a judge decides it.
    const unexplained = falseDenials(o.final, o.calls, c.turns.at(-1)?.user ?? "");
    out.push(unexplained.length
      ? { name: "no false denial", pass: true, skipped: true, unverified: true, detail: `${unexplained[0]}: a denial no failed call explains; the judge decides` }
      : { name: "no false denial", pass: true });
  }
  if (c.style?.no_ids) {
    const m = bareItemNumber(shownText, o.itemSeqMax);
    out.push({ name: "items named by title", pass: m === null, detail: m ?? undefined });
  }
  if (c.style?.reply_lang === "follow_user" && c.lang !== "mixed") {
    const letters = o.final.replace(/\s/g, "").length;
    const ratio = letters ? (o.final.match(CJK)?.length ?? 0) / letters : 0;
    out.push({ name: `reply in ${c.lang}`, pass: letters > 0 && (c.lang === "zh" ? ratio >= 0.2 : ratio < 0.05), detail: `cjk ${ratio.toFixed(2)}` });
  }
  if (c.style?.max_chars !== undefined) out.push({ name: `<= ${c.style.max_chars} chars`, pass: o.final.length <= c.style.max_chars, detail: `${o.final.length}` });
  if (c.style?.min_chars !== undefined) out.push({ name: `>= ${c.style.min_chars} chars`, pass: o.final.length >= c.style.min_chars, detail: `${o.final.length}` });
  for (const d of c.delivers ?? []) {
    const name = `delivers ${d.name ?? "*"} ${d.type ?? "*"}`;
    if (o.mode === "baseline" || o.delivered === undefined) { skip(name); continue; }
    const re = d.name ? new RegExp(d.name, "i") : null;
    const hit = o.delivered.find((f) => (!re || re.test(f.name)) && (!d.type || f.content_type.startsWith(d.type)));
    out.push({ name, pass: hit !== undefined, detail: o.delivered.map((f) => `${f.name} ${f.content_type}`).join(", ") || "no file" });
  }
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
  /** Every item the case's turns started; `last`: the graded (last) turn started it (earlier turns are context). */
  items: Array<Pick<ItemSeen, "seq" | "kind" | "board_state"> & { cleanup: string; last?: boolean }>;
  /** The judge's verdict and reason (keys scrubbed, 300 characters); `votes` when it was asked more than once (majority). */
  judge?: { pass: boolean; why: string; votes?: Array<{ pass: boolean; why: string }> } | null;
  /** Not fully graded, so not a pass: content only a judge can grade and no judge graded it, or an oracle not read (offline). */
  unjudged?: true;
  error?: string;
  /** When a stream of the attempt was opened again (ISO time and why: it dropped, or a stored event was not delivered). */
  reopened?: string[];
  /** The error of a first try that the run ran again (once): this attempt is the second try. */
  retried?: string;
  /** How many cards waited for the identity's answer when the attempt started (after the run closed what it could): the assistant saw them. */
  cardsWaiting?: number;
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

/**
 * The judge's prompt for one case: the user's turns, the final reply, the rubric, the facts only it can grade, and the rule, with
 * what the rule needs to be applied: the tools the case expects the assistant to have for this request (its tools_must) and every
 * tool call of the turn, by name, with whether it failed (no tool output: that is the identity's data).
 */
export function judgePrompt(c: EvalCase, turns: readonly Turn[], final: string, calls: readonly ToolCall[] = [],
  values: ReadonlyArray<readonly string[] | null> = []): string {
  const facts = judgeFacts(c);
  const truth = oracleTruth(c, values);
  const evidence = c.may_deny ? "" : `Tools it has for this request: ${(c.tools_must ?? []).join(", ") || "none named by the case"}\n`
    + `Tool calls it made in this turn: ${calls.map((x) => `${x.name} (${x.ok === false ? "failed" : x.ok === true ? "ok" : "no result"})`).join(", ") || "none"}\n`;
  return `You grade one reply of an assistant to a user.\nUser said:\n${turns.map((t) => t.user).join("\n")}\n\n`
    + `Assistant's final reply:\n${final}\n\n${c.rubric ? `Rubric: ${c.rubric}\n` : ""}${facts.length ? `The reply must state: ${facts.join("; ")}\n` : ""}`
    + (truth.length ? `${ORACLE_TRUTH_NOTE}\n${truth.map((t) => `- ${t}`).join("\n")}\n` : "")
    + `${c.may_deny ? "" : `Always: ${NO_FALSE_DENIAL_RULE}\n${evidence}`}`
    + "\nAnswer with one line: PASS or FAIL, a colon, and one short reason.";
}

/** What the judge is told of the values the run read: they are the truth, and may be newer than what it knows. */
export const ORACLE_TRUTH_NOTE = "The correct values, read for this run from the source of truth just before the reply. They can be newer than "
  + "anything you know (a release, a version, a count, a date after your training): take them as correct, and never fail a reply "
  + "for stating one of them, or because a value is later than you expected. A fact listed with several values (\"all of\") needs "
  + "every one of them; a value given as alternatives (\"one of\") is stated by any one of them:";

/**
 * Each fact with a value the run has for it (an oracle's read for the run, or the value written in the case): its claim and what
 * the fact check requires (`grade`): the first 10 values, all of them, each satisfied by any of its `a||b` alternatives (`names`).
 * A fact with none is left out.
 */
export function oracleTruth(c: EvalCase, values: ReadonlyArray<readonly string[] | null>): string[] {
  const one = (v: string): string => {
    const alts = v.split("||").filter((x) => x !== "");
    return alts.length > 1 ? `one of ${alts.map((x) => JSON.stringify(x)).join(", ")}` : JSON.stringify(alts[0] ?? v);
  };
  return (c.facts ?? []).flatMap((f, k) => {
    const v = (values[k] ?? []).filter((x) => x !== "").slice(0, 10);
    if (!v.length) return [];
    return [`${f.claim}: ${v.length > 1 ? `all of: ${v.map((x) => `(${one(x)})`).join(" and ")}` : one(v[0]!)}`];
  });
}

/**
 * An attempt's verdict: every deterministic check, and, for a case with content only a judge can grade, the judge's
 * PASS. Without a judge such an attempt is never a pass: it is reported as unjudged, so a reply that only looks right
 * (on time, the right route, but without the fact asked for) is not counted as passing.
 */
export function verdictOf(c: EvalCase, checks: readonly Check[], judge: { pass: boolean } | null | undefined): { pass: boolean; unjudged?: true } {
  if (!passed(checks)) return { pass: false };
  // A judge, where one is configured, grades every case (at least the no-false-denial rule, with the turn's calls): its verdict
  // decides, also what the denial detectors left to it.
  if (judge) return checks.some((x) => x.unverified && x.name !== "no false denial") ? { pass: false, unjudged: true } : { pass: judge.pass };
  if (checks.some((x) => x.unverified)) return { pass: false, unjudged: true };
  return needsJudge(c) ? { pass: false, unjudged: true } : { pass: true };
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
export interface Recording {
  case_id: string; mode: Mode; attempt: number; at: string; observed: Observed;
  /** The judge's verdict and each of its whole answers, in order (`failed`: it gave none). */
  judge?: { pass: boolean; failed?: true; answers: string[] };
}

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
  // A label for the kind of answer ("clarify", "ack"), or settings written as code ("merge=false", "NOT_ACTIONS: github", "fish; ROCm"),
  // is not something the answer says either.
  if (/^(clarify|short|joke|irrelevant|ack|abstain|refuse|greeting)$/i.test(t) || /^\w+=\w+(,\s*\w+=\w+)*$|;\s|:\s/.test(t)) return true;
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
