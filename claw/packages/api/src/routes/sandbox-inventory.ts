// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Complete fleet census used by rollout and rollback operations.
 * Any unreadable or unusable record fails the census instead of shrinking it;
 * session bindings and DAG handles are both included. A binding still being
 * provisioned is a row and not a hole: it already names what a rollback deletes
 * by, and only its endpoint is missing.
 */

import { isRetentionEntry, type HandleInfo } from "@claw/protocol";

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
  /**
   * The binding's own lifecycle state -- `"pending"` or `"ready"`, and empty on
   * a record written without one. A row that is still being provisioned has no
   * endpoint yet, and saying which it is here is what stops an operator reading
   * that emptiness as a sandbox that exists and cannot be reached.
   */
  status: string;
  /**
   * Whether this row is a retained container rather than a session binding.
   *
   * It is reported and never filtered out: retaining a container deletes the
   * session key once the reserved key is written, so this entry is the only
   * record the bucket still holds for a physically live sandbox. Dropping it
   * would leave a pre-change sandbox that no rollback allow-list built from
   * this census ever names, which is the silently shortened fleet the whole
   * route exists to refuse. What it is not is a session: `session_id` here is
   * the reserved key part and answers to nothing, and the container is under
   * standing orders never to be idled or reused -- so it never drains by
   * waiting, and an operator told to wait one out is being told to wait
   * forever.
   *
   * Read from the entry's value and never from its key, the way the keepalive
   * census reads it. For the length of a rolling upgrade a replica that
   * predates the retention scheme writes a genuine session binding under the
   * reserved key, and a key-shaped test would report that binding as retained.
   */
  retained: boolean;
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
    status: typeof info.status === "string" ? info.status : "",
    retained: isRetentionEntry(info),
  };
}

/**
 * The DAG half of the fleet, and the rows of it that cannot be used.
 *
 * Held to the same standard as the session half: a handle carrying no endpoint
 * and nothing to delete by is a sandbox this census can neither drain nor prove
 * drained, whether it failed to parse or merely came back empty.
 */
function dagRows(
  all: Array<[string, Record<string, HandleInfo>]>,
): { rows: DagHandleRow[]; unreadable: number } {
  const rows: DagHandleRow[] = [];
  let unreadable = 0;
  for (const [dagRootTaskId, handles] of all) {
    // A row whose whole value is null or not an object is a DAG's entire handle
    // set unreadable, not a DAG with no handles: turning it into an empty map
    // drops every sandbox it named and reports a clean census.
    if (!handles || typeof handles !== "object" || Array.isArray(handles)) {
      unreadable += 1;
      continue;
    }
    for (const [handle, info] of Object.entries(handles)) {
      if (!info || typeof info !== "object" || !isUsable({
        handsUrl: info.hands_url,
        sandboxName: info.sandbox_name,
        namespace: info.namespace,
        workloadId: info.workload_id,
        provider: info.provider,
        // A handle registered while its workload is still provisioning carries
        // no endpoint yet, and the session rows have always been allowed to say
        // so. Without translating it, an ordinary queued workload is counted
        // `unreadable` -- a census that reports a row it understands perfectly
        // well as one it could not parse.
        status: info.pending ? "pending" : undefined,
      })) {
        unreadable += 1;
        continue;
      }
      rows.push({
        dag_root_task_id: dagRootTaskId,
        handle,
        sandbox_name: info.sandbox_name || "",
        namespace: info.namespace || "",
        hands_url: info.hands_url || "",
        workload_id: info.workload_id || "",
        provider: info.provider || "",
      });
    }
  }
  return { rows, unreadable };
}

/**
 * A row that parses and still cannot be used.
 *
 * A binding with no endpoint and no in-flight provision to explain it cannot be
 * pinged, and one with no name and no workload id cannot be deleted, so it is a
 * sandbox this census can neither drain nor prove drained -- the same hole a
 * corrupt record leaves, and treated the same way rather than returned as a row
 * that looks complete.
 */
function isUsable(info: Record<string, unknown>): boolean {
  const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  // An entry past provisioning must name an endpoint; one still in it
  // legitimately carries none. The SaFE path writes `status:"pending"` the
  // moment a workload id exists and only promotes it to `"ready"` once
  // bootstrap and health have passed, nothing reclaims it in between, and the
  // queue wait it covers runs to hours -- so holding a pending entry to the
  // endpoint rule fails the whole census for the length of a perfectly normal
  // wait. It still names the workload a rollback deletes by, which is what the
  // identity test below decides; only the ping is missing, and `healthy:false`
  // is what says so. The kubernetes path is single-phase and never writes one,
  // so the rows the rollout gates iterate are unchanged.
  if (info.status !== "pending" && !nonEmpty(info.handsUrl)) return false;
  // What a rollback deletes by differs per provider, so "has an identifier" is
  // not the test: a kubernetes Sandbox is addressed by name *and* namespace,
  // and a row carrying one without the other names nothing kubectl can reach.
  if (info.provider === "agent-sandbox") {
    return nonEmpty(info.sandboxName) && nonEmpty(info.namespace);
  }
  if (nonEmpty(info.workloadId)) return true;
  // An unstated provider is classified by what it carries, and carries enough
  // only if it is addressable as a Sandbox.
  return nonEmpty(info.sandboxName) && nonEmpty(info.namespace);
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
    // `handsUrl` is genuinely absent on a pending row, so the probe is asked
    // only where there is something to ask about: `healthy:false` is already
    // the answer for a binding that cannot be pinged yet.
    const handsUrl = (info.handsUrl as string) || "";
    sessions.push(rowFromEntry(
      deps.sessionIdFromKey(key), info,
      handsUrl ? await deps.probeHealth(handsUrl) : false,
    ));
  }

  const dag = dagRows(await deps.dagHandles());
  unreadable += dag.unreadable;
  const dag_handles = dag.rows;
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
