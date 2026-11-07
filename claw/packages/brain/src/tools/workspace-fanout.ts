// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SaFE's `workload_list` without a workspace, for a user who is not an admin.
 *
 * SaFE answers an unscoped workload list with 403 (Primus.00003) to every key but an admin's: a member may list a workspace's
 * workloads, never all of them at once. A model asked "how is SaFE doing?" calls the list without a workspace, and the person was
 * told "403 无权限" for a question they are entitled to ask (E229, replay #19). So Brain answers such a call the way the brain's own
 * teardown already reads a session's workloads (`sandbox/multi-node/safe-provider.ts`, `findSessionWorkloads`):
 *
 *  - the call as the model made it, first: an admin's key reads every workspace, exactly as before;
 *  - only its 403 moves it to the workspaces the caller may use (`user_self`, the same server, the same key), one page per
 *    workspace with the model's own filters, at most FANOUT_MAX_WORKSPACES of them;
 *  - merged into one answer in SaFE's own shape (`items`, `totalCount`), which says what it is: the workspaces read, each with its
 *    own count; the ones that failed, with why; the ones not read; `complete` only when every workspace was read; `truncated`
 *    when the items are fewer than the count. `totalCount` is the sum over the workspaces read, so a count asked for with
 *    `limit: 1` is still the count.
 *
 * A call that names a workspace, or fails with anything but 403, is answered as the server answered it.
 */
import type { McpCallOutcome, McpToolCaller } from "../clients/mcp.js";

/** The calls answered this way, by the run's tool name: the list, and the argument that scopes it to one workspace. */
export const WORKSPACE_FANOUT: Readonly<Record<string, { arg: string; selfTool: string }>> = {
  mcp__safe__workload_list: { arg: "workspace_id", selfTool: "user_self" },
};

/** The workspaces one fanned-out call reads at most; the rest are named in `workspaces_not_read`. */
export const FANOUT_MAX_WORKSPACES = 12;
/** How many of those are read at once. */
const FANOUT_CONCURRENCY = 4;
/** SaFE's own page size when a call names none. */
const DEFAULT_LIMIT = 100;
/** The most of a failed workspace's answer that is kept as its reason. */
const REASON_CHARS = 200;

export function fansOut(name: string): boolean {
  return Object.hasOwn(WORKSPACE_FANOUT, name);
}

function unscoped(input: Record<string, unknown>, arg: string): boolean {
  const v = input[arg];
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** SaFE's refusal of an unscoped list: the tool's own error, naming 403. */
function isForbidden(isError: boolean, text: string): boolean {
  return isError && /\b403\b/.test(text);
}

/** The ids of the workspaces in `user_self`'s answer, in its order, each once. Null when the answer is not that record. */
export function workspacesOfSelf(text: string): string[] | null {
  let self: unknown;
  try {
    self = JSON.parse(text);
  } catch {
    return null;
  }
  if (!self || typeof self !== "object" || !Array.isArray((self as { workspaces?: unknown }).workspaces)) return null;
  const out: string[] = [];
  for (const w of (self as { workspaces: unknown[] }).workspaces) {
    const id = w && typeof w === "object" ? (w as { id?: unknown }).id : w;
    if (typeof id === "string" && id.trim() && !out.includes(id.trim())) out.push(id.trim());
  }
  return out;
}

interface Page {
  items: Record<string, unknown>[];
  totalCount: number;
}

function pageOf(text: string): Page | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !Array.isArray((v as { items?: unknown }).items)) return null;
  const items = (v as { items: unknown[] }).items.filter((i): i is Record<string, unknown> => !!i && typeof i === "object");
  const tc = (v as { totalCount?: unknown }).totalCount;
  return { items, totalCount: typeof tc === "number" && Number.isSafeInteger(tc) && tc >= 0 ? tc : items.length };
}

function reasonOf(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > REASON_CHARS ? `${t.slice(0, REASON_CHARS)}…` : t || "no answer";
}

function limitOf(input: Record<string, unknown>): number {
  const n = typeof input.limit === "number" ? input.limit : typeof input.limit === "string" && input.limit.trim() ? Number(input.limit) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_LIMIT;
}

/** Newest first unless the call asked otherwise, by the field it sorted by (SaFE's default: creationTime). */
function sortMerged(items: Record<string, unknown>[], input: Record<string, unknown>): void {
  const field = typeof input.sort_by === "string" && input.sort_by.trim() ? input.sort_by.trim() : "creationTime";
  const asc = input.order === "asc";
  items.sort((a, b) => {
    const x = a[field];
    const y = b[field];
    if (x === y) return 0;
    if (x === undefined || x === null) return 1;
    if (y === undefined || y === null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x) < String(y) ? -1 : 1;
    return asc ? c : -c;
  });
}

