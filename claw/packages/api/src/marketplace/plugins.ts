// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Marketplace domain logic ported from the original Python implementation
 * (tools, plugins, resources, import).
 */

import AdmZip from "adm-zip";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
import path from "node:path";
import pino from "pino";
import { S3_API_ENDPOINT, S3_PLUGINS_BUCKET } from "../config.js";
import { MarketplaceDb, type JsonObject } from "../infra/db.js";
import { getS3Client } from "../infra/s3-client.js";
import {
  AccessDeniedError,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  NotConfiguredError,
  NotFoundError,
  PluginDuplicateError,
  ToolDuplicateError,
  ToolVersionDuplicateError,
  UpsertConflictError,
  UpsertPermissionError,
  UpsertToolTypeChangeError,
} from "../shared/errors.js";

// Audit-only logger for low-frequency events such as admin overrides during
// import. Keep noise out of the hot path; do not use for normal flow.
const logger = pino({ name: "plugins" });

const DEFAULT_VERSION = "1.0.0";

function defaultVersion(): string {
  return DEFAULT_VERSION;
}

/** Retries when concurrent inserts hit ``uq_*_name_version_*`` (Postgres ``23505``). */
const UPSERT_CONCURRENCY_RETRIES = 16;

/** Postgres / SQLSTATE ``unique_violation``; the ``pg`` driver exposes it as ``err.code === "23505"``. */
function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

function requireNonBlankName(raw: unknown): string {
  // ``trimOuterWhitespace`` (defined later) covers ASCII whitespace plus
  // ``\r``/``\n``/NBSP/ZWSP/BOM, matching the SKILL.md extraction path so
  // form-supplied names follow the exact same trimming rules.
  const s = trimAll(String(raw ?? ""));
  if (!s) throw new BadRequestError("name must not be empty");
  return s;
}

function requireNonBlankVersion(raw: unknown): string {
  const s = trimAll(String(raw ?? ""));
  if (!s) throw new BadRequestError("version must not be empty");
  return s;
}

// Forward declaration helper: ``trimOuterWhitespace`` is defined further down
// alongside the SKILL.md parsers. We expose ``trimAll`` here so the request
// validation helpers above (which run before that block in source order at
// call time) share the same whitespace policy without forcing a re-order.
function trimAll(s: string): string {
  return s.replace(/^[\s\u00a0\u200b\u200c\u200d\ufeff]+|[\s\u00a0\u200b\u200c\u200d\ufeff]+$/g, "");
}

function coalesceIsPublic(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  return Boolean(raw);
}

function displayNameOrName(displayName: unknown, name: unknown): string | null {
  const dn = trimAll(String(displayName ?? ""));
  if (dn) return dn;
  const n = trimAll(String(name ?? ""));
  return n || null;
}

function versionSortTuple(v: unknown): [number, number, number] {
  const parts = String(v ?? "").split(".");
  const n = (s: string) => {
    const m = /^(\d+)/.exec(s);
    return m ? parseInt(m[1], 10) : 0;
  };
  return [
    parts.length >= 1 ? n(parts[0]) : 0,
    parts.length >= 2 ? n(parts[1]) : 0,
    parts.length >= 3 ? n(parts[2]) : 0,
  ];
}

function compareVersion(a: unknown, b: unknown): number {
  const ta = versionSortTuple(a);
  const tb = versionSortTuple(b);
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] - tb[i];
  }
  return 0;
}

/** Mirrors Python ``plugins.db._norm_ver``: blank becomes ``defaultVersion()`` for comparisons. */
function normVer(v: unknown): string {
  return String(v ?? "").trim() || defaultVersion();
}

function rowsMatchVersion(rows: JsonObject[], ver: string): boolean {
  const want = normVer(ver);
  return rows.some((r) => normVer(r.version) === want);
}

/** First row in ``rows`` order whose normalized version matches (Python ``_row_matching_version``). */
function rowMatchingVersion(rows: JsonObject[], ver: string): JsonObject | null {
  const want = normVer(ver);
  for (const r of rows) {
    if (normVer(r.version) === want) return r;
  }
  return null;
}

/**
 * Row with max (semver tuple, ``updated_at``/``created_at`` string, ``id``) — Python ``_latest_row_by_version``.
 */
function latestRowByVersion(rows: JsonObject[]): JsonObject {
  if (!rows.length) throw new BadRequestError("rows must not be empty");
  let top = rows[0]!;
  const key = (x: JsonObject): [number, number, number, string, number] => [
    ...versionSortTuple(x.version),
    String(x.updated_at ?? x.created_at ?? ""),
    Number(x.id ?? 0),
  ];
  const cmp = (a: JsonObject, b: JsonObject): number => {
    const ka = key(a);
    const kb = key(b);
    const byVer = compareVersion(a.version, b.version);
    if (byVer !== 0) return byVer;
    const ta = ka[3];
    const tb = kb[3];
    if (ta !== tb) return ta < tb ? -1 : ta > tb ? 1 : 0;
    return ka[4] - kb[4];
  };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (cmp(r, top) > 0) top = r;
  }
  return top;
}

function sameActorOwner(actor: string, owner: unknown): boolean {
  const o = String(owner ?? "").trim();
  return Boolean(actor && o && actor === o);
}

function formatTs(d: unknown): string {
  if (d instanceof Date) return d.toISOString().replace("T", " ").replace("Z", "+00");
  if (typeof d === "string") return d;
  return new Date().toISOString();
}

/** Normalize DB row to API shape (tool). */
export function formatToolRow(r: JsonObject): JsonObject {
  return {
    id: Number(r.id),
    type: r.type,
    name: r.name,
    version: r.version,
    display_name: r.display_name,
    description: r.description ?? "",
    tags: Array.isArray(r.tags) ? r.tags : typeof r.tags === "string" ? JSON.parse(r.tags as string) : [],
    icon_url: r.icon_url,
    author: r.author,
    config: typeof r.config === "object" && r.config ? r.config : {},
    tool_source: r.tool_source ?? "upload",
    tool_source_url: r.tool_source_url,
    owner_user_id: r.owner_user_id,
    is_public: r.is_public ?? true,
    status: r.status ?? "active",
    created_at: formatTs(r.created_at),
    updated_at: formatTs(r.updated_at),
    deleted_at: r.deleted_at ? formatTs(r.deleted_at) : null,
  };
}

/**
 * Expand a raw `plugins.tools` array (V1-style `{id, type, version}` refs) into
 * the inline `{name, type, config, ...}` shape that DAG admission / expander
 * and any other consumer that needs to read tool name/config without a second
 * round-trip can rely on. Returns a new array; missing tool rows degrade to
 * empty strings so the result remains JSON-stringifiable.
 */
export async function enrichPluginToolsInline(raw: unknown): Promise<JsonObject[]> {
  const arr: JsonObject[] = Array.isArray(raw) ? (raw as JsonObject[]) : [];
  const out: JsonObject[] = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const ref = x as JsonObject;
    const id = Number(ref.id ?? 0);
    const meta = id ? await MarketplaceDb.toolGetById(id, false) : null;
    out.push({
      ...ref,
      id,
      name: meta ? String(meta.name || "") : String(ref.name ?? ""),
      type: meta ? String(meta.type || "") : String(ref.type ?? ""),
      config:
        meta && typeof meta.config === "object" && meta.config !== null
          ? (meta.config as JsonObject)
          : typeof ref.config === "object" && ref.config !== null
            ? (ref.config as JsonObject)
            : {},
    });
  }
  return out;
}

/**
 * The sandbox image a plugin offers, or "" when it offers none.
 *
 * A plugin declares one repo per framework, and nothing on the dispatch path
 * knows yet which framework a run will pick, so the first usable entry wins.
 * "Usable" is deliberately per-entry rather than positional: an entry written
 * for a framework whose repo has not been filled in yet is a hole in the list,
 * not the end of it, and stopping at the first hole would hide every repo
 * behind it -- and hide it as a silent fall through to the deployment default,
 * which is the one outcome that looks like nothing went wrong.
 *
 * `framework` is carried but not read here. Choosing by it needs a framework on
 * the request to match against, which no caller supplies today.
 */
export function pluginSandboxImage(images: unknown): string {
  if (!Array.isArray(images)) return "";
  for (const entry of images) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const repo = String((entry as JsonObject).repo ?? "").trim();
    if (repo) return repo;
  }
  return "";
}

export async function formatPluginRow(r: JsonObject, enrichRefs = false): Promise<JsonObject> {
  let tools: unknown[] = Array.isArray(r.tools) ? r.tools : [];
  // V2 reads only the new `resource` (object) column. The legacy `resources`
  // (array) column is preserved on the row but never surfaced to V2 callers,
  // so a rollback to V1 can still consume it from the same schema.
  const resource =
    typeof r.resource === "object" && r.resource !== null && !Array.isArray(r.resource)
      ? (r.resource as JsonObject)
      : {};
  if (enrichRefs) {
    // Batch-fetch referenced tool metadata in a single query (avoids the
    // N+1 round-trips that made plugin GET latency scale with tool count).
    const refs = tools as JsonObject[];
    const ids = refs.map((x) => Number(x.id)).filter((n) => Number.isFinite(n));
    const metas = await MarketplaceDb.toolsGetByIds(ids, false);
    const metaById = new Map<number, JsonObject>(
      metas.map((m) => [Number(m.id), m] as [number, JsonObject]),
    );
    tools = refs.map((x) => {
      const meta = metaById.get(Number(x.id));
      return {
        ...x,
        type: meta ? String(meta.type || "") : "",
        name: meta ? String(meta.name || "") : "",
        description: meta ? String(meta.description || "") : "",
        config: meta && typeof meta.config === "object" ? meta.config : {},
      };
    });
  }
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description ?? "",
    version: r.version,
    images: Array.isArray(r.images) ? r.images : [],
    tools,
    resource,
    owner_user_id: r.owner_user_id,
    author: r.author,
    is_public: r.is_public ?? true,
    status: r.status ?? "active",
    created_at: formatTs(r.created_at),
    updated_at: formatTs(r.updated_at),
    deleted_at: r.deleted_at ? formatTs(r.deleted_at) : null,
  };
}

export function formatResourceRow(r: JsonObject): JsonObject {
  // Resources are now globally readable; visibility is no longer per-row.
  // ``type`` is surfaced so callers can identify the default resource entry.
  const resource =
    typeof r.resource === "object" && r.resource !== null && !Array.isArray(r.resource)
      ? (r.resource as JsonObject)
      : {};
  return {
    id: Number(r.id),
    name: r.name,
    type: r.type ?? "",
    image: r.image ?? "",
    resource,
    owner_user_id: r.owner_user_id,
    author: r.author,
    created_at: formatTs(r.created_at),
    updated_at: formatTs(r.updated_at),
    deleted_at: r.deleted_at ? formatTs(r.deleted_at) : null,
  };
}

export function canViewTool(row: JsonObject, userId: string | undefined, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (row.is_public) return true;
  const uid = userId || "";
  return Boolean(uid && String(row.owner_user_id) === uid);
}

export function canViewPlugin(row: JsonObject, userId: string | undefined, isAdmin: boolean): boolean {
  return canViewTool(row, userId, isAdmin);
}

export function ownerOrAdmin(row: JsonObject, userId: string | undefined, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const uid = userId || "";
  return Boolean(uid && String(row.owner_user_id) === uid);
}

// --- upsert (db.py upsert_*) ------------------------------------------------------

async function upsertToolOnce(
  payload: JsonObject,
  actingUserId: string,
  isAdmin: boolean,
  name: string,
  t: string,
  ver: string,
): Promise<[JsonObject, string]> {
  const rows = await MarketplaceDb.toolsActiveByName(name);
  if (!rows.length) {
    const row = await MarketplaceDb.toolInsert({
      ...payload,
      name,
      type: t,
      version: ver || defaultVersion(),
    });
    return [formatToolRow(row), "created"];
  }
  const source = latestRowByVersion(rows);
  if (String(payload.type).trim() !== String(source.type ?? "").trim()) {
    throw new UpsertToolTypeChangeError();
  }
  if (!sameActorOwner(actingUserId, source.owner_user_id) && !isAdmin) {
    throw new UpsertPermissionError();
  }
  if (rowsMatchVersion(rows, ver)) {
    const match = rowMatchingVersion(rows, ver);
    if (!match) throw new UpsertConflictError();
    const patch = toolInplaceUpdates(payload);
    if (isAdmin && !sameActorOwner(actingUserId, source.owner_user_id)) {
      delete patch.owner_user_id;
    }
    const updated = await MarketplaceDb.toolUpdate(Number(match.id), patch);
    if (!updated) throw new UpsertConflictError();
    return [formatToolRow(updated), "updated"];
  }
  const nv = await createToolNewVersion(
    Number(source.id),
    ver,
    name,
    toolNewVersionOverrides(payload),
  );
  if (!nv) throw new UpsertConflictError();
  return [formatToolRow(nv), "version_created"];
}

