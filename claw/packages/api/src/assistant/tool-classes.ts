// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which MCP tools read and which write, from one closed set (`mcp-tool-catalog.ts` of `@claw/protocol`): each server's
 * `tools/list`, its annotations, and a reviewed class for every tool the annotations leave open. Two lists are derived from it
 * and from nothing else:
 *
 *  - the reads a router turn may call (`routerReadsByServer`, which `read-tools.ts` serves as ROUTER_READ_TOOLS);
 *  - what an approval policy must hold (`approvalSpec`, `specProblems`): every write, released only where the catalog says a
 *    write is safe to run without a decision. Brain enforces the same at run time (`approval-policy.ts`): a catalogued write is
 *    held whatever the spec says, so a spec that fell behind is reported here and nightly, and still never lets a write run.
 *
 * A hand-kept list drifts from the server it describes: a write added to a server and not to a plugin's `requires_approval`
 * runs without asking, and a read never added to the router's list sends a one-lookup question to a worker. Derived from the
 * catalog, the lists move with it; and the tests (`test/tool-classes.test.ts`) and the nightly comparison with the live servers
 * (`test/e2e/tool-classes-live.ts`) fail on a tool the catalog does not classify.
 *
 * Annotations decide where they say something: `readOnlyHint: true` is a read; `readOnlyHint: false` or `destructiveHint: true`
 * is a write (and so is a tool that claims both). A reviewed class may only fill what they leave open, never contradict them.
 */
import { TOOL_CATALOG, catalogClassOf, hintedClass, type ServerCatalog, type ToolCatalog, type ToolClass, type ToolHints } from "@claw/protocol";

export { hintedClass };
export type { ServerCatalog, ToolClass, ToolHints };
export type Catalog = ToolCatalog;

export interface ToolProblem { server: string; tool: string; problem: string }

const own = <T>(o: Readonly<Record<string, T>> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);

/** A listed tool's class, or null when it is not listed or nothing classifies it. */
export const classOf = (server: string, tool: string, catalog: Catalog = TOOL_CATALOG): ToolClass | null => catalogClassOf(server, tool, catalog);

/** Everything wrong with the catalog itself: [] when every tool has exactly one class and every decision names a tool it fits. */
export function catalogProblems(catalog: Catalog = TOOL_CATALOG): ToolProblem[] {
  const out: ToolProblem[] = [];
  for (const [server, c] of Object.entries(catalog)) {
    const p = (tool: string, problem: string): void => { out.push({ server, tool, problem }); };
    for (const [tool, hints] of Object.entries(c.tools)) {
      const hinted = hintedClass(hints);
      const reviewed = own(c.reviewed, tool);
      if (reviewed !== undefined && reviewed !== "read" && reviewed !== "write") p(tool, `reviewed class ${String(reviewed)} is neither read nor write`);
      else if (!hinted && !reviewed) p(tool, "unclassified: no annotation decides it and it is not reviewed");
      else if (hinted && reviewed && hinted !== reviewed) p(tool, `reviewed as ${reviewed}, annotated as ${hinted}`);
    }
    for (const tool of Object.keys(c.reviewed)) if (!own(c.tools, tool)) p(tool, "reviewed, but the server does not list it");
    for (const [tool, why] of Object.entries(c.notForRouter ?? {})) {
      if (classOf(server, tool, catalog) !== "read") p(tool, "kept from the router, but not a listed read");
      if (!String(why).trim()) p(tool, "kept from the router without a reason");
    }
    for (const [tool, why] of Object.entries(c.releasable ?? {})) {
      if (classOf(server, tool, catalog) !== "write") p(tool, "releasable, but not a listed write");
      if (!String(why).trim()) p(tool, "releasable without a reason");
    }
  }
  return out;
}

/** A server's tools of one class, sorted. */
export function toolsOfClass(server: string, cls: ToolClass, catalog: Catalog = TOOL_CATALOG): string[] {
  const c = own(catalog, server);
  return c ? Object.keys(c.tools).filter((t) => classOf(server, t, catalog) === cls).sort() : [];
}

/** Per server, the reads a router turn may call: every read the catalog does not keep from it. Servers with none are left out. */
export function routerReadsByServer(catalog: Catalog = TOOL_CATALOG): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [server, c] of Object.entries(catalog)) {
    const reads = toolsOfClass(server, "read", catalog).filter((t) => own(c.notForRouter, t) === undefined);
    if (reads.length) out[server] = reads;
  }
  return out;
}

