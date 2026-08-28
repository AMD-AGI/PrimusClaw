// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Workbench abstraction types (workbench-architecture.md §5).
 *
 * A "workbench" wraps a plugin + a fixed Task DAG + a few SQL queries behind a
 * single shape so the frontend can render Catalog / Runs / Leaderboard pages
 * generically. Workbench registration lives in code (no DB table) and is wired
 * through side-effect imports at API boot.
 *
 * Concrete workbenches live under `api/src/workbenches/<id>/` and register at API
 * boot through `workbenchRegistry.register(...)`.
 */
import type { Logger } from "pino";

/** Single score metric the frontend should display + how to format it. */
export interface ScoreMetricDef {
  /** Path inside `score` JSON the value lives at (e.g. "average_speedup"). */
  id: string;
  label: string;
  /**
   * Rendering hint — frontend turns this into a fixed format function.
   * `x`   → `1.23x`
   * `%`   → `87.5%`
   * `ms`  → `12.3 ms`
   * `0`   → integer
   * `2`   → 2-decimal float (default)
   */
  format?: "x" | "%" | "ms" | "0" | "1" | "2" | "3";
}

/** A column the frontend Runs list should render. */
export interface ColumnDef {
  id: string;
  label: string;
  /** Dot-path inside the run row (e.g. "summary.label"). */
  path: string;
  /** Same vocabulary as ScoreMetricDef.format. */
  format?: ScoreMetricDef["format"];
}

/** Free-form filter option exposed by the workbench to the UI. */
export interface FilterOptionDef {
  id: string;
  label: string;
  /** Static option set; absent when filter is free-text. */
  options?: string[];
  /** When true the filter is multi-select. */
  multi?: boolean;
  /** When true the filter is a free-text input. */
  text?: boolean;
}

/** Per-request context handed to every workbench handler. */
export interface WorkbenchCtx {
  user_id: string;
  workspace_id: string;
  log: Logger;
}

export interface WorkbenchPluginRef {
  name: string;
  /** Pin a specific version, or omit to resolve to the latest active. */
  version?: string;
}

export interface AgentOptionDef {
  id: string;
  label: string;
  ready?: boolean;
  reason?: string;
}

/** A single catalog entry surfaced by a workbench. */
export interface CatalogItem {
  item_id: string;
  item_version: number;
  title: string;
  tags: string[];
  /** Free-form workbench payload exposed to the detail modal. */
  metadata: Record<string, unknown>;
  created_at?: string;
}

export interface CatalogListResponse {
  /** Workbench-level defaults the UI may surface in a "slice" widget. */
  default_slice?: Record<string, unknown>;
  /** Aggregations / counts for filter pills. */
  groups?: Array<{ id: string; label: string; count: number }>;
  /** Filter inputs the UI should render alongside this list. */
  filters?: { available: FilterOptionDef[] };
  items: CatalogItem[];
}

export interface CatalogItemDetail extends CatalogItem {
  /** Recent run attempts touching this catalog item. */
  attempts_history?: unknown[];
  /** Per-item leaderboard. */
  leaderboard_top?: unknown[];
  /** Any extra blocks the frontend may render verbatim. */
  [key: string]: unknown;
}

/** One row in the Runs list. */
export interface RunSummary {
  /** Human readable identity. */
  label: string;
  /** Score blob keyed by `ScoreMetricDef.id`. */
  score?: Record<string, unknown> | null;
  /** Free-form extras the frontend may surface in extra columns. */
  [key: string]: unknown;
}

export interface RunsListItem {
  run_id: string;
  session_id: string;
  dag_id: string;
  status: string;
  failure_reason: string | null;
  error_message: string | null;
  input: Record<string, unknown>;
  summary: RunSummary;
  created_at: string;
  completed_at: string | null;
}

export interface RunsListResponse {
  runs: RunsListItem[];
  total: number;
}

