// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The parts of the agent evaluation (`agent-eval.ts`) that are not calls to a deployment: what a finished task's
 * session is read as, the checks a task's grader is built from, and the usage numbers a run is summarised by. Kept
 * apart so they are tested offline (`test/agent-eval.test.ts`) on recorded event rows.
 *
 * Every number comes from what the API already records for a turn: the session's events as
 * `GET /v1/chat/sessions/:id/messages?mode=replay` returns them (`toolUsed`, `permissionRequest`, `sandboxStatus`,
 * `executionStats`, `exec_complete`) and the files the turn left in /workspace. Nothing is added to the product
 * to measure it.
 */
import AdmZip from "adm-zip";

/** A stored session event as the replay returns it. */
export interface EventRow { event_type: string; created_at: string; data: Record<string, any> }

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** True or false once a result arrived; null when none did. */
  ok: boolean | null;
  /** What the tool answered, as the event records it (Brain's view, so possibly cut short). */
  result: string;
  at: number;
}

/** What Brain reports at the end of a turn (`executionStats`). */
export interface TurnStats {
  elapsedMs: number;
  turns: number;
  totalCalls: number;
  errorCalls: number;
  byTool: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface Trace {
  final: string;
  /** The turn ended in failure, or never ended. */
  failed: boolean;
  calls: ToolCall[];
  /** Approval requests the turn raised; the evaluation answers each with a deny. */
  approvals: string[];
  /** MCP servers the turn connected to, as Brain announced them. */
  mcpServers: string[];
  stats: TurnStats | null;
  /** From the first event to the turn's end, as stored. */
  wallMs: number | null;
  /** From the sandbox being asked for to it being ready; null when the turn opened none. */
  sandboxWaitMs: number | null;
  /** The files a task asked to see, by path under /workspace; null when it is not there. */
  files: Record<string, Buffer | null>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const time = (row: EventRow): number => Date.parse(row.created_at);

/** One task's session, read from its stored events. Only events of the turn named by `messageId`, when given. */
export function traceOf(rows: readonly EventRow[], messageId?: string): Omit<Trace, "files"> {
  const mine = messageId ? rows.filter((r) => !r.data?.message_id || r.data.message_id === messageId) : rows;
  const calls = new Map<string, ToolCall>();
  const approvals: string[] = [];
  const mcpServers: string[] = [];
  let final = "";
  let ended = false;
  let failed = false;
  let stats: TurnStats | null = null;
  let sandboxAsked: number | null = null;
  let sandboxReady: number | null = null;
  let endedAt: number | null = null;
  for (const row of mine) {
    const d = row.data ?? {};
    const type = d.type ?? row.event_type;
    if (type === "toolUsed") {
      const tool = String(d.tool ?? "");
      const id = String(d.actionId ?? "");
      if (tool === "load_mcp") {
        const server = /\(([^)]+)\)\s*$/.exec(String(d.brief ?? ""))?.[1];
        if (server && !mcpServers.includes(server)) mcpServers.push(server);
        continue;
      }
      if (d.status === "start") {
        const detail = d.argumentsDetail?.[tool];
        calls.set(id, { id, name: tool, input: detail && typeof detail === "object" ? detail : {}, ok: null, result: "", at: time(row) });
      } else if (d.status === "success" || d.status === "error") {
        const call = calls.get(id);
        if (!call) continue; // a result with no call: Brain's own bookkeeping (plugin loads), not a tool the model chose
        call.ok = d.status === "success";
        call.result = [d.result, d.description, d.brief].find((x) => typeof x === "string" && x) ?? "";
      }
    } else if (type === "permissionRequest") {
      approvals.push(String(d.tool_use_id ?? d.toolUseId ?? d.tool ?? "?"));
    } else if (type === "sandboxStatus") {
      if (d.status === "creating" && sandboxAsked === null) sandboxAsked = time(row);
      if (d.status === "ready" && sandboxReady === null) sandboxReady = time(row);
    } else if (type === "executionStats") {
      const usage = d.token_usage ?? {};
      const tools = d.tool_stats ?? {};
      stats = {
        elapsedMs: num(d.elapsed_ms), turns: num(d.turns),
        totalCalls: num(tools.total_calls), errorCalls: num(tools.error_calls), byTool: { ...(tools.by_tool ?? {}) },
        inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens),
        cacheRead: num(usage.cache_read), cacheCreate: num(usage.cache_create),
      };
    } else if (type === "AssistantMessage") {
      const text = (d.data?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text)).join("");
      if (text) final = text;
    } else if (type === "exec_complete") {
      ended = true;
      failed = d.failed === true;
      if (typeof d.final_text === "string" && d.final_text) final = d.final_text;
      endedAt = time(row);
    }
  }
  const startedAt = mine.length ? time(mine[0]!) : null;
  return {
    final, failed: failed || !ended, calls: [...calls.values()], approvals, mcpServers, stats,
    wallMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    sandboxWaitMs: sandboxAsked !== null && sandboxReady !== null ? sandboxReady - sandboxAsked : null,
  };
}