/**
 * The approval fields a server's spec should carry: hold every tool, and release the reads and the releasable writes. A tool
 * the server adds later is held until the catalog classifies it, so a write can never run unheld because a list fell behind.
 */
export function approvalSpec(server: string, catalog: Catalog = TOOL_CATALOG): { requires_approval: true; auto_approve: string[] } {
  const c = own(catalog, server);
  if (!c) throw new Error(`no catalog for MCP server ${server}`);
  return { requires_approval: true, auto_approve: [...toolsOfClass(server, "read", catalog), ...Object.keys(c.releasable ?? {}).sort()] };
}

/**
 * Whether a spec's `auto_approve` releases a tool for at least one call (an entry with a `when` releases some calls). Read as
 * Brain reads it (`brain/src/agent/approval-policy.ts`): both spellings that are present must release it, and a field that
 * cannot be read releases nothing.
 */
export function releasedBySpec(spec: Record<string, unknown>, tool: string): boolean {
  const fields = ["auto_approve", "autoApprove"].filter((k) => spec[k] !== undefined).map((k) => spec[k]);
  return fields.length > 0 && fields.every((v) => autoEntries(v)?.some((e) => (e.endsWith("*") ? tool.startsWith(e.slice(0, -1)) : tool === e)) === true);
}

/** An `auto_approve` value's tool names and prefixes, or null when Brain would not read it. */
function autoEntries(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out: string[] = [];
  for (const raw of value) {
    const entry = typeof raw === "string" ? { tool: raw } : raw;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { tool, when, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length || typeof tool !== "string" || !tool.trim() || tool.trim() === "*") return null;
    if (when !== undefined && (!when || typeof when !== "object" || Array.isArray(when) || !Object.keys(when).length)) return null;
    out.push(tool.trim());
  }
  return out;
}

/**
 * What a server's spec gets wrong against the catalog: a write it does not hold, or a write it releases that the catalog does
 * not call releasable. `held` says whether the spec holds a tool, as Brain decides it (`approvalPolicyFromMcp`), given the
 * server's own tool name.
 */
export function specProblems(server: string, spec: Record<string, unknown>, held: (tool: string) => boolean, catalog: Catalog = TOOL_CATALOG): ToolProblem[] {
  const c = own(catalog, server);
  if (!c) return [{ server, tool: "*", problem: "the catalog does not know this server: none of its tools is classified" }];
  const out: ToolProblem[] = [];
  for (const tool of toolsOfClass(server, "write", catalog)) {
    if (!held(tool)) out.push({ server, tool, problem: "a write the spec does not hold for approval" });
    else if (releasedBySpec(spec, tool) && own(c.releasable, tool) === undefined) out.push({ server, tool, problem: "a write the spec releases without a decision" });
  }
  return out;
}

/** What a server's live `tools/list` says that the catalog does not: a tool it does not list, one it no longer has, a changed class. */
export function listProblems(server: string, listed: ReadonlyArray<{ name: string; annotations?: ToolHints | null }>, catalog: Catalog = TOOL_CATALOG): ToolProblem[] {
  const c = own(catalog, server);
  if (!c) return [{ server, tool: "*", problem: "the catalog does not know this server: none of its tools is classified" }];
  const out: ToolProblem[] = [];
  const names = new Set<string>();
  for (const t of listed) {
    names.add(t.name);
    const now = hintedClass(t.annotations ?? undefined);
    if (!own(c.tools, t.name)) out.push({ server, tool: t.name, problem: `not in the catalog (annotated ${now ?? "neither way"}): classify it` });
    else if (now !== null && now !== classOf(server, t.name, catalog)) out.push({ server, tool: t.name, problem: `now annotated as ${now}, catalogued as ${classOf(server, t.name, catalog)}` });
    else if (now === null && hintedClass(c.tools[t.name]) !== null) out.push({ server, tool: t.name, problem: "lost its annotations: review its class" });
  }
  for (const tool of Object.keys(c.tools)) if (!names.has(tool)) out.push({ server, tool, problem: "catalogued, but the server no longer lists it" });
  return out;
}
