// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * WorkbenchRegistry — process-global registry of every Workbench the API knows
 * about (workbench-architecture.md §5).
 *
 * Symmetric to `backend-mcp/registry.ts`. Workbenches register themselves at
 * boot time via side-effect imports under `api/src/workbenches/<id>/index.ts`.
 */
import { MarketplaceDb, type JsonObject } from "../infra/db.js";
import { enrichPluginToolsInline, pluginSandboxImage } from "../marketplace/plugins.js";
import type { ResolvedPlugin, WorkbenchDef, WorkbenchPluginRef, WorkbenchPublicEntry } from "./types.js";

export class WorkbenchRegistry {
  private readonly entries = new Map<string, WorkbenchDef>();

  register(def: WorkbenchDef): void {
    if (this.entries.has(def.id)) {
      throw new Error(`Workbench already registered: ${def.id}`);
    }
    this.entries.set(def.id, def);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): WorkbenchDef | null {
    return this.entries.get(id) ?? null;
  }

  list(): WorkbenchPublicEntry[] {
    return Array.from(this.entries.values())
      .map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        plugin_ref: d.plugin_ref,
        plugins_by_agent: d.public_plugins,
        agent_options: d.agent_options,
        dag_id: d.dag_id,
        batch_dag_id: d.batch_dag_id,
        ui: d.ui,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Resolve the plugin row referenced by a workbench for the given run input. */
  async resolvePlugin(workbenchId: string, input: Record<string, unknown> = {}): Promise<ResolvedPlugin> {
    const def = this.get(workbenchId);
    if (!def) throw new Error(`workbench not found: ${workbenchId}`);
    const ref = def.plugin_resolver ? def.plugin_resolver(input) : def.plugin_ref;
    if (!ref) throw new Error(`plugin not configured for workbench '${workbenchId}'`);
    return await this.resolvePluginRef(ref, `workbench '${workbenchId}'`);
  }

  /** Resolve a concrete plugin ref. */
  async resolvePluginRef(ref: WorkbenchPluginRef, label = "plugin"): Promise<ResolvedPlugin> {
    const name = ref.name;
    const version = ref.version;
    // Do not cache plugin rows here. `seed.sh` and `/v1/plugins/upsert` update
    // image/resource in-place under the same (name, version), and new runs must
    // see those changes without an API restart.
    const row = version
      ? await MarketplaceDb.pluginActiveByNameAndVersion(name, version)
      : await pickLatestActive(name);
    if (!row) {
      throw new Error(
        `plugin not seeded for ${label}: name=${name} version=${version ?? "<latest>"}`,
      );
    }
    // Inline-enrich `tools` so dag-expander reads `name`/`config` directly
    // instead of the V1-style `{id, type, version}` refs persisted on the row.
    const enrichedTools = await enrichPluginToolsInline(row.tools);
    const resolved: ResolvedPlugin = {
      id: Number(row.id),
      name: String(row.name),
      version: String(row.version),
      // The row holds a list, one repo per framework; a resolved plugin carries
      // the one image its run uses, so the first usable entry is taken here.
      image: pluginSandboxImage(row.images),
      resource: (row.resource ?? {}) as Record<string, unknown>,
      tools: enrichedTools as unknown[],
    };
    return resolved;
  }

  /** Kept for call-sites/tests; resolution is uncached. */
  invalidatePluginCache(): void {
  }
}

async function pickLatestActive(name: string): Promise<JsonObject | null> {
  const rows = await MarketplaceDb.pluginsActiveByName(name);
  if (!rows.length) return null;
  // `pluginsActiveByName` orders by created_at DESC; first row is latest active.
  return rows[0] ?? null;
}

export const workbenchRegistry = new WorkbenchRegistry();
