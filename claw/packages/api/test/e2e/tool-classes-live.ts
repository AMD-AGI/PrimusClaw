// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The nightly half of the closed set of MCP tool classes (`mcp-tool-catalog.ts` of `@claw/protocol`): reads every MCP server a
 * deployment's plugins and platform defaults name, as they are now, and fails on what the catalog does not say.
 *
 *  - Each server's live `tools/list` against its catalog (`listProblems`): a tool the catalog does not list (unclassified), one
 *    it no longer has, a changed annotation. A server the catalog does not know at all is a problem too.
 *  - Each spec's approval fields against the catalog's classes, read by Brain's own policy on the spec alone (`specProblems`): a
 *    write it does not hold, or one it releases without the catalog calling it releasable. Brain holds such a write at run time
 *    anyway (the catalog stands over every spec); this says which spec fell behind so it is fixed where people read it.
 *
 * Read-only: it lists tools and reads plugins, and changes nothing anywhere.
 *
 *   CHECK_CLAW=https://claw.example/api CHECK_KEY_FILE=/path/to/key CHECK_PLUGIN_IDS=9 \
 *   CHECK_SPEC_FILES=/etc/claw-platform/platform-defaults.json npx tsx test/e2e/tool-classes-live.ts
 *
 *   CHECK_CLAW        the API root (`/v1/plugins/:id` is appended); with CHECK_PLUGIN_IDS, the plugins whose `mcp` rows are read
 *   CHECK_KEY_FILE    the key of a test identity: it reads the plugins and is the bearer the MCP servers are listed with (a spec's
 *                     `<SAFE_API_KEY>` placeholder is that key, as at run time). Never printed or written.
 *   CHECK_SPEC_FILES  comma list of JSON files holding `mcpServers` or `mcp_servers` (e.g. Brain's platform defaults)
 *   CHECK_OUT         a file for the result as JSON (servers, tools and problems: no key, no URL)
 *
 * Exit 0 when nothing is wrong, 1 when a problem was found, 2 when the check could not run (a server that could not be listed
 * is a problem, not a pass).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { listProblems, specProblems, type ToolProblem } from "../../src/assistant/tool-classes.js";
const { approvalPolicyFromMcp } = await import("../../../brain/src/agent/approval-policy.js");

const PLACEHOLDER = "<SAFE_API_KEY>";
const fail = (why: string): never => { console.error(why); process.exit(2); };
const keyFile = process.env.CHECK_KEY_FILE;
const KEY = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const scrub = (s: string): string => (KEY ? s.split(KEY).join("<key>") : s);

type Spec = Record<string, unknown>;
interface Source { from: string; server: string; spec: Spec }

/** The `mcpServers` of a tool config or a defaults file, each with where it came from. */
function serversOf(from: string, holder: unknown): Source[] {
  const h = holder && typeof holder === "object" ? holder as Record<string, unknown> : {};
  const map = (h.mcpServers ?? h.mcp_servers) as Record<string, unknown> | undefined;
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).filter(([, s]) => s && typeof s === "object").map(([server, spec]) => ({ from, server, spec: spec as Spec }));
}

async function pluginSources(claw: string, ids: string[]): Promise<Source[]> {
  const out: Source[] = [];
  for (const id of ids) {
    const res = await fetch(`${claw}/v1/plugins/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200) fail(`GET /v1/plugins/${id} answered ${res.status}`);
    const body = await res.json() as { data?: { tools?: Array<{ id?: number; type?: string; config?: unknown }> } };
    for (const t of body.data?.tools ?? []) if (String(t.type).toLowerCase() === "mcp") out.push(...serversOf(`plugin ${id} tool ${t.id}`, t.config));
  }
  return out;
}

/** A server's tools, listed the way Brain connects to it: its URL and headers, the key where the spec names the placeholder. */
async function listed(spec: Spec): Promise<Array<{ name: string; annotations?: Record<string, unknown> }>> {
  const url = typeof spec.url === "string" ? spec.url : "";
  if (!/^https?:\/\//.test(url)) throw new Error("the spec has no http(s) url");
  const fill = (v: unknown): string => String(v).split(PLACEHOLDER).join(KEY);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((spec.headers as Record<string, unknown>) ?? {})) headers[k] = fill(v);
  const token = typeof spec.token === "string" && spec.token ? fill(spec.token) : KEY;
  if (token) headers.authorization = `Bearer ${token}`;
  const client = new Client({ name: "tool-classes-live", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  try {
    const tools: Array<{ name: string; annotations?: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools.map((t) => ({ name: t.name, annotations: t.annotations as Record<string, unknown> | undefined })));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally { await client.close().catch(() => {}); }
}

async function main(): Promise<void> {
  const claw = (process.env.CHECK_CLAW ?? "").replace(/\/+$/, "");
  const ids = (process.env.CHECK_PLUGIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const files = (process.env.CHECK_SPEC_FILES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!KEY) fail("CHECK_KEY_FILE is required");
  if (ids.length && !claw) fail("CHECK_PLUGIN_IDS needs CHECK_CLAW");
  const sources = [...(ids.length ? await pluginSources(claw, ids) : [])];
  for (const f of files) sources.push(...serversOf(`file ${f.split("/").pop()}`, JSON.parse(readFileSync(f, "utf8"))));
  if (!sources.length) fail("no MCP server to check: set CHECK_PLUGIN_IDS (with CHECK_CLAW) or CHECK_SPEC_FILES");

  const problems: Array<ToolProblem & { from?: string }> = [];
  const tools: Record<string, number> = {};
  // Each server is listed once, from the first spec that names it: the catalog is per server name.
  for (const s of sources) {
    if (Object.hasOwn(tools, s.server)) continue;
    try {
      const got = await listed(s.spec);
      tools[s.server] = got.length;
      problems.push(...listProblems(s.server, got).map((p) => ({ ...p, from: s.from })));
    } catch (err) {
      tools[s.server] = -1;
      problems.push({ server: s.server, tool: "*", problem: `tools/list failed: ${scrub(err instanceof Error ? err.message : String(err)).slice(0, 200)}`, from: s.from });
    }
  }
  for (const s of sources) {
    // The spec alone: at run time Brain also holds every catalogued write, which would hide what this reports.
    const policy = approvalPolicyFromMcp({ [s.server]: s.spec }, { catalog: null });
    problems.push(...specProblems(s.server, s.spec, (t) => policy.requiresApproval(`mcp__${s.server}__${t}`)).map((p) => ({ ...p, from: s.from })));
  }
  const result = { checked_at: new Date().toISOString(), sources: sources.map((s) => `${s.from}: ${s.server}`), tools, problems };
  if (process.env.CHECK_OUT) writeFileSync(process.env.CHECK_OUT, scrub(JSON.stringify(result, null, 1)) + "\n");
  for (const p of problems) console.log(scrub(`PROBLEM ${p.from ?? ""} ${p.server} ${p.tool}: ${p.problem}`));
  console.log(scrub(JSON.stringify({ sources: result.sources.length, tools, problems: problems.length })));
  process.exit(problems.length ? 1 : 0);
}

void main().catch((err) => fail(scrub(`check failed: ${err instanceof Error ? err.message : String(err)}`)));