export async function upsertTool(
  payload: JsonObject,
  actingUserId: string,
  isAdmin: boolean,
): Promise<[JsonObject, string]> {
  const name = requireNonBlankName(payload.name);
  const t = String(payload.type ?? "").trim();
  if (!t) throw new BadRequestError("type must not be empty");
  if (!ALLOWED_TOOL_TYPES.has(t)) {
    throw new BadRequestError(
      `type must be one of: ${[...ALLOWED_TOOL_TYPES].join(", ")}`,
    );
  }
  validateToolScope(t, payload.config);
  const ver = requireNonBlankVersion(payload.version);
  let last: unknown;
  for (let attempt = 0; attempt < UPSERT_CONCURRENCY_RETRIES; attempt++) {
    try {
      return await upsertToolOnce(payload, actingUserId, isAdmin, name, t, ver);
    } catch (e) {
      if (isPgUniqueViolation(e)) {
        last = e;
        continue;
      }
      throw e;
    }
  }
  throw last instanceof Error ? last : new UpsertConflictError();
}

/** Blank or missing ``status`` → ``active`` (Python ``_normalize_status``). */
function normalizeToolStatus(raw: unknown): string {
  if (raw === null || raw === undefined) return "active";
  const s = String(raw).trim();
  return s || "active";
}

/**
 * In-place upsert patch only — mirrors Python ``_tool_inplace_updates_from_payload`` (no ``type``/``name``/``version``).
 */
function toolInplaceUpdates(payload: JsonObject): JsonObject {
  const name = requireNonBlankName(payload.name);
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  const cfg =
    typeof payload.config === "object" && payload.config !== null ? (payload.config as JsonObject) : {};
  return {
    display_name: displayNameOrName(payload.display_name, name),
    description: String(payload.description ?? ""),
    tags,
    icon_url: payload.icon_url,
    author: payload.author ?? null,
    config: cfg,
    tool_source: String(payload.tool_source ?? "").trim() || "upload",
    tool_source_url: payload.tool_source_url ?? null,
    owner_user_id: payload.owner_user_id ?? null,
    is_public: coalesceIsPublic(payload.is_public),
    status: normalizeToolStatus(payload.status),
  };
}

function toolNewVersionOverrides(payload: JsonObject): JsonObject | null {
  const keys = [
    "type", "display_name", "description", "tags", "icon_url", "author", "config",
    "tool_source", "tool_source_url", "owner_user_id", "is_public", "status",
  ];
  const out: JsonObject = {};
  for (const k of keys) {
    if (k in payload) out[k] = payload[k];
  }
  return Object.keys(out).length ? out : null;
}

export async function createToolNewVersion(
  sourceToolId: number,
  newVersion: string,
  name: string,
  overrides: JsonObject | null,
): Promise<JsonObject | null> {
  const src = await MarketplaceDb.toolGetById(sourceToolId, false);
  if (!src) return null;
  const ver = String(newVersion || "").trim() || defaultVersion();
  const payload: JsonObject = {
    type: src.type,
    name: requireNonBlankName(name),
    version: ver,
    display_name: src.display_name,
    description: src.description ?? "",
    tags: src.tags,
    icon_url: src.icon_url,
    author: src.author,
    config: src.config ?? {},
    tool_source: src.tool_source ?? "upload",
    tool_source_url: src.tool_source_url,
    owner_user_id: src.owner_user_id,
    is_public: coalesceIsPublic(src.is_public),
    status: "active",
  };
  if (overrides) Object.assign(payload, overrides);
  for (let attempt = 0; attempt < UPSERT_CONCURRENCY_RETRIES; attempt++) {
    try {
      return await MarketplaceDb.toolInsert(payload);
    } catch (e) {
      if (!isPgUniqueViolation(e)) throw e;
      const existing = await MarketplaceDb.toolActiveByNameAndVersion(
        requireNonBlankName(payload.name),
        String(payload.version ?? "").trim() || defaultVersion(),
      );
      if (existing) return existing;
    }
  }
  throw new ToolDuplicateError("tool with same name and version already exists");
}

async function upsertPluginOnce(
  payload: JsonObject,
  actingUserId: string,
  isAdmin: boolean,
  name: string,
  ver: string,
): Promise<[JsonObject, string]> {
  const rows = await MarketplaceDb.pluginsActiveByName(name);
  if (!rows.length) {
    const row = await MarketplaceDb.pluginInsert({ ...payload, name, version: ver });
    return [await formatPluginRow(row), "created"];
  }
  const source = latestRowByVersion(rows);
  if (!sameActorOwner(actingUserId, source.owner_user_id) && !isAdmin) {
    throw new UpsertPermissionError();
  }
  if (rowsMatchVersion(rows, ver)) {
    const match = rowMatchingVersion(rows, ver);
    if (!match) throw new UpsertConflictError();
    const patch = pluginInplaceUpdates(payload);
    if (isAdmin && !sameActorOwner(actingUserId, source.owner_user_id)) {
      delete patch.owner_user_id;
    }
    const updated = await MarketplaceDb.pluginUpdate(Number(match.id), patch);
    if (!updated) throw new UpsertConflictError();
    return [await formatPluginRow(updated), "updated"];
  }
  const nv = await createPluginNewVersion(Number(source.id), ver, name, pluginNewVersionOverrides(payload));
  if (!nv) throw new UpsertConflictError();
  return [await formatPluginRow(nv), "version_created"];
}

export async function upsertPlugin(
  payload: JsonObject,
  actingUserId: string,
  isAdmin: boolean,
): Promise<[JsonObject, string]> {
  const name = requireNonBlankName(payload.name);
  const ver = requireNonBlankVersion(payload.version);
  let last: unknown;
  for (let attempt = 0; attempt < UPSERT_CONCURRENCY_RETRIES; attempt++) {
    try {
      return await upsertPluginOnce(payload, actingUserId, isAdmin, name, ver);
    } catch (e) {
      if (isPgUniqueViolation(e)) {
        last = e;
        continue;
      }
      throw e;
    }
  }
  throw last instanceof Error ? last : new UpsertConflictError();
}

function pluginInplaceUpdates(payload: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of ["name", "description", "version", "images", "tools", "resource", "owner_user_id", "author", "is_public", "status"]) {
    if (k in payload) out[k] = payload[k];
  }
  return out;
}

function pluginNewVersionOverrides(payload: JsonObject): JsonObject | null {
  const keys = ["description", "images", "tools", "resource", "owner_user_id", "author", "is_public", "status"];
  const out: JsonObject = {};
  for (const k of keys) {
    if (k in payload) out[k] = payload[k];
  }
  return Object.keys(out).length ? out : null;
}

export async function createPluginNewVersion(
  sourceId: number,
  newVersion: string,
  name: string,
  overrides: JsonObject | null,
): Promise<JsonObject | null> {
  const src = await MarketplaceDb.pluginGetById(sourceId, false);
  if (!src) return null;
  const ver = String(newVersion || "").trim() || defaultVersion();
  const payload: JsonObject = {
    name: requireNonBlankName(name),
    description: src.description ?? "",
    version: ver,
    images: src.images ?? [],
    tools: src.tools ?? [],
    resource: src.resource ?? {},
    owner_user_id: src.owner_user_id,
    author: src.author,
    is_public: coalesceIsPublic(src.is_public),
    status: src.status ?? "active",
  };
  if (overrides) Object.assign(payload, overrides);
  for (let attempt = 0; attempt < UPSERT_CONCURRENCY_RETRIES; attempt++) {
    try {
      return await MarketplaceDb.pluginInsert(payload);
    } catch (e) {
      if (!isPgUniqueViolation(e)) throw e;
      const existing = await MarketplaceDb.pluginActiveByNameAndVersion(
        requireNonBlankName(payload.name),
        String(payload.version ?? "").trim() || defaultVersion(),
      );
      if (existing) return existing;
    }
  }
  throw new PluginDuplicateError("plugin with same name and version already exists");
}

export const APP_TYPE_MCP = "mcp";
export const APP_TYPE_SKILL = "skill";
export const APP_TYPE_RULE = "rule";
export const APP_TYPE_HOOKS = "hooks";
export const APP_TYPE_PROMPT = "prompt";

// Whitelist of accepted tool types for upsert/create paths. Prevents ghost
// rows with arbitrary `type` strings that would silently bypass downstream
// logic (s3 content materialization, brain resolve-tools, etc.).
const ALLOWED_TOOL_TYPES: ReadonlySet<string> = new Set([
  APP_TYPE_MCP,
  APP_TYPE_SKILL,
  APP_TYPE_RULE,
  APP_TYPE_HOOKS,
  APP_TYPE_PROMPT,
]);

/** Where the tool runs (task-design.md §8.1 MCP routing). */
export type ToolScope = "hands" | "backend";

const ALLOWED_TOOL_SCOPES: ReadonlySet<ToolScope> = new Set(["hands", "backend"]);

/**
 * Default tool scope when `config.scope` is omitted.
 *
 *   - "mcp"   → "hands"   (existing behaviour: Brain forwards calls to the
 *                          per-session sandbox sidecar)
 *   - other   → "hands"   (skill/rule/hooks/prompt have no scope; we keep
 *                          the field set so downstream routers can treat
 *                          every row uniformly)
 *
 * Only `type === "mcp"` may declare `config.scope = "backend"`. Other
 * scopes are rejected at admission time.
 */
function validateToolScope(type: string, rawConfig: unknown): void {
  if (!rawConfig || typeof rawConfig !== "object") return;
  const cfg = rawConfig as Record<string, unknown>;
  const rawScope = cfg.scope;
  if (rawScope === undefined || rawScope === null || rawScope === "") return;
  const scope = String(rawScope);
  if (!ALLOWED_TOOL_SCOPES.has(scope as ToolScope)) {
    throw new BadRequestError(
      `config.scope must be one of: ${[...ALLOWED_TOOL_SCOPES].join(", ")}`,
    );
  }
  if (scope === "backend" && type !== APP_TYPE_MCP) {
    throw new BadRequestError(
      `config.scope='backend' only allowed for type='mcp' tools (got '${type}')`,
    );
  }
}

// --- S3 (tools skill/rule content) ------------------------------------------------

// Single path segment under ``plugins/{id}/``. Mirrors Python
// ``_s3_version_segment``: trims, normalizes ``\`` and ``/`` to ``-``, and
// collapses any path containing ``..`` back to the default ``1.0.0``. Do not
// replace other characters; Python preserves spaces and punctuation verbatim.
function s3VersionSegment(version: string | null | undefined): string {
  let v = String(version ?? "").trim() || defaultVersion();
  v = v.replace(/\\/g, "-").replace(/\//g, "-");
  if (!v || v.includes("..")) return defaultVersion();
  return v;
}

export function s3PluginsCommitPrefix(toolId: number, version: string): string {
  return `plugins/${toolId}/${s3VersionSegment(version)}/`;
}

/**
 * S3 prefix for all committed objects for a tool id (every version segment under ``plugins/{id}/``).
 * Used on tool delete to remove the whole tree, not only the row's current version path.
 */
export function s3PluginsToolRootPrefix(toolId: number): string {
  return `plugins/${toolId}/`;
}

async function s3PutBytes(key: string, body: Buffer, contentType: string): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: S3_PLUGINS_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function s3DownloadBytes(key: string): Promise<Buffer> {
  const out = await getS3Client().send(
    new GetObjectCommand({ Bucket: S3_PLUGINS_BUCKET, Key: key }),
  );
  const chunks: Uint8Array[] = [];
  for await (const c of out.Body as AsyncIterable<Uint8Array>) chunks.push(c);
  return Buffer.concat(chunks);
}

async function s3ListKeysUnderPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const out = await getS3Client().send(
      new ListObjectsV2Command({
        Bucket: S3_PLUGINS_BUCKET,
        Prefix: prefix,
        ContinuationToken,
      }),
    );
    for (const o of out.Contents ?? []) {
      if (o.Key) keys.push(o.Key);
    }
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function s3DeleteObjectKey(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: S3_PLUGINS_BUCKET, Key: key }));
}

function skillS3Key(cfg: JsonObject): string {
  const v = cfg.s3_key;
  return typeof v === "string" ? v : "";
}

function s3PrefixDirectory(s3Key: string): string {
  if (!s3Key) return "";
  return s3Key.endsWith("/") ? s3Key : `${s3Key}/`;
}

