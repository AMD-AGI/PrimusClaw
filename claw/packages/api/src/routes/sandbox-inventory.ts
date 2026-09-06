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
 * corrupt row dropped a live sandbox out of both the listing and the count. The
 * skipped ones are counted and returned instead, and a caller that needs a
 * census refuses any answer whose count is not zero.
 *
 * And it enumerated session keys only. A DAG node resolves its sandbox through
 * the handle map instead -- deliberately, because every node of a DAG shares one
 * session id and the session key holds whichever sandbox last wrote it -- so a
 * live DAG sandbox is absent from the session listing, or present only as a
 * stale sibling. Those rows are the other half of the fleet and are returned
 * beside it, keyed by the name and namespace a rollback actually deletes by.
 */

import { HANDLE_MAP_PREFIX, type HandleInfo } from "@claw/protocol";

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
  ok: true;
  count: number;
  /** Records that exist and could not be decoded. A census with any is refused. */
  unreadable: number;
  sessions: SandboxRow[];
  dag_handles: DagHandleRow[];
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
 * Read the whole fleet, or fail.
 *
 * Throws where either half cannot be read. The caller reports that as
 * `ok:false`; nothing here converts an unreadable source into an empty one.
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
    const handsUrl = (info.handsUrl as string) || "";
    sessions.push(rowFromEntry(
      deps.sessionIdFromKey(key), info, handsUrl ? await deps.probeHealth(handsUrl) : false,
    ));
  }

  return {
    ok: true,
    count: sessions.length,
    unreadable,
    sessions,
    dag_handles: dagRows(await deps.dagHandles()),
  };
}

export const DAG_HANDLE_PREFIX = `${HANDLE_MAP_PREFIX}.`;
