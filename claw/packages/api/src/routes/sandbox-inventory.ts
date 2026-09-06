// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The fleet census every rollout gate and every rollback step iterates.
 *
 * Two ways it used to lie, both of which read as a smaller fleet rather than as
 * a failed read -- which is the direction that matters, because a step that
 * drains "everything it can see" then stops early.
 *
 * A record it could not decode was skipped and the answer still said `ok`, so a
 * corrupt row dropped a live sandbox out of both the listing and the count. An
 * unreadable record now fails the whole read: the count of them is reported so
 * an operator knows what to repair, but the answer is not `ok` and no step may
 * proceed on it. A row that parses but carries no usable identity is the same
 * failure wearing valid JSON -- nothing can be pinged or deleted by it -- and is
 * counted the same way.
 *
 * And it enumerated session keys only. A DAG node resolves its sandbox through
 * the handle map instead -- deliberately, because every node of a DAG shares one
 * session id and the session key holds whichever sandbox last wrote it -- so a
 * live DAG sandbox is absent from the session listing, or present only as a
 * stale sibling. Those rows are the other half of the fleet and are returned
 * beside it, keyed by the name and namespace a rollback actually deletes by.
 */

import type { HandleInfo } from "@claw/protocol";

export interface SandboxRow {
  session_id: string;
  workload_id: string;
  hands_url: string;
  sandbox_image: string | null;
  created_at: string | null;
  has_platform_key: boolean;
  sandbox_name: string;
  namespace: string;
  provider: string;
  healthy: boolean;
}

export interface DagHandleRow {
  dag_root_task_id: string;
  handle: string;
  sandbox_name: string;
  namespace: string;
  hands_url: string;
  workload_id: string;
  provider: string;
}

export interface SandboxInventory {
  /** False where any record could not be read; never a smaller fleet. */
  ok: boolean;
  /** Every row returned, session and DAG handle alike. */
  count: number;
  /** Records that exist and could not be used. Any at all fails the read. */
  unreadable: number;
  sessions: SandboxRow[];
  dag_handles: DagHandleRow[];
  error?: string;
}

export interface InventoryDeps {
  /** Session bindings, keyed `hands.<sessionId>`. */
  handsKeys(filter: string): Promise<string[]>;
  handsGet(key: string): Promise<string | null>;
  /**
   * Every DAG handle row Brain has written. Absent or throwing is a failed
   * read: the route answers `ok:false` rather than a sessions-only inventory,
   * because a build whose census cannot see a DAG sandbox at all must not look
   * like a deployment that has none.
   */
  dagHandles(): Promise<Array<[string, Record<string, HandleInfo>]>>;
  probeHealth(handsUrl: string): Promise<boolean>;
  sessionIdFromKey(key: string): string;
}

export const HANDS_KEY_FILTER = "hands.*";

function rowFromEntry(sessionId: string, info: Record<string, unknown>, healthy: boolean): SandboxRow {
  return {
    session_id: sessionId,
    workload_id: (info.workloadId as string) || "",
    hands_url: (info.handsUrl as string) || "",
    sandbox_image: (info.sandboxImage as string) ?? null,
    created_at: (info.createdAt as string) ?? null,
    has_platform_key: Boolean(info.platformKey),
    // `workload_id` is empty on the kubernetes path, so the provider is what
    // classifies a row rather than that emptiness -- and the name and namespace
    // are what a rollback addresses the Sandbox by.
    sandbox_name: (info.sandboxName as string) || "",
    namespace: (info.namespace as string) || "",
    provider: (info.provider as string) || "",
    healthy,
  };
}

function dagRows(all: Array<[string, Record<string, HandleInfo>]>): DagHandleRow[] {
  return all.flatMap(([dagRootTaskId, handles]) =>
    Object.entries(handles).map(([handle, info]) => ({
      dag_root_task_id: dagRootTaskId,
      handle,
      sandbox_name: info.sandbox_name || "",
      namespace: info.namespace || "",
      hands_url: info.hands_url || "",
      workload_id: info.workload_id || "",
      provider: info.provider || "",
    })));
}

/**
 * A row that parses and still cannot be used.
 *
 * A binding with no endpoint cannot be pinged and one with no name and no
 * workload id cannot be deleted, so it is a sandbox this census can neither
 * drain nor prove drained -- the same hole a corrupt record leaves, and treated
 * the same way rather than returned as a row that looks complete.
 */
function isUsable(info: Record<string, unknown>): boolean {
  const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  return nonEmpty(info.handsUrl)
    && (nonEmpty(info.sandboxName) || nonEmpty(info.workloadId));
}

/**
 * Read the whole fleet, or fail.
 *
 * Throws where either half cannot be read, and answers `ok:false` where any
 * individual record could not be used. Nothing here converts an unreadable
 * source into an empty one: every gate and every rollback step iterates this,
 * and a step that drains what it can see and then reports itself finished is
 * exactly what a silently shortened fleet produces.
 */
export async function collectSandboxInventory(deps: InventoryDeps): Promise<SandboxInventory> {
  const sessions: SandboxRow[] = [];
  let unreadable = 0;

  for (const key of await deps.handsKeys(HANDS_KEY_FILTER)) {
    const raw = await deps.handsGet(key);
    if (raw === null) continue;
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      unreadable += 1;
      continue;
    }
    if (!isUsable(info)) {
      unreadable += 1;
      continue;
    }
    sessions.push(rowFromEntry(
      deps.sessionIdFromKey(key), info, await deps.probeHealth(info.handsUrl as string),
    ));
  }

  const dag_handles = dagRows(await deps.dagHandles());
  return {
    ok: unreadable === 0,
    count: sessions.length + dag_handles.length,
    unreadable,
    sessions,
    dag_handles,
    ...(unreadable > 0
      ? { error: `${unreadable} sandbox record(s) could not be read; this inventory is incomplete` }
      : {}),
  };
}