/** MCP setup markdown (tools_api.generate_mcp_setup_guide). */
export function generateMcpSetupGuide(tool: JsonObject): string {
  const cfg = (typeof tool.config === "object" && tool.config ? tool.config : {}) as JsonObject;
  const name = String(tool.name || "mcp");
  const desc = String(tool.description || "");
  const mcp = cfg.mcpServers;
  if (typeof mcp === "object" && mcp && mcp !== null) {
    const vals = Object.values(mcp as Record<string, JsonObject>);
    const hasUrl = vals.some((v) => typeof v === "object" && v && String((v as JsonObject).url ?? "").trim());
    if (hasUrl) {
      const block = JSON.stringify({ mcpServers: mcp }, null, 2);
      return (
        `# ${name} - MCP Server Setup Guide\n\n## Description\n\n${desc}\n\n` +
        "## Cursor Configuration\n\nAdd the following to your Cursor MCP settings:\n\n" +
        `\`\`\`json\n${block}\n\`\`\`\n`
      );
    }
  }
  let command = "";
  let args: string[] = [];
  let env: Record<string, string> = {};
  const cmd = cfg.command;
  if (typeof cmd === "string" && cmd) {
    command = cmd;
    args = Array.isArray(cfg.args) ? (cfg.args as string[]) : [];
    const er = cfg.env;
    if (typeof er === "object" && er && er !== null) {
      for (const [k, v] of Object.entries(er as Record<string, unknown>)) {
        env[k] = String(v);
      }
    }
  } else {
    const servers = cfg.mcpServers;
    if (typeof servers === "object" && servers && servers !== null) {
      const first = Object.values(servers as Record<string, JsonObject>)[0];
      if (typeof first === "object" && first) {
        const c = first.command;
        if (typeof c === "string") {
          command = c;
          args = Array.isArray(first.args) ? (first.args as string[]) : [];
          const e = first.env;
          if (typeof e === "object" && e && e !== null) {
            for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
              env[k] = String(v);
            }
          }
        }
      }
    }
  }
  const argStr = args.map((a) => `"${a}"`).join(", ");
  let envBlock = "";
  if (Object.keys(env).length) {
    const lines = Object.entries(env).map(([k, v]) => `        "${k}": "${v}"`);
    envBlock = `,\n      "env": {\n${lines.join(",\n")}\n      }`;
  }
  return (
    `# ${name} - MCP Server Setup Guide\n\n## Description\n\n${desc}\n\n` +
    "## Cursor Configuration\n\nAdd the following to your Cursor MCP settings:\n\n" +
    "```json\n{\n" +
    '  "mcpServers": {\n' +
    `    "${name}": {\n` +
    `      "command": "${command}",\n` +
    `      "args": [${argStr}]${envBlock}\n` +
    "    }\n  }\n}\n```\n"
  );
}

export async function createMcpTool(body: JsonObject, userId: string, userName: string): Promise<JsonObject> {
  const name = requireNonBlankName(body.name);
  const ver = String(body.version ?? "").trim() || defaultVersion();
  const display = displayNameOrName(body.display_name, name);
  const row = await MarketplaceDb.toolInsert({
    type: APP_TYPE_MCP,
    name,
    version: ver,
    description: String(body.description ?? ""),
    display_name: display,
    tags: Array.isArray(body.tags) ? body.tags : [],
    icon_url: body.icon_url ?? null,
    author: (userName || "").trim() || null,
    config: typeof body.config === "object" && body.config ? body.config : {},
    tool_source: "upload",
    tool_source_url: null,
    owner_user_id: userId || null,
    is_public: coalesceIsPublic(body.is_public),
    status: "active",
  });
  return formatToolRow(row);
}

// Resolve final tool name for single-file skill/rule uploads. Mirrors the zip
// import flow: explicit ``body.name`` (acts as ``name_override``) wins; on
// blank, fall back to ``title:`` > ``name:`` extracted from the file body via
// ``skillNameFromHeaderLine``. The result must match ``SKILL_NAME_SAFE``,
// matching ``commitOneSkill`` / ``commitOneRule`` validation.
function resolveSingleUploadName(rawName: unknown, content: string, kind: "skill" | "rule"): string {
  const explicit = String(rawName ?? "").trim();
  let resolved = explicit;
  if (!resolved && content) {
    resolved = skillNameFromHeaderLine(content);
  }
  if (!resolved) {
    throw new BadRequestError(`${kind} name is required`);
  }
  if (!SKILL_NAME_SAFE.test(resolved)) {
    throw new BadRequestError(`invalid ${kind} name (use A-Za-z0-9._-)`);
  }
  return resolved;
}

// Unified single-file upload for skill/rule. ``kind`` is resolved by the
// caller (route layer) from the upload filename; this function only diverges
// on (a) the row ``type`` column and (b) the S3 object basename
// (``SKILL.md`` vs ``rule.md``) — everything else is identical.
export async function createSkillOrRuleTool(
  body: JsonObject,
  userId: string,
  userName: string,
  kind: "skill" | "rule",
  isAdminUser = false,
): Promise<JsonObject> {
  const content = String(body.content ?? "").trim();
  const name = resolveSingleUploadName(body.name, content, kind);
  const ver = String(body.version ?? "").trim() || defaultVersion();
  const display = displayNameOrName(body.display_name, name);
  const toolType = kind === "skill" ? APP_TYPE_SKILL : APP_TYPE_RULE;
  const payload: JsonObject = {
    type: toolType,
    name,
    version: ver,
    description: String(body.description ?? ""),
    display_name: display,
    tags: Array.isArray(body.tags) ? body.tags : [],
    icon_url: body.icon_url ?? null,
    author: (userName || "").trim() || null,
    config: {},
    tool_source: "upload",
    tool_source_url: null,
    owner_user_id: userId || null,
    is_public: coalesceIsPublic(body.is_public),
    status: "active",
  };
  const [row, upsertAction] = await upsertTool(payload, userId, isAdminUser);
  const tid = Number(row.id);
  const persistedVersion = String(row.version ?? ver).trim() || ver;
  if (!content) return { ...row, upsert_action: upsertAction };
  const objectName = kind === "skill" ? "SKILL.md" : "rule.md";
  const s3key = `${s3PluginsCommitPrefix(tid, persistedVersion)}${objectName}`;
  await s3PutBytes(s3key, Buffer.from(content, "utf-8"), "text/markdown");
  const merged = { s3_key: s3key, is_prefix: false };
  const out = await MarketplaceDb.toolUpdate(tid, { config: merged });
  const formatted = out ? formatToolRow(out) : row;
  return { ...formatted, upsert_action: upsertAction };
}

// Create a prompt tool. The prompt body is stored verbatim in the `config`
// JSONB column — no S3 round-trip, no schema constraint on shape (caller
// can pass an object, array, string, or any JSON-serializable value).
// Mirrors createMcpTool (which is also a pure DB insert with config
// passthrough); we just stamp type=prompt instead of type=mcp.
export async function createPromptTool(body: JsonObject, userId: string, userName: string): Promise<JsonObject> {
  const name = requireNonBlankName(body.name);
  const ver = String(body.version ?? "").trim() || defaultVersion();
  const display = displayNameOrName(body.display_name, name);
  const row = await MarketplaceDb.toolInsert({
    type: APP_TYPE_PROMPT,
    name,
    version: ver,
    description: String(body.description ?? ""),
    display_name: display,
    tags: Array.isArray(body.tags) ? body.tags : [],
    icon_url: body.icon_url ?? null,
    author: (userName || "").trim() || null,
    config: body.config ?? {},
    tool_source: "upload",
    tool_source_url: null,
    owner_user_id: userId || null,
    is_public: coalesceIsPublic(body.is_public),
    status: "active",
  });
  return formatToolRow(row);
}

export async function listToolsFormatted(params: {
  toolType?: string;
  status?: string;
  owner?: string;
  tag?: string;
  sortField: "created_at" | "updated_at";
  sortOrder: "asc" | "desc";
  offset: number;
  limit: number;
  userId: string;
  isAdmin: boolean;
  includeDeleted: boolean;
  nameExact?: string;
  latestPerName: boolean;
}): Promise<{ tools: JsonObject[]; total: number; offset: number; limit: number }> {
  const { rows, total } = await MarketplaceDb.listToolsRepo({
    toolType: params.toolType || undefined,
    status: params.status || undefined,
    owner: params.owner || undefined,
    tag: params.tag || undefined,
    sortField: params.sortField,
    sortOrder: params.sortOrder,
    offset: params.offset,
    limit: params.limit,
    viewerUserId: params.userId || undefined,
    isAdmin: params.isAdmin,
    includeDeleted: params.includeDeleted,
    nameExact: params.nameExact || undefined,
    latestPerName: params.latestPerName,
  });
  return {
    tools: rows.map((r) => formatToolRow(r)),
    total,
    offset: params.offset,
    limit: params.limit,
  };
}

export async function searchToolsFormatted(
  q: string,
  toolType: string,
  limit: number,
  offset: number,
  userId: string | undefined,
  isAdmin: boolean,
): Promise<{ tools: JsonObject[]; total: number; mode: string }> {
  const { rows, total } = await MarketplaceDb.searchToolsKeyword(q, {
    toolType: toolType || undefined,
    limit,
    offset,
    viewerUserId: userId,
    isAdmin,
  });
  return { tools: rows.map((r) => formatToolRow(r)), total, mode: "keyword" };
}

export async function downloadToolForUser(
  toolId: number,
  userId: string | undefined,
  isAdmin: boolean,
): Promise<{ data: Buffer; filename: string; contentType: string }> {
  const row = await MarketplaceDb.toolGetById(toolId, false);
  if (!row) throw new NotFoundError("tool not found");
  if (!canViewTool(row, userId, isAdmin)) throw new AccessDeniedError("cannot download tool");
  const typ = String(row.type ?? "");
  if (typ === APP_TYPE_SKILL || typ === APP_TYPE_RULE || typ === APP_TYPE_HOOKS) {
    return downloadSkillZip(row);
  }
  const md = generateMcpSetupGuide(formatToolRow(row));
  const base = String(row.name || "mcp");
  return { data: Buffer.from(md, "utf-8"), filename: `${base}-setup.md`, contentType: "text/markdown" };
}

async function downloadSkillZip(tool: JsonObject): Promise<{ data: Buffer; filename: string; contentType: string }> {
  const cfg = (typeof tool.config === "object" && tool.config ? tool.config : {}) as JsonObject;
  const s3Key = skillS3Key(cfg);
  if (!s3Key) throw new NotFoundError("content not found");
  const isPrefix = Boolean(cfg.is_prefix);
  const zip = new AdmZip();
  const typ = String(tool.type ?? "");
  if (isPrefix) {
    const dirPrefix = s3PrefixDirectory(s3Key);
    const keys = await s3ListKeysUnderPrefix(dirPrefix);
    for (const k of keys.sort()) {
      try {
        const data = await s3DownloadBytes(k);
        const rel = k.startsWith(dirPrefix) ? k.slice(dirPrefix.length) : k;
        zip.addFile(rel || k.split("/").pop() || "file", data);
      } catch {
        /* skip missing */
      }
    }
  } else {
    const data = await s3DownloadBytes(s3Key);
    let entry = "SKILL.md";
    if (typ === APP_TYPE_RULE) {
      const base = s3Key.includes("/") ? s3Key.split("/").pop() : s3Key;
      entry = base || "rule";
    } else if (typ === APP_TYPE_HOOKS) {
      const base = s3Key.includes("/") ? s3Key.split("/").pop() : s3Key;
      entry = base || "hook";
    }
    zip.addFile(entry, data);
  }
  const baseName =
    String(tool.name || "") ||
    (typ === APP_TYPE_RULE ? "rule" : typ === APP_TYPE_HOOKS ? "hooks" : "skill");
  return { data: zip.toBuffer(), filename: `${baseName}.zip`, contentType: "application/zip" };
}

export function runToolsNotConfigured(): never {
  throw new NotConfiguredError("runner not configured");
}

// --- tool service helpers ---------------------------------------------------------

export async function getToolForUser(
  toolId: number,
  userId: string | undefined,
  isAdmin: boolean,
): Promise<JsonObject> {
  const row = await MarketplaceDb.toolGetById(toolId, false);
  if (!row) throw new NotFoundError("tool not found");
  if (!canViewTool(row, userId, isAdmin)) throw new AccessDeniedError("cannot view tool");
  return formatToolRow(row);
}