/** Workbench definition contract (see workbench-architecture.md §5). */
export interface WorkbenchDef {
  id: string;
  title: string;
  description: string;
  /**
   * Reference to the plugin row that owns this workbench's runtime defaults
   * (sandbox image, resource limits, tool list, version). The plugin row is
   * looked up by `name + version` when a run is created;
   * each `claw_tasks` row created by the workbench inherits from it via
   * `applyPluginDefaults`. The plugin row must be seeded before the
   * workbench can create runs.
   *
   * Workbench → plugin is N:1 (multiple workbenches may surface the same
   * plugin; e.g. evaluation vs exploration variants).
   */
  plugin_ref?: WorkbenchPluginRef;
  plugin_resolver?: (input: Record<string, unknown>) => WorkbenchPluginRef;
  public_plugins?: Record<string, WorkbenchPluginRef>;
  agent_options?: AgentOptionDef[];
  /** Main DAG template the workbench instantiates per run. */
  dag_id: string;
  /** Optional batch-level aggregator DAG. */
  batch_dag_id?: string;

  /** Frontend hints. */
  ui: {
    icon_gradient?: [string, string];
    catalog_label: string;
    run_label: string;
    score_metrics: ScoreMetricDef[];
    columns?: ColumnDef[];
    filter_options?: FilterOptionDef[];
  };

  catalog: {
    list(ctx: WorkbenchCtx, filters: Record<string, unknown>): Promise<CatalogListResponse>;
    get(ctx: WorkbenchCtx, itemId: string): Promise<CatalogItemDetail | null>;
  };

  runs: {
    /**
     * Optional DAG node id whose metadata/captures should be joined into
     * list responses for summary rendering.
     */
    summary_node_id?: string;
    /**
     * Convert the createRun POST body into the input passed to expandDag.
     * Throw a regular Error for validation failures; the route turns
     * thrown errors into 400 responses.
     */
    normaliseInput(body: Record<string, unknown>, ctx: WorkbenchCtx): Record<string, unknown>;
    /**
     * Optional override of the auto-generated session name for new runs.
     * Defaults to `${workbench.id}-run` when omitted.
     */
    sessionName?(body: Record<string, unknown>): string;
    /**
     * Map a claw_tasks root row (plus optionally-joined child rows) into the
     * RunsList summary. Receives:
     *   - rootRow:  claw_tasks row with dag_node_id='__dag_root__'
     *   - children: optional per-node child rows when the route joined them
     */
    rowToSummary(
      rootRow: Record<string, unknown>,
      children?: Record<string, unknown>[],
    ): RunSummary;
    /**
     * Optional list-time WHERE filter; the route gives the workbench a chance
     * to translate `?foo=...` query params into a SQL fragment + params.
     *
     * The route passes `baseParamIndex` (1-based, points at the next free
     * `$N` slot). The workbench must emit positional `$N` placeholders starting
     * at that index. Return null to skip.
     */
    extraWhere?(
      filters: Record<string, unknown>,
      baseParamIndex: number,
    ): { fragment: string; params: unknown[] } | null;
  };

  leaderboard: {
    /**
     * Workbench-defined leaderboard. Shape is intentionally free-form (cross-
     * workbench shapes diverge heavily); the UI consults `workbench.ui.score_metrics`
     * + `workbench.ui.filter_options` to render.
     */
    query(ctx: WorkbenchCtx, filters: Record<string, unknown>): Promise<unknown>;
  };
}

/** Public summary returned by `GET /v1/workbenches`. */
export interface WorkbenchPublicEntry {
  id: string;
  title: string;
  description: string;
  plugin_ref?: WorkbenchPluginRef;
  plugins_by_agent?: Record<string, WorkbenchPluginRef>;
  agent_options?: AgentOptionDef[];
  dag_id: string;
  batch_dag_id?: string;
  ui: WorkbenchDef["ui"];
}

/** Resolved plugin row used at runtime. Mirrors what dag-expander expects. */
export interface ResolvedPlugin {
  id: number;
  name: string;
  version: string;
  image: string;
  resource: Record<string, unknown>;
  tools: unknown[];
}
