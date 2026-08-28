// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `initDb` is required to have produced, checked after it has run.
 *
 * Schema setup is a long list of idempotent DDL statements, most of them
 * followed by a catch that discards the error. That is deliberate -- the
 * statements race between replicas and re-run on every boot, so most failures
 * are a second replica having got there first -- but it means a statement that
 * failed for a real reason is indistinguishable from one that was a no-op, and
 * `db.migrated` was logged either way. The column simply is not there, and the
 * first request that needs it fails at runtime with `column does not exist`,
 * arbitrarily far from the boot that caused it.
 *
 * Rather than make each statement fatal -- which would turn a benign race into
 * a crash loop, and cannot tell the two apart anyway -- the result is checked
 * once at the end. Whether a particular ALTER succeeded is not the interesting
 * question; whether the column the code is about to use exists is.
 *
 * This list is not the whole schema. It carries the tables and columns whose
 * absence would break a request path, and it is meant to grow when a migration
 * adds something the code then depends on.
 *
 * The question it answers is only whether the column is there, never whether it
 * is the column the code thinks it is: types, nullability and defaults are not
 * compared. That boundary matters most on `claw_memory_entries`, which has two
 * independent migration owners -- this file's `initDb` and the Python
 * memory-service's `002_kb_extension.sql` -- both declaring their columns with
 * `ADD COLUMN IF NOT EXISTS`. Whichever runs first defines the type and the
 * other silently no-ops, and a divergence there passes this check.
 */

export interface SchemaRequirement {
  table: string;
  columns: string[];
}

/** A column somewhere in the database, as `information_schema` reports it. */
export interface PresentColumn {
  table_name: string;
  column_name: string;
}

export const REQUIRED_SCHEMA: SchemaRequirement[] = [
  {
    table: "claw_sessions",
    // The cleanup columns are in the list because deleting a session writes
    // them in the same transaction that hides it. Absent, that statement fails
    // and every delete answers 503 -- and the deployment where that is easiest
    // to miss is the one where nobody deletes anything for a week.
    columns: [
      "session_id", "user_id", "agent_status", "status", "config", "created_at",
      "cleanup_state", "cleanup_attempts", "cleanup_next_at", "cleanup_error",
    ],
  },
  {
    table: "claw_session_events",
    columns: ["event_id", "session_id", "event", "data", "created_at"],
  },
  {
    table: "claw_tasks",
    columns: [
      "task_id", "session_id", "status", "dag_root_task_id", "dag_node_id",
      "depends_on", "priority", "executor", "metadata",
      // Added for per-run budgets. The sweeper reads it on every tick and the
      // status transition writes it, so an upgrade that lost this column would
      // leave every in-flight run judged by the legacy global timeout with
      // nothing said about it.
      "deadline_at",
      // The run archive. Chat turns write rows carrying these, so a partially
      // applied migration here means every chat dispatch fails on insert --
      // which is the failure this guard exists to move to startup.
      "origin", "workspace_id", "lease_owner", "lease_expires_at", "heartbeat_at", "event_seq",
      "claim_count",
      "created_at", "queued_at", "started_at", "completed_at",
    ],
  },
  {
    table: "claw_conversation_turns",
    // The history every later prompt is built from. `message_id` earns its
    // place here rather than in the list of columns nobody checks: it is what
    // makes a re-published completion write one turn instead of two, and
    // without it the insert that carries it fails outright, so a completion
    // that ran perfectly well loses its turn entirely.
    columns: ["session_id", "turn_index", "role", "content", "message_id"],
  },
  {
    table: "claw_pending_messages",
    // `topology` joins them because the queue path reads the whole row back
    // and republishes it: a column missing here is a field that vanishes for
    // any message that had to wait, and for this one that means a job asking
    // for a GPU cluster quietly running on one node.
    //
    // `bind_attempts` is the counter that bounds the replay's retry. Absent, a
    // refused binding cannot be counted, so the bound is never reached and the
    // completion event driving the replay is redelivered every ten seconds for
    // as long as the stream holds it -- the loop the counter was added to stop.
    //
    // `credentials_blob` is the sealed LLM/platform keys for a queued turn
    // when doorbell dispatch is on. Without it the drain cannot claim, and
    // the plaintext columns are left empty on purpose.
    columns: [
      "session_id", "content", "user_env", "session_env", "topology",
      "bind_attempts", "credentials_blob",
    ],
  },
  {
    table: "claw_workspaces",
    // Every write against these is best-effort, so a missing table costs no
    // request -- which is exactly why it belongs here. The damage shows up
    // somewhere else entirely and much later: the collector asks who still
    // references a workspace, gets nothing, and falls back to deciding from
    // mtime on files it was supposed to have been told about.
    columns: [
      "workspace_id", "owner_user_id", "storage_prefix", "version",
      "writer_run_id", "writer_expires_at", "retention_expires_at", "deleted_at",
    ],
  },
  {
    table: "claw_workspace_refs",
    columns: ["workspace_id", "ref_kind", "ref_id", "created_at", "released_at"],
  },
  {
    table: "claw_memory_entries",
    // The reason this guard exists, found the long way round. `kind` separates
    // the rows decay is allowed to forget from the KB rows it must not touch,
    // and the ALTER that adds it discards its error like every other. When the
    // column was absent the daily decay threw `column "kind" does not exist`
    // into a cron log nobody reads, and the only visible symptom was that
    // memory never faded -- a job silently not running, for months, with no
    // request path failing to say so.
    columns: [
      "id", "user_id", "category", "content", "importance",
      "access_count", "created_at", "last_accessed", "deleted_at", "kind",
    ],
  },
];

/**
 * Which required tables and columns are absent from what the database reports.
 *
 * Pure so the requirement list can be checked without a database. Returns one
 * message per problem rather than throwing on the first, because an upgrade
 * that lost one column usually lost several and finding them one boot at a
 * time is the slow way.
 */
export function missingSchemaObjects(
  required: SchemaRequirement[],
  present: PresentColumn[],
): string[] {
  const byTable = new Map<string, Set<string>>();
  for (const col of present) {
    let cols = byTable.get(col.table_name);
    if (!cols) byTable.set(col.table_name, (cols = new Set()));
    cols.add(col.column_name);
  }

  const problems: string[] = [];
  for (const req of required) {
    const cols = byTable.get(req.table);
    if (!cols) {
      // One line for the whole table: listing every column of a table that is
      // not there says the same thing N times.
      problems.push(`table ${req.table} is missing`);
      continue;
    }
    const absent = req.columns.filter((c) => !cols.has(c));
    if (absent.length > 0) {
      problems.push(`${req.table} is missing column(s): ${absent.join(", ")}`);
    }
  }
  return problems;
}