export async function updateToolForUser(
  toolId: number,
  updates: JsonObject,
  userId: string,
  isAdmin: boolean,
  fieldsSet: Set<string>,
  authorUserName?: string | null,
): Promise<JsonObject> {
  const row = await MarketplaceDb.toolGetById(toolId, false);
  if (!row) throw new NotFoundError("tool not found");
  if (!ownerOrAdmin(row, userId, isAdmin)) throw new AccessDeniedError("only owner or admin can update");
  const typ = String(row.type ?? "");
  let merged: JsonObject = { ...(typeof row.config === "object" ? (row.config as JsonObject) : {}) };
  if (updates.config !== undefined) {
    merged = { ...merged, ...(updates.config as JsonObject) };
  }
  const contentRaw = merged.content;
  if (typeof contentRaw === "string" && contentRaw && [APP_TYPE_SKILL, APP_TYPE_RULE, APP_TYPE_HOOKS].includes(typ)) {
    delete merged.content;
    let s3k = skillS3Key(merged);
    const ver = String(row.version ?? "").trim() || defaultVersion();
    if (!s3k) {
      const suffix = typ === APP_TYPE_RULE ? "rule.md" : typ === APP_TYPE_HOOKS ? "hook.md" : "SKILL.md";
      s3k = `${s3PluginsCommitPrefix(toolId, ver)}${suffix}`;
      merged.s3_key = s3k;
      merged.is_prefix = false;
    }
    try {
      await s3PutBytes(s3k, Buffer.from(contentRaw, "utf-8"), "text/markdown");
    } catch (e) {
      throw new NotConfiguredError(`s3 upload failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const patch: JsonObject = {};
  if (fieldsSet.has("display_name")) {
    patch.display_name = displayNameOrName(updates.display_name, row.name);
  }
  if (fieldsSet.has("description")) patch.description = updates.description ?? "";
  if (fieldsSet.has("tags")) patch.tags = updates.tags;
  if (updates.icon_url) patch.icon_url = updates.icon_url;
  if (fieldsSet.has("is_public")) patch.is_public = coalesceIsPublic(updates.is_public);
  if (updates.status) patch.status = updates.status;
  if (updates.config !== undefined || (typeof contentRaw === "string" && contentRaw && [APP_TYPE_SKILL, APP_TYPE_RULE, APP_TYPE_HOOKS].includes(typ))) {
    patch.config = merged;
  }
  if (authorUserName !== undefined) {
    const au = String(authorUserName ?? "").trim();
    patch.author = au || null;
  }
  const out = await MarketplaceDb.toolUpdate(toolId, patch);
  if (!out) throw new NotFoundError("tool not found");
  return formatToolRow(out);
}

export async function deleteToolForUser(
  toolId: number,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  const row = await MarketplaceDb.toolGetById(toolId, false);
  if (!row) throw new NotFoundError("tool not found");
  if (!ownerOrAdmin(row, userId, isAdmin)) throw new AccessDeniedError("only owner or admin can delete");
  const referring = await MarketplaceDb.pluginsListReferencingToolId(toolId);
  if (referring.length) {
    const max = 5;
    const sample = referring
      .slice(0, max)
      .map((p) => `${String(p.name ?? "")}@${String(p.version ?? "")}`)
      .join(", ");
    const suffix = referring.length > max ? ` (+${referring.length - max} more)` : "";
    throw new ConflictError(
      `Tool is referenced by plugin(s): ${sample}${suffix}. Remove or update those plugins before deleting this tool.`,
    );
  }
  // Remove all S3 keys under ``plugins/{toolId}/`` (all versions: skills/, hooks/, MCP zips, etc.).
  const rootPrefix = s3PluginsToolRootPrefix(Number(row.id));
  try {
    const keys = await s3ListKeysUnderPrefix(rootPrefix);
    for (const k of keys) {
      try {
        await s3DeleteObjectKey(k);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* ignore list errors */
  }
  const ok = await MarketplaceDb.toolSoftDelete(toolId);
  if (!ok) throw new NotFoundError("tool not found");
}

export async function getToolContentText(
  toolId: number,
  userId: string | undefined,
  isAdmin: boolean,
): Promise<string> {
  const row = await MarketplaceDb.toolGetById(toolId, false);
  if (!row) throw new NotFoundError("tool not found");
  if (!canViewTool(row, userId, isAdmin)) throw new AccessDeniedError("cannot view tool");
  const typ = String(row.type ?? "");
  if (!["skill", "rule", "hooks"].includes(typ)) {
    throw new NotFoundError("only skills, rules, and hooks expose raw content");
  }
  const cfg = (typeof row.config === "object" && row.config ? row.config : {}) as JsonObject;
  if (typ === "hooks") {
    const hf = cfg.hook_files;
    if (Array.isArray(hf) && hf.length) {
      const items = hf.filter((x) => typeof x === "object" && x) as JsonObject[];
      items.sort((a, b) =>
        String(a.relative_path ?? a.name ?? a.hook_name ?? "").localeCompare(
          String(b.relative_path ?? b.name ?? b.hook_name ?? ""),
        ),
      );
      const parts: string[] = [];
      for (const item of items) {
        const k = String(item.s3_key ?? "");
        const label = String(item.relative_path ?? item.name ?? item.hook_name ?? k);
        if (!k) continue;
        try {
          const data = await s3DownloadBytes(k);
          parts.push(`===== hooks: ${label} =====\n${data.toString("utf-8")}`);
        } catch (e) {
          throw new NotConfiguredError(`download failed for ${k}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (parts.length) return parts.join("\n\n");
    }
    let s3key = skillS3Key(cfg);
    if (cfg.is_prefix && s3key) {
      const dirPrefix = s3PrefixDirectory(s3key);
      const keys = (await s3ListKeysUnderPrefix(dirPrefix)).sort();
      const parts: string[] = [];
      for (const ok of keys) {
        const rel = ok.startsWith(dirPrefix) ? ok.slice(dirPrefix.length) : ok;
        const data = await s3DownloadBytes(ok);
        parts.push(`===== hooks: ${rel || ok} =====\n${data.toString("utf-8")}`);
      }
      if (parts.length) return parts.join("\n\n");
      throw new NotFoundError("no hook files in config");
    }
    if (!s3key) throw new NotFoundError("s3_key not found in config");
    const data = await s3DownloadBytes(s3key);
    return data.toString("utf-8");
  }
  let s3key = skillS3Key(cfg);
  if (!s3key) throw new NotFoundError("s3_key not found in config");
  let downloadKey = s3key;
  if (s3key.endsWith("/")) downloadKey = `${s3key}SKILL.md`;
  const data = await s3DownloadBytes(downloadKey);
  return data.toString("utf-8");
}

export async function uploadIconBytes(
  userId: string,
  filename: string,
  buf: Buffer,
  contentType: string,
): Promise<string> {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200);
  const key = `icons/${userId}/${Date.now()}_${safe}`;
  await s3PutBytes(key, buf, contentType);
  if (S3_API_ENDPOINT) {
    return `${S3_API_ENDPOINT.replace(/\/+$/, "")}/${S3_PLUGINS_BUCKET}/${key}`;
  }
  return `s3://${S3_PLUGINS_BUCKET}/${key}`;
}

// --- import (simplified zip discover/commit) --------------------------------------

// Hard cap on any discovered archive (GitHub zipball or direct upload).
// Mirrors Python ``MAX_ZIP_BYTES`` in tool_import.py.
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

// S3 prefix for discover zip archives (parity with Python ``STAGING_PREFIX``).
// ``archive_key`` is a 32-char hex id (``uuid.uuid4().hex`` equivalent).
// Staging is **S3-only** so any stateless API replica can commit after discover:
//   - ``imports/staging/<archive_key>.zip`` — archive bytes
//   - ``imports/staging/<archive_key>.meta.json`` — import metadata (github_url, etc.)
// Bucket lifecycle: scope rules to this prefix only (filter ``imports/staging/``) so
// ``plugins/``, ``skills/``, icons, etc. are never expired by the same rule.
const STAGING_PREFIX = "imports/staging/";
const STAGE_TTL_MS = 3600_000;

function stagingS3Key(archiveKey: string): string {
  return `${STAGING_PREFIX}${archiveKey}.zip`;
}

/** Sidecar JSON written next to the staged zip (small, shared across replicas). */
function stagingMetaS3Key(archiveKey: string): string {
  return `${STAGING_PREFIX}${archiveKey}.meta.json`;
}

/**
 * Writes staged zip + metadata to S3. Required for multi-replica APIs (no in-memory fallback).
 * Rolls back the zip object if the meta upload fails.
 */
async function stagePut(buf: Buffer, meta: JsonObject): Promise<string> {
  const key = randomBytes(16).toString("hex");
  const zipKey = stagingS3Key(key);
  const metaKey = stagingMetaS3Key(key);
  try {
    await s3PutBytes(zipKey, buf, "application/zip");
    await s3PutBytes(metaKey, Buffer.from(JSON.stringify(meta), "utf-8"), "application/json");
  } catch (e) {
    await Promise.allSettled([s3DeleteObjectKey(zipKey), s3DeleteObjectKey(metaKey)]);
    throw e;
  }
  return key;
}

/**
 * Loads staged zip bytes when the object exists and is within ``STAGE_TTL_MS`` of LastModified.
 * Returns null on missing object, expiry, or S3 errors (caller maps to ``unknown or expired archive_key``).
 */
async function stageGet(archiveKey: string): Promise<Buffer | null> {
  try {
    const head = await getS3Client().send(
      new HeadObjectCommand({ Bucket: S3_PLUGINS_BUCKET, Key: stagingS3Key(archiveKey) }),
    );
    const lm = head.LastModified;
    if (lm && Date.now() - lm.getTime() > STAGE_TTL_MS) return null;
    return await s3DownloadBytes(stagingS3Key(archiveKey));
  } catch {
    return null;
  }
}

/**
 * Loads import metadata written at discover time. Empty object when sidecar is missing
 * (e.g. legacy staging zip only) or on read errors.
 */