// --- What a grader is built from -------------------------------------------------------------------------------

export interface Verdict { pass: boolean; why: string[] }

/** All of the named checks hold; `why` lists the ones that did not. */
export function all(checks: Record<string, boolean>): Verdict {
  const why = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { pass: why.length === 0, why };
}

const commandOf = (c: ToolCall): string => String(c.input.command ?? c.input.cmd ?? "");

export const isMcp = (c: ToolCall): boolean => c.name.startsWith("mcp__");

/** The file's text, or null when the turn left no such file. */
export function text(t: Pick<Trace, "files">, path: string): string | null {
  const b = t.files[path];
  return b ? b.toString("utf8") : null;
}

/** Same text, ignoring line-end spaces and the trailing newline. */
export const sameText = (a: string | null, b: string): boolean =>
  a !== null && a.replace(/[ \t]+$/gm, "").trimEnd() === b.replace(/[ \t]+$/gm, "").trimEnd();

/** The model reached the network: a web tool that answered, or a shell command that goes out. */
export function reachedNetwork(t: Pick<Trace, "calls">): boolean {
  return t.calls.some((c) => c.ok === true && (
    c.name === "web_search" || c.name === "web_fetch"
    || (c.name === "bash" && /\b(curl|wget|gh|git\s+clone|git\s+ls-remote|pip3?\s+(install|download)|urllib|requests\.get|httpx)\b/.test(commandOf(c)))
  ));
}

export const citesUrl = (final: string): boolean => /https?:\/\/[^\s)>\]]+/.test(final);

/**
 * The last test run the model made passed: a shell call that runs the tests (unittest, pytest, or the file named),
 * and whose output says they passed. A later failing run counts against it, so a fix that was tried and broken
 * does not pass.
 */
export function lastTestRunPassed(t: Pick<Trace, "calls">, testFile: string): boolean {
  const runs = t.calls.filter((c) => c.name === "bash" && (/\bunittest\b|\bpytest\b/.test(commandOf(c)) || commandOf(c).includes(testFile)));
  const last = runs.at(-1);
  if (!last || last.ok !== true) return false;
  const out = last.result;
  const unittestOk = /Ran [1-9]\d* tests?/.test(out) && /\bOK\b/.test(out) && !/FAILED|Error:/.test(out);
  const pytestOk = /\b[1-9]\d* passed\b/.test(out) && !/\b\d+ (failed|error)/.test(out);
  return unittestOk || pytestOk;
}

