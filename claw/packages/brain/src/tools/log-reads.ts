// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.log_reads`: the lookups of a run whose results are log text (a job's log, a node agent's, a cluster's, a
 * workload's events), each with the argument that says how many lines or entries it returns. An assistant's router turn gets them
 * (the API's `read-tools.ts`), so that "why did my job fail?" is answered from the end of the log in the conversation, without
 * handing the whole log to a worker, and without a model reading a credential the job printed.
 *
 * For such a call Brain:
 *  - asks for at most `lines`: the counting argument is lowered to it, and set to it when the call names none (the servers'
 *    own defaults are a thousand lines);
 *  - masks credential-shaped text in what it answered (`redactLogSecrets` of @claw/utils: shapes, values after a credential's
 *    name, private keys) before the model, an event or a log line sees it;
 *  - keeps only the last `chars` characters of an answer that is plain text, the end of a log being where it failed. An answer
 *    in JSON is left whole for the run's own result cap: its newest lines may be at its start.
 *
 * Read once per run. Unreadable, it is no rule: the request's other fields are what they were.
 */
import { redactLogSecrets } from "@claw/utils";

/** Whether an answer is JSON (left whole: its newest lines may come first), not a plain-text log that starts with `[` or `{`. */
function isJson(text: string): boolean {
  if (!/^\s*[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export interface LogReads {
  /** Whether `name` is one of the run's log reads. */
  has(name: string): boolean;
  /** `input` with the counting argument of `name` at most the bound, and the bound when it names none. */
  bound(name: string, input: Record<string, unknown>): Record<string, unknown>;
  /** What the model may see of a log read's answer. */
  filter(text: string): string;
}

const MAX_LINES = 1000;
const MIN_CHARS = 500;
const MAX_CHARS = 100_000;

export function parseLogReads(raw: unknown): LogReads | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { tools?: unknown; lines?: unknown; chars?: unknown };
  if (!r.tools || typeof r.tools !== "object" || Array.isArray(r.tools)) return null;
  const tools = new Map<string, string>();
  for (const [name, arg] of Object.entries(r.tools as Record<string, unknown>)) {
    if (/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/.test(name) && typeof arg === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(arg)) tools.set(name, arg);
  }
  if (!tools.size) return null;
  const lines = typeof r.lines === "number" && Number.isSafeInteger(r.lines) && r.lines >= 1 && r.lines <= MAX_LINES ? r.lines : 40;
  const chars = typeof r.chars === "number" && Number.isSafeInteger(r.chars) && r.chars >= MIN_CHARS && r.chars <= MAX_CHARS ? r.chars : 6000;
  return {
    has: (name) => tools.has(name),
    bound(name, input) {
      const arg = tools.get(name);
      if (!arg) return input;
      const asked = input[arg];
      const n = typeof asked === "number" ? asked : typeof asked === "string" && asked.trim() ? Number(asked) : NaN;
      return { ...input, [arg]: Number.isFinite(n) && n >= 1 && n < lines ? Math.floor(n) : lines };
    },
    filter(text) {
      const raw = typeof text === "string" ? text : String(text ?? "");
      const masked = redactLogSecrets(raw).text;
      if (masked.length <= chars || isJson(raw)) return masked;
      const end = masked.slice(-chars);
      const cut = end.indexOf("\n");
      const kept = cut >= 0 && cut < end.length - 1 ? end.slice(cut + 1) : end;
      return `[${masked.length - kept.length} earlier characters of this log are not shown]\n${kept}`;
    },
  };
}