async function stageGetMeta(archiveKey: string): Promise<JsonObject> {
  try {
    const raw = await s3DownloadBytes(stagingMetaS3Key(archiveKey));
    const parsed: unknown = JSON.parse(raw.toString("utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    return {};
  } catch {
    return {};
  }
}

/** Removes staged zip and metadata from S3 (best-effort, same as prior single-key delete). */
async function stageDelete(archiveKey: string): Promise<void> {
  await Promise.allSettled([s3DeleteObjectKey(stagingS3Key(archiveKey)), s3DeleteObjectKey(stagingMetaS3Key(archiveKey))]);
}

// --- skill helpers (mirrors the original Python tool_import) ---------------

// Strict skill/rule name charset; also used to validate ``name_override`` from the UI.
// Parity with Python ``SKILL_NAME_SAFE`` in tool_import.py.
const SKILL_NAME_SAFE = /^[A-Za-z0-9._-]+$/;

// Fold a raw ``name:`` value to the portable charset.
// Keeps alnum, CJK, ``-_.``; spaces collapse to ``-``; other chars drop.
function normalizeSkillNameValue(raw: string): string {
  let s = raw.trim();
  // Python ``str.strip("\"'")`` peels any run of ``"`` or ``'`` from both ends,
  // not just a single matched pair. Mirror that, otherwise values like
  // ``""foo""`` would leak a stray quote into the DB ``name``.
  s = s.replace(/^['"]+|['"]+$/g, "");
  if (!s) return "";
  const buf: string[] = [];
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    const isCJK = cp >= 0x4e00 && cp <= 0x9fff;
    if (/[A-Za-z0-9]/.test(c) || c === "-" || c === "_" || c === "." || isCJK) {
      buf.push(c);
    } else if (/\s/.test(c)) {
      buf.push("-");
    }
  }
  return buf.join("").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

// Normalize newline conventions to plain ``\n`` so downstream parsers never
// have to special-case ``\r\n`` (Windows) or lone ``\r`` (legacy Mac). Apply
// at the entry of every line-oriented parser below.
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

// Strip leading/trailing whitespace including ASCII spaces/tabs, ``\r``,
// ``\n``, ``\f``, ``\v``, plus a pragmatic set of Unicode invisibles
// (NBSP, zero-width spaces/joiners, BOM). Used to clean every outbound
// ``name`` / ``description`` value extracted from user-supplied SKILL/rule
// files where rogue whitespace from copy-paste or YAML serializers would
// otherwise leak into the DB. Aliased to the same regex as ``trimAll`` (the
// inbound request-validation helper) so file-derived and form-derived values
// share one whitespace policy.
const trimOuterWhitespace = trimAll;

// First top-level ``title:`` line wins, falling back to the first ``name:``
// line. Both keys are matched case-insensitively (``Title:``, ``NAME:`` etc).
// Values go through the same normalization. When ``title:`` is present but
// normalizes to an empty string, we still fall back to ``name:`` so a stray
// ``title: ""`` does not blank out a perfectly good ``name:``.
function skillNameFromHeaderLine(body: string): string {
  // Normalize newlines first so the line-anchored regex below works for LF,
  // CRLF, and lone CR inputs without per-call branching.
  const t = normalizeNewlines(body);
  // Use ``[ \t]*`` (not ``\s*``) around the colon so we never cross a newline
  // and accidentally let ``[^\n]*`` start from the next line's content.
  const titleMatch = t.match(/(?:^|\n)[ \t]*title:[ \t]*([^\n]*)(?:\n|$)/i);
  if (titleMatch) {
    // ``trimOuterWhitespace`` first so leading invisibles (NBSP / zero-width)
    // do not survive into ``normalizeSkillNameValue`` and silently widen
    // unintended characters into the DB ``name``.
    const v = normalizeSkillNameValue(trimOuterWhitespace(titleMatch[1] || ""));
    if (v) return trimOuterWhitespace(v);
  }
  const nameMatch = t.match(/(?:^|\n)[ \t]*name:[ \t]*([^\n]*)(?:\n|$)/i);
  if (!nameMatch) return "";
  return trimOuterWhitespace(normalizeSkillNameValue(trimOuterWhitespace(nameMatch[1] || "")));
}

// YAML frontmatter ``description:`` parser (plain value + ``>-`` folded blocks).
function frontmatterDescriptionLines(fmLines: string[]): string {
  let i = 0;
  while (i < fmLines.length) {
    const m = fmLines[i].match(/^description:\s*(.*)$/);
    if (!m) { i++; continue; }
    const first = trimOuterWhitespace(m[1]);
    if (first === ">-" || first === ">" || first === "|" || first === "|-" || first === "") {
      i++;
      const parts: string[] = [];
      while (i < fmLines.length) {
        const ln = fmLines[i];
        if (ln.startsWith("  ") || ln.startsWith("\t")) {
          parts.push(trimOuterWhitespace(ln)); i++;
        } else if (!ln.trim()) {
          i++;
        } else if (/^[A-Za-z0-9_.-]+:/.test(ln)) {
          break;
        } else {
          break;
        }
      }
      return trimOuterWhitespace(parts.join(" "));
    }
    return trimOuterWhitespace(first.replace(/^["']|["']$/g, ""));
  }
  return "";
}

// Preview from YAML frontmatter ``description`` field (plus tail fallback).
// Returns null when body has no ``--- ... ---`` frontmatter at all.
function skillFrontmatterDescription(body: string): string | null {
  const raw = normalizeNewlines(body.replace(/^\uFEFF/, ""));
  const lines = raw.split("\n");
  if (lines.length < 2 || lines[0].trim() !== "---") return null;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx < 0) return null;
  const fm = lines.slice(1, endIdx);
  const tail = trimOuterWhitespace(lines.slice(endIdx + 1).join("\n"));
  let desc = frontmatterDescriptionLines(fm);
  if (!desc && tail) desc = tail.slice(0, 500);
  else if (desc) desc = desc.slice(0, 500);
  else desc = "Imported skill";
  return trimOuterWhitespace(desc);
}

// Returns ``[title, description]`` where title comes from an in-body ``name:`` line
// (may be empty) and description is either the frontmatter preview or the body sans
// the leading ``#`` heading.
function readSkillTitle(body: string): [string, string] {
  let desc = "Imported skill";
  const fmd = skillFrontmatterDescription(body);
  if (fmd !== null) {
    desc = fmd;
  } else {
    const lines = trimOuterWhitespace(normalizeNewlines(body)).split("\n");
    let rest = lines;
    if (lines.length && lines[0].trim().startsWith("#")) rest = lines.slice(1);
    const joined = trimOuterWhitespace(rest.join("\n")).slice(0, 500);
    desc = joined || "Imported skill";
  }
  const title = skillNameFromHeaderLine(body);
  return [trimOuterWhitespace(title), trimOuterWhitespace(desc)];
}

// True when ``child`` dir sits strictly under ``parent``. Empty parent is the archive root.
function isDescendantDir(child: string, parent: string): boolean {
  if (child === parent) return false;
  if (parent === "") return child !== "";
  return child.startsWith(parent + "/");
}

// Drop skill roots that nest under another root. Shallow-first sort so ancestors win.
function minimalSkillRoots(roots: string[]): string[] {
  const uniq = [...new Set(roots)];
  const ordered = uniq.sort((a, b) => {
    const da = a === "" ? 0 : a.split("/").length;
    const db = b === "" ? 0 : b.split("/").length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  const kept: string[] = [];
  for (const r of ordered) {
    if (kept.some((p) => isDescendantDir(r, p))) continue;
    kept.push(r);
  }
  return kept;
}

// Extract all files whose archive path sits under the skill root ``rel``.
// The top-level root (``rel===""``) collects only ``SKILL.md`` (parity with Python).
function collectSkillFiles(zip: AdmZip, rel: string): Array<[string, Buffer]> {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const out: Array<[string, Buffer]> = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.split("/").includes("..")) continue;
    let inner: string;
    if (clean) {
      if (name !== `${clean}/SKILL.md` && !name.startsWith(`${clean}/`)) continue;
      inner = name.slice(clean.length + 1);
    } else {
      if (name !== "SKILL.md") continue;
      inner = "SKILL.md";
    }
    if (!inner || inner.split("/").includes("..")) continue;
    try {
      out.push([inner, entry.getData()]);
    } catch {
      /* skip unreadable entries */
    }
  }
  return out;
}

// Canonical S3 object suffix for a skill file: ``skills/<name>/<inner>``.
// The zip-side ``rel`` is intentionally not leaked into the S3 layout so outer
// archive prefixes like ``my_repo/.cursor/skills/foo/`` collapse to ``skills/foo/``.
function skillS3ObjectSuffix(inner: string, skillName: string): string {
  const innerN = inner.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!innerN || innerN.split("/").includes("..")) {
    throw new BadRequestError("invalid skill inner path");
  }
  const name = (skillName || "").trim();
  if (!name || !SKILL_NAME_SAFE.test(name)) {
    throw new BadRequestError("invalid skill name for S3 key normalization");
  }
  return `skills/${name}/${innerN}`;
}

// Tags trimmed of empty entries; version defaulted to 1.0.0.
function normalizeImportCommitMeta(
  commitTags: string[] | undefined,
  commitVersion: string | null,
): [string[], string] {
  const tags = (commitTags ?? []).map((x) => String(x).trim()).filter(Boolean);
  const v = (commitVersion ?? "").trim();
  return [tags, v || defaultVersion()];
}

// --- rule helpers (mirrors tool_import.py:rule_* + path/folder helpers) ---

const DESC_FALLBACK_LEN = 512;

// Edge punctuation for rule description trimming. Matches Python's
// ``string.punctuation`` plus the CJK set in tool_import.py (same codepoints).
const DESC_EDGE_PUNCT = new Set<string>([
  ..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
  ..."\u201c\u201d\u2018\u2019\uff0c\u3002\u3001\uff1b\uff1a\uff1f\uff01",
  ..."\u300c\u300d\u300e\u300f\u3010\u3011\u300a\u300b\u2026\u2014\u00b7",
  ..."\uff08\uff09\uff02\uff07",
]);

function stripOuterSpaceAndPunct(s: string): string {
  let t = s.trim();
  while (t && (/\s/.test(t[0]) || DESC_EDGE_PUNCT.has(t[0]))) t = t.slice(1);
  while (t && (/\s/.test(t[t.length - 1]) || DESC_EDGE_PUNCT.has(t[t.length - 1]))) {
    t = t.slice(0, -1);
  }
  return t.trim();
}

// Parse a double/single-quoted value starting at ``s[0]``. Supports ``\X`` escapes.
// Returns the unquoted content, or null when the closing quote is missing.
function readQuotedValue(s: string, quote: string): string | null {
  if (!s || s[0] !== quote) return null;
  let i = 1;
  const out: string[] = [];
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      out.push(s[i + 1]); i += 2; continue;
    }
    if (s[i] === quote) return out.join("");
    out.push(s[i]); i++;
  }
  return null;
}

// Return the inside of a ``--- ... ---`` YAML frontmatter block, or null.
function frontmatterInner(text: string): string | null {
  const t0 = normalizeNewlines(text.replace(/^\uFEFF/, ""));
  if (!t0.startsWith("---")) return null;
  let rest = t0.slice(3);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  const m = rest.match(/^---\s*$/m);
  if (!m || m.index === undefined) return null;
  return rest.slice(0, m.index);
}

// Extract the first ``description:`` value from frontmatter, falling back to
// scanning the whole document. Quoted values win; bare values strip trailing
// ``# comments``. Returns null when no key is present.
function tryExtractDescriptionKey(text: string): string | null {
  const t = normalizeNewlines(text);
  const blocks: string[] = [];
  const fm = frontmatterInner(t);
  if (fm !== null) blocks.push(fm);
  blocks.push(t);
  for (const block of blocks) {
    const re = /^\s*description\s*:?\s*/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const sub = block.slice(m.index + m[0].length);
      const subL = sub.replace(/^\s+/, "");
      if (subL.startsWith('"')) {
        const inner = readQuotedValue(subL, '"');
        if (inner !== null) return trimOuterWhitespace(inner);
        continue;
      }
      if (subL.startsWith("'")) {
        const inner = readQuotedValue(subL, "'");
        if (inner !== null) return trimOuterWhitespace(inner);
        continue;
      }
      const lineRest = subL.split("\n")[0];
      const val = trimOuterWhitespace(lineRest.split("#")[0]);
      if (val) return val;
    }
  }
  return null;
}

// Description used both in DB storage and discover previews for rule files.
function ruleDescriptionFromFileBody(text: string): string {
  const parsed = tryExtractDescriptionKey(text);
  const raw = normalizeNewlines(text);
  const candidate = parsed === null || !parsed.trim()
    ? raw.slice(0, DESC_FALLBACK_LEN)
    : trimOuterWhitespace(parsed);
  return trimOuterWhitespace(stripOuterSpaceAndPunct(candidate));
}

// True when any directory segment equals ``rules`` and a file name follows it.
function pathUnderRulesFolder(norm: string): boolean {
  const parts = norm.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase() === "rules" && parts.length > i + 1) return true;
  }
  return false;
}

// Rule display name = basename; fallback ``rule`` so empty archive paths still name.
function ruleNameFromPath(norm: string): string {
  const base = path.posix.basename(norm);
  return base ? base.slice(0, 255) : "rule";
}

// Map well-known rule extensions to a content-type; unknown types go binary.
function guessRuleContentType(inner: string): string {
  const low = inner.toLowerCase();
  if (low.endsWith(".md")) return "text/markdown";
  if (low.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

// --- shared zip + import helpers -------------------------------------------

// Tolerant lookup by normalized entry name (used by rule/hooks commit paths).
function zipResolveEntry(zip: AdmZip, target: string): AdmZip.IZipEntry | null {
  const want = target.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const e of zip.getEntries()) {
    const n = e.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
    if (n === want) return e;
  }
  return null;
}

// --- hooks helpers (mirrors tool_import.py:hooks_* + bundle helpers) ------

const TOOL_NAME_SEGMENT_UNSAFE = /[^A-Za-z0-9._-]+/g;

// Fold an arbitrary string to the ``[A-Za-z0-9._-]`` charset for tool-name
// suffix segments; strip leading/trailing ``._-`` and cap to ``maxLen``.
function sanitizeToolNameSegment(raw: string, maxLen = 200): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const out = s.replace(TOOL_NAME_SEGMENT_UNSAFE, "_").replace(/^[._-]+|[._-]+$/g, "");
  return out ? out.slice(0, maxLen) : "";
}

// First non-empty ``name_override`` across hooks selections (bundle-level name).
function hooksBundleNameOverride(selections: JsonObject[]): string {
  for (const sel of selections) {
    const raw = String(sel.name_override ?? "").trim();
    if (raw) return raw;
  }
  return "";
}

// Legacy shape compat: expand nested ``scripts`` into one dict per script.
// Top-level ``relative_path`` items (older UI) pass through unchanged.
function flattenHooksCommitSelections(selections: JsonObject[]): JsonObject[] {
  const flat: JsonObject[] = [];
  for (const sel of selections) {
    const scripts = sel.scripts;
    if (Array.isArray(scripts) && scripts.length > 0) {
      for (const item of scripts) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as JsonObject;
        const rel = String(rec.relative_path ?? "").trim().replace(/\\/g, "/");
        if (!rel) continue;
        const row: JsonObject = { ...sel };
        delete row.scripts;
        row.relative_path = rel;
        flat.push(row);
      }
      continue;
    }
    const rel = String(sel.relative_path ?? "").trim().replace(/\\/g, "/");
    if (rel) flat.push(sel);
  }
  return flat;
}

// Build 4-tuple rows from scan_zip_for_hooks output for ``deriveHooksToolName``.
function hookScriptsToDeriveRows(
  hookScripts: JsonObject[],
): Array<[string, string, Buffer, string]> {
  const rows: Array<[string, string, Buffer, string]> = [];
  for (const s of hookScripts) {
    const rel = String(s.relative_path ?? "").trim().replace(/\\/g, "/");
    if (rel) rows.push([rel, "", Buffer.alloc(0), ""]);
  }
  return rows;
}

// Bundle display name: ``hooks_`` + (first tag slug || first script basename slug || random-hex-16).
function deriveHooksToolName(
  tags: string[],
  rows: Array<[string, string, Buffer, string]>,
): string {
  const prefix = "hooks_";
  if (tags.length) {
    const seg = sanitizeToolNameSegment(tags[0]);
    if (seg) return prefix + seg;
  }
  if (rows.length) {
    const bn = path.posix.basename(String(rows[0][0]).replace(/\\/g, "/"));
    const seg = sanitizeToolNameSegment(bn);
    if (seg) return prefix + seg;
  }
  return prefix + randomBytes(8).toString("hex");
}

// True when ``norm`` lives under a directory segment named ``hooks`` (case-insensitive).
// Matches both ``hooks/x.sh`` and ``repo/hooks/sub/x.sh``; excludes files literally named ``hooks``.
function pathUnderHooksFolder(norm: string): boolean {
  const n = norm.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!n || n.split("/").includes("..")) return false;
  const nl = n.toLowerCase();
  if (nl.startsWith("hooks/")) return true;
  return nl.includes("/hooks/");
}

// Tolerant textual containment: full path / basename / any trailing subpath.
function pathStringInHooksJson(norm: string, hooksText: string): boolean {
  if (!hooksText) return false;
  const n = norm.replace(/\\/g, "/").trim();
  if (n && hooksText.includes(n)) return true;
  const bn = path.posix.basename(n);
  if (bn && hooksText.includes(bn)) return true;
  const parts = n.split("/");
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(i).join("/").trim();
    if (sub && hooksText.includes(sub)) return true;
  }
  return false;
}