/** A named entry of a zip-based document (docx, xlsx, pptx) as text, or null. */
export function zipEntry(buf: Buffer | null | undefined, name: string): string | null {
  if (!buf || buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return null;
  try {
    const entry = new AdmZip(buf).getEntry(name);
    return entry ? entry.getData().toString("utf8") : null;
  } catch {
    return null;
  }
}

/** Every entry name of a zip-based document, or [] when it is not one. */
export function zipNames(buf: Buffer | null | undefined): string[] {
  if (!buf || buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return [];
  try { return new AdmZip(buf).getEntries().map((e) => e.entryName); } catch { return []; }
}

/**
 * How it worked, beyond whether it passed. `readBeforeEdit`: of the edits to an existing file, how many came after
 * the model read that file. `checkedAfterChange`: whether a shell call followed the last change the model made.
 */
export function behaviour(t: Pick<Trace, "calls">): { edits: number; editsAfterRead: number; changed: boolean; checkedAfterChange: boolean } {
  const read = new Set<string>();
  let edits = 0;
  let editsAfterRead = 0;
  let lastChange = -1;
  const pathOf = (c: ToolCall): string => {
    const first = Array.isArray(c.input.edits) ? (c.input.edits[0] as Record<string, unknown> | undefined) : undefined;
    return String(c.input.path ?? c.input.file_path ?? first?.path ?? "").replace(/^\/workspace\//, "");
  };
  t.calls.forEach((c, i) => {
    const path = pathOf(c);
    if (c.name === "read" && path) read.add(path);
    if (c.name === "edit" || c.name === "multi_edit") {
      edits += 1;
      if (read.has(path)) editsAfterRead += 1;
    }
    if (c.name === "write" || c.name === "edit" || c.name === "multi_edit") lastChange = i;
  });
  const changed = lastChange >= 0;
  const checkedAfterChange = changed && t.calls.slice(lastChange + 1).some((c) => c.name === "bash");
  return { edits, editsAfterRead, changed, checkedAfterChange };
}

// --- Usage numbers ---------------------------------------------------------------------------------------------

export interface Outcome {
  id: string;
  category: string;
  pass: boolean;
  why: string[];
  /** Not run: the task needs what this deployment does not offer (no plugin for the MCP tasks). */
  skipped?: string;
  error?: string;
  trace?: Omit<Trace, "files">;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export interface CategorySummary {
  tasks: number;
  passed: number;
  /** Tasks that ran and errored or never ended. */
  broken: number;
  toolCalls: number;
  toolErrors: number;
  approvals: number;
  /** Brain's own elapsed time per turn. */
  turnP50Ms: number | null;
  turnP90Ms: number | null;
  sandboxWaitP50Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  edits: number;
  editsAfterRead: number;
  changed: number;
  checkedAfterChange: number;
  byTool: Record<string, number>;
}

/** The run by category and in total ("all"); skipped tasks are left out of every number. */
export function summarize(outcomes: readonly Outcome[]): Record<string, CategorySummary> {
  const groups = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    if (o.skipped) continue;
    for (const key of [o.category, "all"]) groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const out: Record<string, CategorySummary> = {};
  for (const [key, os] of groups) {
    const traces = os.map((o) => o.trace).filter((t): t is Omit<Trace, "files"> => !!t);
    const stats = traces.map((t) => t.stats).filter((s): s is TurnStats => !!s);
    const how = traces.map(behaviour);
    const byTool: Record<string, number> = {};
    for (const s of stats) for (const [k, v] of Object.entries(s.byTool)) byTool[k] = (byTool[k] ?? 0) + v;
    out[key] = {
      tasks: os.length,
      passed: os.filter((o) => o.pass).length,
      broken: os.filter((o) => o.error || !o.trace || o.trace.failed).length,
      toolCalls: stats.reduce((n, s) => n + s.totalCalls, 0),
      toolErrors: stats.reduce((n, s) => n + s.errorCalls, 0),
      approvals: traces.reduce((n, t) => n + t.approvals.length, 0),
      turnP50Ms: percentile(stats.map((s) => s.elapsedMs), 50),
      turnP90Ms: percentile(stats.map((s) => s.elapsedMs), 90),
      sandboxWaitP50Ms: percentile(traces.map((t) => t.sandboxWaitMs).filter((v): v is number => v !== null), 50),
      inputTokens: stats.reduce((n, s) => n + s.inputTokens + s.cacheRead + s.cacheCreate, 0),
      outputTokens: stats.reduce((n, s) => n + s.outputTokens, 0),
      edits: how.reduce((n, h) => n + h.edits, 0),
      editsAfterRead: how.reduce((n, h) => n + h.editsAfterRead, 0),
      changed: how.filter((h) => h.changed).length,
      checkedAfterChange: how.filter((h) => h.checkedAfterChange).length,
      byTool,
    };
  }
  return out;
}

/** One line per category: what a reader compares between two runs. */
export function renderSummary(sum: Record<string, CategorySummary>): string {
  const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : "-");
  const sec = (ms: number | null): string => (ms === null ? "-" : `${Math.round(ms / 1000)}s`);
  const head = "category    pass        tool calls  errors  approvals  turn p50/p90   sandbox p50  tokens in/out     checked-after-change";
  const rows = Object.entries(sum).sort(([a], [b]) => (a === "all" ? 1 : b === "all" ? -1 : a.localeCompare(b))).map(([k, s]) =>
    `${k.padEnd(11)} ${`${s.passed}/${s.tasks} ${pct(s.passed, s.tasks)}`.padEnd(11)} ${String(s.toolCalls).padEnd(11)} ${String(s.toolErrors).padEnd(7)} `
    + `${String(s.approvals).padEnd(10)} ${`${sec(s.turnP50Ms)}/${sec(s.turnP90Ms)}`.padEnd(14)} ${sec(s.sandboxWaitP50Ms).padEnd(12)} `
    + `${`${s.inputTokens}/${s.outputTokens}`.padEnd(17)} ${s.checkedAfterChange}/${s.changed}`);
  return [head, ...rows].join("\n");
}