/**
 * A call of one of WORKSPACE_FANOUT's lists: as the model made it, and, when SaFE refuses it as unscoped, across the caller's
 * workspaces. `outcome.isError` is the merged answer's: set only when no workspace could be read.
 */
export async function callWithWorkspaceFanout(
  client: McpToolCaller, name: string, tool: string, input: Record<string, unknown>,
  outcome?: McpCallOutcome, meta?: Record<string, unknown>, signal?: AbortSignal,
): Promise<string> {
  const spec = WORKSPACE_FANOUT[name];
  if (!spec || !unscoped(input, spec.arg)) return client.callTool(tool, input, outcome, meta, signal);

  const first: McpCallOutcome = { isError: false };
  const firstText = await client.callTool(tool, input, first, meta, signal);
  if (!isForbidden(first.isError, firstText)) {
    if (outcome) {
      outcome.isError = first.isError;
      if (first.sources) outcome.sources = first.sources;
    }
    return firstText;
  }

  const self: McpCallOutcome = { isError: false };
  let selfText: string;
  try {
    selfText = await client.callTool(spec.selfTool, {}, self, meta, signal);
  } catch (err) {
    selfText = String((err as Error)?.message ?? err);
    self.isError = true;
  }
  const workspaces = self.isError ? null : workspacesOfSelf(selfText);
  if (workspaces === null) {
    // Which workspaces the caller has could not be read: the refusal stands, said for what it is.
    if (outcome) outcome.isError = true;
    return `${firstText}\n[SaFE lists every workspace's workloads only for an admin; the workspaces this user may use could not be read `
      + `(${spec.selfTool}: ${reasonOf(selfText)}), so call this tool again with ${spec.arg} set to a workspace of theirs.]`;
  }

  const read = workspaces.slice(0, FANOUT_MAX_WORKSPACES);
  const notRead = workspaces.slice(FANOUT_MAX_WORKSPACES);
  const pages = new Map<string, Page>();
  const failed: Array<{ workspace_id: string; error: string }> = [];
  let next = 0;
  const worker = async () => {
    while (next < read.length) {
      const ws = read[next++];
      if (signal?.aborted) {
        failed.push({ workspace_id: ws, error: "not read: the run was stopped" });
        continue;
      }
      const o: McpCallOutcome = { isError: false };
      try {
        const text = await client.callTool(tool, { ...input, [spec.arg]: ws }, o, meta, signal);
        const page = o.isError ? null : pageOf(text);
        if (page) pages.set(ws, page);
        else failed.push({ workspace_id: ws, error: reasonOf(text) });
      } catch (err) {
        failed.push({ workspace_id: ws, error: reasonOf(String((err as Error)?.message ?? err)) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, read.length) }, worker));

  const order = (ws: string) => read.indexOf(ws);
  failed.sort((a, b) => order(a.workspace_id) - order(b.workspace_id));
  const counted = read.filter((ws) => pages.has(ws));
  const items: Record<string, unknown>[] = [];
  let totalCount = 0;
  for (const ws of counted) {
    const page = pages.get(ws)!;
    totalCount += page.totalCount;
    for (const item of page.items) items.push(item.workspaceId === undefined ? { ...item, workspaceId: ws } : item);
  }
  sortMerged(items, input);
  const limit = limitOf(input);
  const shown = items.slice(0, limit);
  const complete = failed.length === 0 && notRead.length === 0;

  if (outcome) outcome.isError = workspaces.length > 0 && counted.length === 0;
  const note = workspaces.length === 0
    ? "SaFE lists every workspace's workloads only for an admin, and this user is a member of no workspace: there are no workloads they can list."
    : `SaFE lists every workspace's workloads only for an admin, so this is the list across the ${workspaces.length} workspace(s) this user `
      + `may use, one page of each. totalCount (${totalCount}) is the sum of the counts of the ${counted.length} workspace(s) read`
      + (complete ? ", which is every one of them." : "; it is not the whole count: the workspaces in workspaces_failed and workspaces_not_read are not in it, say so.");
  return JSON.stringify({
    items: shown,
    totalCount,
    scope: "caller_workspaces",
    complete,
    truncated: shown.length < totalCount,
    workspaces: counted.map((ws) => ({ workspace_id: ws, totalCount: pages.get(ws)!.totalCount, returned: pages.get(ws)!.items.length })),
    ...(failed.length ? { workspaces_failed: failed } : {}),
    ...(notRead.length ? { workspaces_not_read: notRead } : {}),
    note,
  });
}