// Decode hooks.json bytes; ``obj`` falls back to ``{}`` when JSON is invalid.
function parseHooksJsonBytes(raw: Buffer): [unknown, string] {
  const text = raw.toString("utf-8");
  try {
    return [JSON.parse(text), text];
  } catch {
    return [{}, text];
  }
}

// First archive member whose basename is ``hooks.json`` (case-insensitive); sorted for stability.
function firstHooksJsonPathInZip(zip: AdmZip): string | null {
  const paths: string[] = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const n = e.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
    if (path.posix.basename(n).toLowerCase() === "hooks.json") paths.push(n);
  }
  paths.sort();
  return paths.length ? paths[0] : null;
}

// Cheap ``hooks.json`` existence probe (reads archive entries only).
function zipHasHooksJsonFile(data: Buffer): boolean {
  const zip = new AdmZip(data);
  return firstHooksJsonPathInZip(zip) !== null;
}

// Return the inclusive path starting at the first ``folder/`` segment.
// Example: ``repo/.cursor/hooks/a.py`` -> ``hooks/a.py``.
function s3SuffixAfterFolder(archivePath: string, folder: string): string {
  const n = archivePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!n || n.split("/").includes("..")) throw new Error("invalid archive path");
  const fl = folder.replace(/^\/+|\/+$/g, "").toLowerCase();
  const low = n.toLowerCase();
  const needle = `/${fl}/`;
  const idx = low.indexOf(needle);
  if (idx >= 0) return n.slice(idx + 1).replace(/^\/+/, "");
  if (low.startsWith(`${fl}/`)) return n;
  throw new Error(`missing ${folder}/ segment`);
}

// Archive path -> key suffix under ``plugins/{id}/{ver}/hooks/`` (no leading ``hooks/``).
function hooksInnerPathFromArchive(archiveRel: string): string {
  const r = archiveRel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!r || r.split("/").includes("..")) throw new Error("invalid archive path for hooks s3 key");
  let seg: string;
  try {
    seg = s3SuffixAfterFolder(r, "hooks");
  } catch {
    const bn = path.posix.basename(r);
    if (!bn) throw new Error("invalid archive path for hooks s3 key");
    return bn;
  }
  const low = seg.toLowerCase();
  if (low.startsWith("hooks/")) return seg.slice(6);
  if (low === "hooks") return "";
  return seg;
}

// Full S3 object key for a hook file under the bundle prefix.
function hooksBundleObjectKey(hooksDirWithSlash: string, archiveRel: string): string {
  const inner = hooksInnerPathFromArchive(archiveRel);
  if (!inner) throw new Error("empty hooks inner path");
  const base = hooksDirWithSlash.endsWith("/") ? hooksDirWithSlash : `${hooksDirWithSlash}/`;
  return `${base}${inner}`;
}

// Hooks commit guard: zip/github discover paths only; blocks single-file uploads.
// ``fromStagedArchive`` is true when invoked via commitImportSelections.
function importAllowsHooks(meta: JsonObject, fromStagedArchive: boolean): boolean {
  if (fromStagedArchive) return true;
  if (String(meta.github_url ?? "").trim()) return true;
  if (String(meta.import_source ?? "").trim() === "zip_upload") return true;
  const fn = String(meta.filename ?? "").trim().toLowerCase();
  return fn.endsWith(".zip");
}

// --- scan + commit (zip import) --------------------------------------------

// Collect skill roots, merge nested SKILL.md into their outer root, and build
// one candidate per root with title/description parsed from SKILL.md.
function scanZipSkills(data: Buffer, subdir = ""): JsonObject[] {
  const sub = subdir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const zip = new AdmZip(data);
  const rootsRaw: string[] = [];
  const seen = new Set<string>();
  for (const ent of zip.getEntries()) {
    const n = ent.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
    if (sub && !(n === sub || n.startsWith(`${sub}/`))) continue;
    if (path.posix.basename(n).toLowerCase() !== "skill.md") continue;
    const parent = path.posix.dirname(n);
    const root = parent === "." ? "" : parent;
    if (seen.has(root)) continue;
    seen.add(root);
    rootsRaw.push(root);
  }
  const roots = minimalSkillRoots(rootsRaw);
  const out: JsonObject[] = [];
  for (const root of [...roots].sort()) {
    const skillPath = root ? `${root}/SKILL.md` : "SKILL.md";
    let body = "";
    try {
      body = zip.readAsText(skillPath);
    } catch {
      body = "";
    }
    let title = "";
    let desc = "Imported skill";
    if (body) {
      [title, desc] = readSkillTitle(body);
    }
    if (!title || title === "skill" || title === "---") {
      title = root ? path.posix.basename(root) : "skill";
    }
    const nameOk = SKILL_NAME_SAFE.test(title);
    out.push({
      relative_path: root,
      name: title.slice(0, 255),
      description: desc,
      requires_name: !nameOk,
      type: "skill",
    });
  }
  return out;
}

// One candidate per real file whose path sits under a ``rules`` segment.
function scanZipForRules(data: Buffer): JsonObject[] {
  const zip = new AdmZip(data);
  const paths: string[] = [];
  for (const info of zip.getEntries()) {
    if (info.isDirectory) continue;
    const norm = info.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm.split("/").includes("..")) continue;
    if (!pathUnderRulesFolder(norm)) continue;
    paths.push(norm);
  }
  const out: JsonObject[] = [];
  for (const norm of [...paths].sort()) {
    let body = "";
    try { body = zip.readAsText(norm); } catch { body = ""; }
    const title = ruleNameFromPath(norm);
    const desc = ruleDescriptionFromFileBody(body);
    const nameOk = SKILL_NAME_SAFE.test(title);
    out.push({
      relative_path: norm,
      name: title,
      description: desc,
      requires_name: !nameOk,
      type: "rule",
    });
  }
  return out;
}

// Find the first ``hooks.json`` and enumerate hook scripts referenced by its text.
// Returns an empty list when the archive has no ``hooks.json``.
function scanZipForHooks(data: Buffer): JsonObject[] {
  const zip = new AdmZip(data);
  const hooksPaths: string[] = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const n = e.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
    if (path.posix.basename(n).toLowerCase() === "hooks.json") hooksPaths.push(n);
  }
  hooksPaths.sort();
  if (!hooksPaths.length) return [];
  const hooksPath = hooksPaths[0];
  const hn = zipResolveEntry(zip, hooksPath);
  if (!hn) return [];
  let rawH: Buffer;
  try { rawH = hn.getData(); } catch { return []; }
  const [, hooksText] = parseHooksJsonBytes(rawH);
  const out: JsonObject[] = [];
  for (const info of zip.getEntries()) {
    if (info.isDirectory) continue;
    const norm = info.entryName.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm.split("/").includes("..")) continue;
    if (norm === hooksPath) continue;
    // Any other ``hooks.json`` members are non-authoritative; never emitted as script candidates.
    if (path.posix.basename(norm).toLowerCase() === "hooks.json") continue;
    if (!pathUnderHooksFolder(norm)) continue;
    if (pathUnderRulesFolder(norm)) continue;
    if (path.posix.basename(norm).toLowerCase() === "skill.md") continue;
    if (!pathStringInHooksJson(norm, hooksText)) continue;
    const scriptBn = path.posix.basename(norm);
    const nameOk = SKILL_NAME_SAFE.test(scriptBn);
    out.push({
      relative_path: norm,
      hooks_json_relative_path: hooksPath,
      name: scriptBn.slice(0, 255),
      description: "",
      requires_name: !nameOk,
    });
  }
  out.sort((a, b) => String(a.relative_path).localeCompare(String(b.relative_path)));
  return out;
}

// Stable discover sort: by type then by archive path / hooks_json_relative_path.
function importCandidateSortKey(a: JsonObject, b: JsonObject): number {
  const tA = String(a.type ?? "").toLowerCase();
  const tB = String(b.type ?? "").toLowerCase();
  if (tA !== tB) return tA.localeCompare(tB);
  const keyOf = (item: JsonObject): string => {
    const t = String(item.type ?? "").toLowerCase();
    const k = t === "hooks"
      ? String(item.hooks_json_relative_path ?? "")
      : String(item.relative_path ?? "");
    return k.replace(/\\/g, "/");
  };
  return keyOf(a).localeCompare(keyOf(b));
}

// Aggregate discover: skills + hooks bundle (with nested scripts) + rules.
function scanZipForImport(data: Buffer): JsonObject[] {
  const out: JsonObject[] = [];
  for (const c of scanZipSkills(data, "")) out.push({ ...c, type: "skill" });
  if (zipHasHooksJsonFile(data)) {
    const hookScripts = scanZipForHooks(data);
    let hooksPath = "";
    if (hookScripts.length > 0) {
      hooksPath = String(hookScripts[0].hooks_json_relative_path ?? "").replace(/\\/g, "/");
    } else {
      const zip = new AdmZip(data);
      hooksPath = (firstHooksJsonPathInZip(zip) ?? "").replace(/\\/g, "/");
    }
    const nestedScripts: JsonObject[] = [];
    for (const c of hookScripts) {
      const entry: JsonObject = {};
      for (const [k, v] of Object.entries(c)) {
        if (k !== "hooks_json_relative_path") entry[k] = v;
      }
      nestedScripts.push(entry);
    }
    const deriveRows = hookScriptsToDeriveRows(hookScripts);
    const bundleName = deriveHooksToolName([], deriveRows);
    out.push({
      type: "hooks",
      name: bundleName,
      requires_name: !bundleName.trim(),
      hooks_json_relative_path: hooksPath,
      scripts: nestedScripts,
    });
  }
  for (const c of scanZipForRules(data)) out.push({ ...c, type: "rule" });
  out.sort(importCandidateSortKey);
  return out;
}

export async function runDiscoverZip(
  raw: Buffer,
  metaBase: JsonObject,
): Promise<[string, JsonObject[], number]> {
  if (raw.length > MAX_ZIP_BYTES) throw new BadRequestError("archive exceeds size limit");
  try {
    new AdmZip(raw);
  } catch {
    throw new BadRequestError("not a valid zip archive");
  }
  const candidates = scanZipForImport(raw);
  const archiveKey = await stagePut(raw, { ...metaBase, import_source: "zip_upload" });
  return [archiveKey, candidates, candidates.length];
}

// --- commit helpers (per-selection workers, one per import type) -----------

interface CommitWorkerOpts {
  ownerUserId: string;
  author: string | null;
  tags: string[];
  ver: string;
  // When true, upsert paths skip the owner check and let an administrator
  // overwrite tools owned by another user. The original owner_user_id is
  // preserved by upsertToolOnce; admins do not silently take ownership.
  isAdmin: boolean;
}

// Emit a single audit line whenever an administrator's import touches a tool
// row not owned by the acting user. Cheap on the hot path: skip when the
// caller is not an admin or when the row owner already matches.
function logAdminOverrideIfAny(
  kind: "skill" | "rule" | "hooks",
  toolName: string,
  opts: CommitWorkerOpts,
  row: JsonObject,
  upsertAction: string,
): void {
  if (!opts.isAdmin) return;
  const rowOwner = String(row.owner_user_id ?? "").trim();
  const acting = String(opts.ownerUserId ?? "").trim();
  if (!rowOwner || !acting || rowOwner === acting) return;
  logger.warn(
    {
      kind,
      tool_name: toolName,
      tool_id: row.id ?? null,
      version: row.version ?? opts.ver,
      original_owner_user_id: rowOwner,
      acting_user_id: acting,
      upsert_action: upsertAction,
    },
    "import.admin_override",
  );
}

async function commitOneSkill(
  sel: JsonObject,
  zip: AdmZip,
  meta: JsonObject,
  index: Map<string, JsonObject>,
  opts: CommitWorkerOpts,
): Promise<JsonObject> {
  // ``.trim()`` mirrors Python ``(sel.get("relative_path") or "").strip()``.
  const rel = String(sel.relative_path ?? "").trim().replace(/\\/g, "/");
  const nameOverride = String(sel.name_override ?? "").trim();
  const base = index.get(rel);
  if (!base) {
    return {
      type: "skill", relative_path: rel, name: "",
      status: "failed", error: "skill not found in archive",
    };
  }
  const skillName = nameOverride || String(base.name ?? "");
  if (!skillName) {
    return {
      type: "skill", relative_path: rel, name: "",
      status: "failed", error: "skill name is required",
    };
  }
  if (!SKILL_NAME_SAFE.test(skillName)) {
    return {
      type: "skill", relative_path: rel, name: skillName,
      status: "failed", error: "invalid skill name (use A-Za-z0-9._-)",
    };
  }
  const desc = (trimOuterWhitespace(String(base.description ?? "")) || `Imported skill: ${skillName}`).slice(0, 10000);
  const files = collectSkillFiles(zip, rel);
  if (!files.length) {
    return {
      type: "skill", relative_path: rel, name: skillName,
      status: "failed", error: "no files extracted",
    };
  }
  const githubUrl = String(meta.github_url ?? "").trim();
  // ``icon_url: null`` mirrors Python import payload so ``toolInplaceUpdates`` clears
  // the stored icon on in-place upserts (same as ``payload.get("icon_url")`` → None).
  const payload: JsonObject = {
    type: "skill",
    name: skillName,
    version: opts.ver,
    description: desc,
    display_name: skillName,
    tags: opts.tags,
    icon_url: null,
    config: {},
    author: opts.author,
    tool_source: githubUrl ? "github" : "upload",
    tool_source_url: githubUrl || null,
    owner_user_id: opts.ownerUserId,
    is_public: true,
    status: "active",
  };
  let row: JsonObject;
  let upsertAction: string;
  try {
    [row, upsertAction] = await upsertTool(payload, opts.ownerUserId, opts.isAdmin);
    logAdminOverrideIfAny("skill", skillName, opts, row, upsertAction);
  } catch (e) {
    if (e instanceof UpsertConflictError) {
      return { type: "skill", relative_path: rel, name: skillName, status: "failed", error: "same name and version already exists" };
    }
    if (e instanceof UpsertToolTypeChangeError) {
      return { type: "skill", relative_path: rel, name: skillName, status: "failed", error: "tool type cannot be changed for an existing tool name" };
    }
    if (e instanceof UpsertPermissionError) {
      return { type: "skill", relative_path: rel, name: skillName, status: "failed", error: "not allowed to modify this tool" };
    }
    // Map ToolDuplicate/ToolVersionDuplicate (and raw pg 23505 unique_violation)
    // to the same text Python returns for IntegrityError-style duplicates.
    if (
      e instanceof ToolDuplicateError ||
      e instanceof ToolVersionDuplicateError ||
      (e as { code?: string } | null)?.code === "23505"
    ) {
      return { type: "skill", relative_path: rel, name: skillName, status: "failed", error: "tool with same name exists" };
    }
    return { type: "skill", relative_path: rel, name: skillName, status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  const tid = Number(row.id);
  const prefix = s3PluginsCommitPrefix(tid, opts.ver);
  const skillRootPrefix = `${prefix}skills/${skillName}/`;
  let cfg: JsonObject;
  try {
    if (files.length === 1) {
      const [inner, blob] = files[0];
      const key = prefix + skillS3ObjectSuffix(inner, skillName);
      const ct = inner.toLowerCase().endsWith(".md") ? "text/markdown" : "application/octet-stream";
      await s3PutBytes(key, blob, ct);
      cfg = { s3_key: key, is_prefix: false };
    } else {
      for (const [inner, blob] of files) {
        const key = prefix + skillS3ObjectSuffix(inner, skillName);
        const ct = inner.toLowerCase().endsWith(".md") ? "text/markdown" : "application/octet-stream";
        await s3PutBytes(key, blob, ct);
      }
      cfg = { s3_key: skillRootPrefix, is_prefix: true };
    }
  } catch (e) {
    return { type: "skill", relative_path: rel, name: skillName, status: "failed", error: `s3: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    await MarketplaceDb.toolUpdate(tid, { config: cfg });
  } catch (e) {
    return { type: "skill", relative_path: rel, name: skillName, status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  return {
    type: "skill",
    relative_path: rel,
    name: skillName,
    status: "ok",
    tool_id: tid,
    upsert_action: upsertAction,
  };
}

async function commitOneRule(
  sel: JsonObject,
  zip: AdmZip,
  meta: JsonObject,
  index: Map<string, JsonObject>,
  opts: CommitWorkerOpts,
): Promise<JsonObject> {
  // ``.trim()`` mirrors Python ``(sel.get("relative_path") or "").strip()``.
  const rel = String(sel.relative_path ?? "").trim().replace(/\\/g, "/");
  const nameOverride = String(sel.name_override ?? "").trim();
  const base = index.get(rel);
  if (!base) {
    return { type: "rule", relative_path: rel, name: "", status: "failed", error: "rule file not found in archive" };
  }
  const ruleName = nameOverride || String(base.name ?? "");
  if (!ruleName) {
    return { type: "rule", relative_path: rel, name: "", status: "failed", error: "rule name is required" };
  }
  if (!SKILL_NAME_SAFE.test(ruleName)) {
    return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: "invalid rule name (use A-Za-z0-9._-)" };
  }
  let blob: Buffer;
  try {
    const entry = zipResolveEntry(zip, rel);
    if (!entry) throw new Error("not in archive");
    blob = entry.getData();
  } catch (e) {
    return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  const body = blob.toString("utf-8");
  const descStored = ruleDescriptionFromFileBody(body).slice(0, 10000);
  const githubUrl = String(meta.github_url ?? "").trim();
  // Payload fields mirror Python ``_commit_one_rule`` exactly; ``icon_url: null`` like import skill.
  const payload: JsonObject = {
    type: "rule",
    name: ruleName,
    version: opts.ver,
    description: descStored,
    display_name: ruleName,
    tags: opts.tags,
    icon_url: null,
    config: {},
    author: opts.author,
    tool_source: githubUrl ? "github" : "upload",
    tool_source_url: githubUrl || null,
    owner_user_id: opts.ownerUserId,
    is_public: true,
    status: "active",
  };
  let row: JsonObject;
  let upsertAction: string;
  try {
    [row, upsertAction] = await upsertTool(payload, opts.ownerUserId, opts.isAdmin);
    logAdminOverrideIfAny("rule", ruleName, opts, row, upsertAction);
  } catch (e) {
    if (e instanceof UpsertConflictError) {
      return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: "same name and version already exists" };
    }
    if (e instanceof UpsertToolTypeChangeError) {
      return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: "tool type cannot be changed for an existing tool name" };
    }
    if (e instanceof UpsertPermissionError) {
      return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: "not allowed to modify this tool" };
    }
    if (
      e instanceof ToolDuplicateError ||
      e instanceof ToolVersionDuplicateError ||
      (e as { code?: string } | null)?.code === "23505"
    ) {
      return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: "tool with same name exists" };
    }
    return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  const tid = Number(row.id);
  const innerName = path.posix.basename(rel) || "file";
  const key = s3PluginsCommitPrefix(tid, opts.ver) + innerName;
  let cfg: JsonObject;
  try {
    await s3PutBytes(key, blob, guessRuleContentType(innerName));
    cfg = { s3_key: key, is_prefix: false };
  } catch (e) {
    return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: `s3: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    await MarketplaceDb.toolUpdate(tid, { config: cfg });
  } catch (e) {
    return { type: "rule", relative_path: rel, name: ruleName, status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  return {
    type: "rule",
    relative_path: rel,
    name: ruleName,
    status: "ok",
    tool_id: tid,
    upsert_action: upsertAction,
  };
}

// Hooks are committed as one ``tools`` row per archive with the whole ``hooks/``
// prefix uploaded under ``plugins/{tid}/{ver}/hooks/``. ``fromStagedArchive``
// bypasses the hooks gate that blocks single-file uploads at the API layer.
async function commitHooksBatch(
  selections: JsonObject[],
  zip: AdmZip,
  meta: JsonObject,
  index: Map<string, JsonObject>,
  opts: CommitWorkerOpts & { fromStagedArchive?: boolean },
): Promise<JsonObject> {
  if (!importAllowsHooks(meta, opts.fromStagedArchive ?? false)) {
    return {
      type: "hooks",
      status: "failed",
      error: "hooks import requires discover via a GitHub URL or a .zip archive upload (not a single loose file)",
    };
  }
  const bundleSources = selections;
  const flat = flattenHooksCommitSelections(selections);

  const seen = new Set<string>();
  const hooksPaths = new Set<string>();
  type Row = { rel: string; scriptName: string; blob: Buffer; innerName: string };
  const rows: Row[] = [];

  for (const sel of flat) {
    const rel = String(sel.relative_path ?? "").trim().replace(/\\/g, "/");
    if (!rel) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const base = index.get(rel);
    if (!base) {
      return { type: "hooks", status: "failed", error: `hook file not in archive: ${rel}` };
    }
    const hp = String(base.hooks_json_relative_path ?? "").replace(/\\/g, "/");
    hooksPaths.add(hp);
    // Script display labels originate from discover; bundle name override is separate.
    const scriptName = String(base.name ?? "");
    if (!scriptName) {
      return { type: "hooks", status: "failed", error: `hook name is required for ${rel}` };
    }
    if (!SKILL_NAME_SAFE.test(scriptName)) {
      return { type: "hooks", status: "failed", error: `invalid hook name for ${rel} (use A-Za-z0-9._-)` };
    }
    const entry = zipResolveEntry(zip, rel);
    if (!entry) {
      return { type: "hooks", status: "failed", error: `hook file missing from archive: ${rel}` };
    }
    let blob: Buffer;
    try {
      blob = entry.getData();
    } catch (e) {
      return { type: "hooks", status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    const innerName = path.posix.basename(rel) || "file";
    rows.push({ rel, scriptName, blob, innerName });
  }

  let hooksPath: string | null = null;
  if (hooksPaths.size) {
    if (hooksPaths.size !== 1) {
      return { type: "hooks", status: "failed", error: "all hooks in one commit must use the same hooks.json" };
    }
    hooksPath = [...hooksPaths][0];
  } else {
    hooksPath = firstHooksJsonPathInZip(zip);
    if (!hooksPath) {
      return { type: "hooks", status: "failed", error: "hooks.json not found in archive" };
    }
  }
  const hn = zipResolveEntry(zip, hooksPath);
  if (!hn) {
    return { type: "hooks", status: "failed", error: "hooks.json missing from archive" };
  }
  let rawH: Buffer;
  try {
    rawH = hn.getData();
  } catch (e) {
    return { type: "hooks", status: "failed", error: `hooks.json: ${e instanceof Error ? e.message : String(e)}` };
  }

  const overrideName = hooksBundleNameOverride(bundleSources);
  let batchName: string;
  if (overrideName) {
    if (!SKILL_NAME_SAFE.test(overrideName)) {
      return { type: "hooks", status: "failed", error: "invalid hooks bundle name (use A-Za-z0-9._-)" };
    }
    batchName = overrideName;
  } else {
    const deriveRows: Array<[string, string, Buffer, string]> = rows.map(
      (r) => [r.rel, r.scriptName, r.blob, r.innerName],
    );
    batchName = deriveHooksToolName(opts.tags, deriveRows);
  }

  const n = rows.length;
  const desc = (n === 0
    ? "Imported hooks bundle (hooks.json only)"
    : `Imported hooks bundle (${n} hook script${n !== 1 ? "s" : ""})`
  ).slice(0, 10000);
  const ghUrl = String(meta.github_url ?? "").trim();
  // Payload fields mirror Python ``_commit_hooks_batch`` exactly; ``icon_url: null`` like import skill.
  const payload: JsonObject = {
    type: "hooks",
    name: batchName,
    version: opts.ver,
    description: desc,
    display_name: batchName,
    tags: opts.tags,
    icon_url: null,
    config: {},
    author: opts.author,
    tool_source: ghUrl ? "github" : "upload",
    tool_source_url: ghUrl || null,
    owner_user_id: opts.ownerUserId,
    is_public: true,
    status: "active",
  };
  let row: JsonObject;
  let upsertAction: string;
  try {
    [row, upsertAction] = await upsertTool(payload, opts.ownerUserId, opts.isAdmin);
    logAdminOverrideIfAny("hooks", batchName, opts, row, upsertAction);
  } catch (e) {
    if (e instanceof UpsertConflictError) {
      return { type: "hooks", status: "failed", error: "same name and version already exists" };
    }
    if (e instanceof UpsertToolTypeChangeError) {
      return { type: "hooks", status: "failed", error: "tool type cannot be changed for an existing tool name" };
    }
    if (e instanceof UpsertPermissionError) {
      return { type: "hooks", status: "failed", error: "not allowed to modify this tool" };
    }
    if (
      e instanceof ToolDuplicateError ||
      e instanceof ToolVersionDuplicateError ||
      (e as { code?: string } | null)?.code === "23505"
    ) {
      return { type: "hooks", status: "failed", error: "tool with same name exists" };
    }
    return { type: "hooks", status: "failed", error: e instanceof Error ? e.message : String(e) };
  }

  const tid = Number(row.id);
  const hooksDir = `${s3PluginsCommitPrefix(tid, opts.ver)}hooks/`;
  const hooksPrefix = hooksDir.replace(/\/+$/, "");

  try {
    await s3PutBytes(`${hooksDir}hooks.json`, rawH, "application/json");
  } catch (e) {
    return { type: "hooks", status: "failed", error: `s3 hooks.json: ${e instanceof Error ? e.message : String(e)}` };
  }
  for (const r of rows) {
    let key: string;
    try {
      key = hooksBundleObjectKey(hooksDir, r.rel);
    } catch (e) {
      return { type: "hooks", status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    try {
      await s3PutBytes(key, r.blob, guessRuleContentType(r.innerName));
    } catch (e) {
      return { type: "hooks", status: "failed", error: `s3: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const cfg: JsonObject = { s3_key: hooksPrefix, is_prefix: true };
  try {
    await MarketplaceDb.toolUpdate(tid, { config: cfg });
  } catch (e) {
    return { type: "hooks", status: "failed", error: e instanceof Error ? e.message : String(e) };
  }

  const scriptRels = rows.map((r) => r.rel);
  const relativePathsOut = hooksPath ? [hooksPath, ...scriptRels] : scriptRels;
  return {
    type: "hooks",
    status: "ok",
    tool_id: tid,
    name: batchName,
    relative_paths: relativePathsOut,
    upsert_action: upsertAction,
  };
}

export async function commitImportSelections(
  archiveKey: string,
  selections: JsonObject[],
  ownerUserId: string,
  author: string | null,
  commitTags: string[],
  commitVersion: string | null,
  isAdmin: boolean,
): Promise<JsonObject[]> {
  const raw = await stageGet(archiveKey);
  if (!raw) throw new BadRequestError("unknown or expired archive_key");
  // Metadata lives in S3 next to the zip; missing sidecar behaves like Python
  // ``_staging_meta.get(archive_key, {})``. Hooks still commit via ``fromStagedArchive``.
  const meta = await stageGetMeta(archiveKey);
  const [tags, ver] = normalizeImportCommitMeta(commitTags, commitVersion);
  const zip = new AdmZip(raw);
  const idxSkill = new Map<string, JsonObject>();
  for (const c of scanZipSkills(raw)) idxSkill.set(String(c.relative_path ?? ""), c);
  const idxRule = new Map<string, JsonObject>();
  for (const c of scanZipForRules(raw)) idxRule.set(String(c.relative_path ?? ""), c);
  const idxHook = new Map<string, JsonObject>();
  if (zipHasHooksJsonFile(raw)) {
    for (const c of scanZipForHooks(raw)) idxHook.set(String(c.relative_path ?? ""), c);
  }
  const workerOpts: CommitWorkerOpts = { ownerUserId, author, tags, ver, isAdmin };
  const results: JsonObject[] = [];
  // All hooks selections across this commit feed one batched ``tools`` row, so we
  // gather them up front and run the batch at first encounter (then skip the rest).
  // ``.trim().toLowerCase()`` on both paths mirrors Python ``(t or "skill").strip().lower()``.
  const selType = (s: JsonObject): string => String(s.type || "skill").trim().toLowerCase();
  const hookSels = selections.filter((s) => selType(s) === "hooks");
  let hooksBatchDone = false;
  for (const sel of selections) {
    const typ = selType(sel);
    if (typ === "hooks") {
      if (!hooksBatchDone) {
        results.push(await commitHooksBatch(hookSels, zip, meta, idxHook, {
          ...workerOpts, fromStagedArchive: true,
        }));
        hooksBatchDone = true;
      }
      continue;
    }
    if (typ === "skill") {
      results.push(await commitOneSkill(sel, zip, meta, idxSkill, workerOpts));
    } else if (typ === "rule") {
      results.push(await commitOneRule(sel, zip, meta, idxRule, workerOpts));
    } else {
      const rel = String(sel.relative_path ?? "").trim().replace(/\\/g, "/");
      results.push({
        type: typ, relative_path: rel,
        status: "failed", error: "type must be skill, rule, or hooks",
      });
    }
  }
  // Defensive safety net: batch was collected but never triggered inside the loop.
  if (hookSels.length && !hooksBatchDone) {
    results.push(await commitHooksBatch(hookSels, zip, meta, idxHook, {
      ...workerOpts, fromStagedArchive: true,
    }));
  }
  if (results.length) await stageDelete(archiveKey);
  return results;
}

// --- github discover (mirrors the original Python tool_import) ------------

// Parse ``https://github.com/<owner>/<repo>`` or ``.../tree/<ref>/<subpath>`` into
// ``[owner, repo, refAndPathSegments]``. Parity with Python ``parse_github_url``.
function parseGithubUrl(githubUrl: string): { owner: string; repo: string; refAndPath: string[] } {
  let u: URL;
  try {
    u = new URL(String(githubUrl || "").trim());
  } catch {
    throw new BadRequestError("invalid GitHub repository URL");
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
    throw new BadRequestError("only github.com URLs are supported");
  }
  const parts = u.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) throw new BadRequestError("invalid GitHub repository URL");
  const owner = parts[0]!;
  let repo = parts[1]!;
  if (repo.endsWith(".git")) repo = repo.slice(0, -".git".length);
  let refAndPath: string[] = [];
  if (parts.length >= 4 && parts[2] === "tree") refAndPath = parts.slice(3);
  return { owner, repo, refAndPath };
}

// GitHub PAT passed on the discover request only (no env var fallback).
// Parity with Python ``_resolve_github_token``.
function resolveGithubToken(override: string | null | undefined): string {
  return (override || "").trim();
}

// Fine-grained PATs (``github_pat_``) require ``Bearer``; classic PATs use ``token``.
// Parity with Python ``_github_authorization_value``.
function githubAuthorizationValue(token: string): string {
  return token.startsWith("github_pat_") ? `Bearer ${token}` : `token ${token}`;
}

// Attach Authorization only when a PAT was supplied. Parity with
// Python ``_github_archive_auth_headers``.
function githubArchiveAuthHeaders(token: string): Record<string, string> {
  return token ? { Authorization: githubAuthorizationValue(token) } : {};
}

// codeload.github.com archive URL for a branch. We pass PAT via header rather
// than ``?token=`` (short-lived, not reusable). Parity with Python
// ``_github_codeload_branch_zip_url``.
function githubCodeloadBranchZipUrl(owner: string, repo: string, branch: string): string {
  return `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(branch)}`;
}

// Fetch a URL as Buffer with a timeout; returns ``{ status, body }`` and never throws
// on HTTP status. Throws only on network/timeout/abort so the caller can probe
// multiple candidate URLs in sequence.
async function httpGetBytes(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: Buffer }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    const ab = await resp.arrayBuffer();
    return { status: resp.status, body: Buffer.from(ab) };
  } finally {
    clearTimeout(timer);
  }
}

// Download a GitHub repo's zipball. Tries, in order: any ``tree/<ref>/<subpath>``
// prefix (longest to shortest split); with PAT, codeload + archive then REST
// zipball; without PAT, codeload + archive over the default branch candidates.
// Returns ``[zipBytes, subPath]``; ``subPath`` is the ``tree`` suffix the caller
// should prepend when resolving candidates from the archive. Parity with Python
// ``download_github_zip``.
export async function downloadGithubZip(
  githubUrl: string,
  githubToken: string | null | undefined,
): Promise<[Buffer, string]> {
  const tok = resolveGithubToken(githubToken);
  const { owner, repo, refAndPath } = parseGithubUrl(githubUrl);
  const archiveBase = `https://github.com/${owner}/${repo}/archive/refs/heads`;
  const authH = githubArchiveAuthHeaders(tok);

  // Probe default branch via the REST repo endpoint. Private repos can still
  // work via archive/zipball even when this 404s, so only hard-fail on 401.
  const repoHeaders: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (tok) repoHeaders.Authorization = githubAuthorizationValue(tok);
  let defaultBr: string | null = null;
  try {
    const repoResp = await httpGetBytes(
      `https://api.github.com/repos/${owner}/${repo}`,
      repoHeaders,
      120_000,
    );
    if (tok && repoResp.status === 401) {
      throw new BadGatewayError(
        `GitHub API GET /repos/${owner}/${repo} returned HTTP 401. Invalid or expired PAT.`,
      );
    }
    if (repoResp.status === 200) {
      try {
        const parsed = JSON.parse(repoResp.body.toString("utf8"));
        const db = (parsed as { default_branch?: unknown } | null)?.default_branch;
        if (typeof db === "string" && db) defaultBr = db;
      } catch {
        // Non-JSON body; fall back to heuristic branch list below.
      }
    }
  } catch (err) {
    if (err instanceof BadRequestError || err instanceof BadGatewayError) throw err;
    // Network errors on repo metadata are non-fatal: we still try archives.
  }

  const branchCandidates: string[] = [];
  if (defaultBr) branchCandidates.push(defaultBr);
  for (const b of ["main", "master", "develop"]) {
    if (!branchCandidates.includes(b)) branchCandidates.push(b);
  }

  // ``tree/<ref>/<subpath>`` form: split longest to shortest; branch names
  // may themselves contain ``/``, so try every possible split. Archive URLs
  // keep ``/`` in the branch segment (Python interpolates ``branch`` raw);
  // only codeload / REST zipball encode via ``quote(branch, safe="")``.
  if (refAndPath.length > 0) {
    for (let i = refAndPath.length; i >= 1; i--) {
      const branch = refAndPath.slice(0, i).join("/");
      const sub = i < refAndPath.length ? refAndPath.slice(i).join("/") : "";
      for (const url of [
        githubCodeloadBranchZipUrl(owner, repo, branch),
        `${archiveBase}/${branch}.zip`,
      ]) {
        const r = await httpGetBytes(url, authH, 120_000);
        if (r.status === 200 && r.body.length <= MAX_ZIP_BYTES) return [r.body, sub];
      }
    }
  }

  if (tok) {
    // PAT present: codeload + archive first, then REST zipball fallback.
    for (const branch of branchCandidates) {
      for (const url of [
        githubCodeloadBranchZipUrl(owner, repo, branch),
        `${archiveBase}/${branch}.zip`,
      ]) {
        const r = await httpGetBytes(url, authH, 120_000);
        if (r.status === 200 && r.body.length <= MAX_ZIP_BYTES) return [r.body, ""];
      }
    }
    const zbHeaders: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: githubAuthorizationValue(tok),
    };
    let lastStatus = -1;
    let lastBranch = "";
    for (const branch of branchCandidates) {
      const zurl = `https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(branch)}`;
      const r = await httpGetBytes(zurl, zbHeaders, 120_000);
      lastStatus = r.status;
      lastBranch = branch;
      if (r.status === 200) {
        if (r.body.length <= MAX_ZIP_BYTES) return [r.body, ""];
        throw new BadGatewayError(
          `GitHub archive exceeds size limit (${Math.floor(MAX_ZIP_BYTES / (1024 * 1024))} MiB).`,
        );
      }
    }
    throw new BadGatewayError(
      `GitHub archive and zipball failed (last branch=${JSON.stringify(lastBranch)} HTTP ${lastStatus}). ` +
        "Confirm PAT access, Contents: Read, default branch name, and org SSO if applicable.",
    );
  }

  // No PAT: try anonymous codeload + archive over default branch candidates.
  for (const branch of branchCandidates) {
    for (const url of [
      githubCodeloadBranchZipUrl(owner, repo, branch),
      `${archiveBase}/${branch}.zip`,
    ]) {
      const r = await httpGetBytes(url, authH, 120_000);
      if (r.status === 200 && r.body.length <= MAX_ZIP_BYTES) return [r.body, ""];
    }
  }

  throw new BadGatewayError(
    "GitHub archive download failed without authentication. " +
      "For private repositories, send github_token as a multipart form field " +
      "(e.g. curl -F github_url=... -F github_token=...); JSON bodies do not populate Form().",
  );
}

// Discover entry point for a GitHub URL. Downloads the repo archive, validates
// that it is a zip, scans it, stages the bytes, and returns the same
// ``[archiveKey, candidates, total]`` tuple as :func:`runDiscoverZip` so the
// HTTP route can handle both sources uniformly. Parity with Python
// ``run_discover`` (github branch).
export async function runDiscoverGithub(
  githubUrl: string,
  githubToken: string | null | undefined,
  metaBase: JsonObject,
): Promise<[string, JsonObject[], number]> {
  const [data] = await downloadGithubZip(githubUrl, githubToken || null);
  try {
    new AdmZip(data);
  } catch {
    throw new BadRequestError("not a valid zip archive");
  }
  const candidates = scanZipForImport(data);
  const archiveKey = await stagePut(data, {
    ...metaBase,
    github_url: String(githubUrl || "").trim(),
    import_source: "github",
  });
  return [archiveKey, candidates, candidates.length];
}

// Annotate each discover candidate (in place) with ``will_overwrite`` and
// ``is_forbidden`` by looking up active rows in the ``tools`` table by
// ``candidate.name``. Parity with Python
// ``enrich_discover_candidates_name_flags`` in tool_import.py.
export async function enrichDiscoverCandidatesNameFlags(
  candidates: JsonObject[],
  opts: { userId: string; isAdmin: boolean },
): Promise<void> {
  const uid = (opts.userId || "").trim();
  for (const c of candidates) {
    const name = String(c.name ?? "").trim();
    if (!name) {
      c.will_overwrite = false;
      c.is_forbidden = false;
      continue;
    }
    const rows = await MarketplaceDb.toolsActiveByName(name);
    if (!rows.length) {
      c.will_overwrite = false;
      c.is_forbidden = false;
      continue;
    }
    c.will_overwrite = true;
    // Prefer the newest row when a tool name has multiple active versions.
    // Parity with Python ``max(rows, key=lambda r: int(r.get("id") or 0))``.
    let top = rows[0]!;
    for (const r of rows) {
      if (Number(r.id ?? 0) > Number(top.id ?? 0)) top = r;
    }
    const owner = String(top.owner_user_id ?? "").trim();
    if (owner === uid || opts.isAdmin) {
      c.is_forbidden = false;
    } else {
      c.is_forbidden = true;
    }
  }
}
