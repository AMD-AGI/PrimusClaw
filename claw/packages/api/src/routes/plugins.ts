// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authErrorPayload, getUser } from "../auth/middleware.js";
import { isAdmin } from "../auth/models.js";
import { MarketplaceDb, type JsonObject } from "../infra/db.js";
import {
  AccessDeniedError,
  BadGatewayError,
  BadRequestError,
  ConflictError,
  UpsertConflictError,
  NotConfiguredError,
  NotFoundError,
  PluginDuplicateError,
  ResourceDuplicateError,
  ServiceError,
  ToolDuplicateError,
  ToolVersionDuplicateError,
  UpsertPermissionError,
  UpsertToolTypeChangeError,
} from "../shared/errors.js";
import {
  commitImportSelections,
  enrichDiscoverCandidatesNameFlags,
  createMcpTool,
  createPromptTool,
  createSkillOrRuleTool,
  createPluginNewVersion,
  createToolNewVersion,
  formatPluginRow,
  formatResourceRow,
  canViewPlugin,
  ownerOrAdmin,
  deleteToolForUser,
  downloadToolForUser,
  getToolContentText,
  getToolForUser,
  listToolsFormatted,
  runDiscoverGithub,
  runDiscoverZip,
  runToolsNotConfigured,
  searchToolsFormatted,
  updateToolForUser,
  uploadIconBytes,
  upsertPlugin,
  upsertTool,
} from "../marketplace/plugins.js";

const T_MAX = 10 * 1024 * 1024;
const ICON_MAX = 2 * 1024 * 1024;

function mapServiceError(reply: FastifyReply, e: unknown): ReturnType<FastifyReply["send"]> | null {
  if (e instanceof NotFoundError) return reply.status(404).send(authErrorPayload("not_found", e.message));
  if (e instanceof AccessDeniedError) return reply.status(403).send(authErrorPayload("access_denied", e.message));
  if (e instanceof NotConfiguredError) return reply.status(503).send(authErrorPayload("not_configured", e.message));
  if (e instanceof ConflictError) return reply.status(409).send(authErrorPayload("conflict", e.message));
  if (e instanceof BadRequestError) return reply.status(400).send(authErrorPayload("bad_request", e.message));
  if (e instanceof BadGatewayError) return reply.status(502).send(authErrorPayload("bad_gateway", e.message));
  if (e instanceof UpsertPermissionError) return reply.status(403).send(authErrorPayload("forbidden", e.message));
  if (e instanceof UpsertConflictError) return reply.status(409).send(authErrorPayload("conflict", e.message));
  if (e instanceof UpsertToolTypeChangeError) {
    return reply.status(400).send(authErrorPayload("bad_request", e.message));
  }
  if (
    e instanceof ToolDuplicateError ||
    e instanceof ToolVersionDuplicateError ||
    e instanceof PluginDuplicateError ||
    e instanceof ResourceDuplicateError
  ) {
    return reply.status(409).send(authErrorPayload("conflict", e.message));
  }
  if (e instanceof ServiceError) return reply.status(400).send(authErrorPayload("bad_request", e.message));
  return null;
}

function parseTagsCsv(tags: string): string[] {
  if (!(tags || "").trim()) return [];
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  // Multipart is registered globally in index.ts with a 1 GiB per-file cap.
  // Do NOT re-register here — Fastify decorators live in a global namespace
  // and the second register throws FST_ERR_DEC_ALREADY_PRESENT on boot.

  // --- /v1/tools -----------------------------------------------------------------

  app.get("/v1/tools/health", async () => ({ ok: true, data: { status: "healthy" } }));

  app.get("/v1/tools/me", async (req) => {
    const u = getUser(req)!;
    return {
      ok: true,
      data: { user_id: u.userId, username: u.userName || "", is_admin: isAdmin(u) },
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/tools/search", async (req, reply) => {
    const u = getUser(req)!;
    const q = String(req.query.q ?? "");
    if (!q.trim()) return reply.status(400).send(authErrorPayload("bad_request", "q required"));
    const toolType = String(req.query.type ?? "");
    const mode = String(req.query.mode ?? "keyword");
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    try {
      const { tools, total, mode: used } = await searchToolsFormatted(
        q,
        toolType,
        limit,
        offset,
        u.userId,
        isAdmin(u),
      );
      return { ok: true, data: { tools, total, mode: mode === "keyword" ? used : used } };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.post("/v1/tools/mcp", async (req, reply) => {
    const u = getUser(req)!;
    const body = req.body as JsonObject;
    try {
      const row = await createMcpTool(body, u.userId, u.userName || "");
      return reply.status(201).send({ ok: true, data: row });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  // Prompt tool: JSON body, the prompt body lives in `config` (any JSON).
  // No multipart, no S3 — caller posts metadata + arbitrary `config` payload.
  app.post("/v1/tools/prompt", async (req, reply) => {
    const u = getUser(req)!;
    const body = req.body as JsonObject;
    try {
      const row = await createPromptTool(body, u.userId, u.userName || "");
      return reply.status(201).send({ ok: true, data: row });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.post("/v1/tools/upsert", async (req, reply) => {
    const u = getUser(req)!;
    const body = req.body as JsonObject;
    try {
      const [row, action] = await upsertTool(body, u.userId, isAdmin(u));
      const code = action === "updated" ? 200 : 201;
      return reply.status(code).send({ ok: true, data: { ...row, upsert_action: action } });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  // Unified single-file upload: kind (skill|rule) is detected from the
  // upload filename (case-insensitive). ``skill`` and ``rule`` are mutually
  // exclusive; ambiguous or missing markers fail with 400.
  app.post("/v1/tools/upload", async (req, reply) => {
    const u = getUser(req)!;
    let raw: Buffer | null = null;
    let uploadFilename = "";
    const fld: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === "file") {
        uploadFilename = String((part as { filename?: string }).filename ?? "");
        raw = await part.toBuffer();
      } else if (part.fieldname) {
        fld[part.fieldname] = String((part as { value?: unknown }).value ?? "");
      }
    }
    if (!raw) return reply.status(400).send(authErrorPayload("bad_request", "file required"));
    if (raw.length > T_MAX) return reply.status(400).send(authErrorPayload("bad_request", "file exceeds size limit"));
    const lcFilename = uploadFilename.toLowerCase();
    const hasSkill = lcFilename.includes("skill");
    const hasRule = lcFilename.includes("rule");
    if (hasSkill && hasRule) {
      return reply
        .status(400)
        .send(authErrorPayload("bad_request", "filename ambiguous: contains both 'skill' and 'rule'"));
    }
    if (!hasSkill && !hasRule) {
      return reply
        .status(400)
        .send(authErrorPayload("bad_request", "filename must contain 'skill' or 'rule'"));
    }
    const kind: "skill" | "rule" = hasSkill ? "skill" : "rule";
    const name = String(fld.name ?? "");
    const displayName = String(fld.display_name ?? "");
    const description = String(fld.description ?? "");
    const tags = parseTagsCsv(String(fld.tags ?? ""));
    const version = String(fld.version ?? "");
    const iconUrl = String(fld.icon_url ?? "");
    const isPublic = String(fld.is_public ?? "true") !== "false";
    const text = raw.toString("utf-8");
    try {
      const row = await createSkillOrRuleTool(
        {
          name,
          display_name: displayName,
          description,
          tags,
          version,
          icon_url: iconUrl || null,
          is_public: isPublic,
          content: text,
        },
        u.userId,
        u.userName || "",
        kind,
        isAdmin(u),
      );
      const action = String(row.upsert_action ?? "created");
      const code = action === "updated" ? 200 : 201;
      return reply.status(code).send({ ok: true, data: row });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/tools", async (req) => {
    const u = getUser(req)!;
    const sort = req.query.sort === "updated_at" ? "updated_at" : "created_at";
    const order = req.query.order === "asc" ? "asc" : "desc";
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const includeDeleted = req.query.include_deleted === "true" && isAdmin(u);
    const latestPerName = req.query.latest_per_name === "true";
    return listToolsFormatted({
      toolType: String(req.query.type ?? ""),
      status: String(req.query.status ?? ""),
      owner: String(req.query.owner ?? ""),
      tag: String(req.query.tag ?? ""),
      sortField: sort,
      sortOrder: order,
      offset,
      limit,
      userId: u.userId,
      isAdmin: isAdmin(u),
      includeDeleted,
      nameExact: String(req.query.name_exact ?? "") || undefined,
      latestPerName,
    }).then((r) => ({ ok: true, data: r }));
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/tools/mcp", async (req) => {
    const u = getUser(req)!;
    const sort = req.query.sort === "updated_at" ? "updated_at" : "created_at";
    const order = req.query.order === "asc" ? "asc" : "desc";
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const includeDeleted = req.query.include_deleted === "true" && isAdmin(u);
    const latestPerName = req.query.latest_per_name === "true";
    return listToolsFormatted({
      toolType: "mcp",
      status: String(req.query.status ?? ""),
      owner: String(req.query.owner ?? ""),
      tag: String(req.query.tag ?? ""),
      sortField: sort,
      sortOrder: order,
      offset,
      limit,
      userId: u.userId,
      isAdmin: isAdmin(u),
      includeDeleted,
      nameExact: String(req.query.name_exact ?? "") || undefined,
      latestPerName,
    }).then((r) => ({ ok: true, data: r }));
  });

  app.get<{ Params: { toolId: string } }>("/v1/tools/:toolId/download", async (req, reply) => {
    const u = getUser(req)!;
    const toolId = Number(req.params.toolId);
    if (!Number.isFinite(toolId)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    try {
      const { data, filename, contentType } = await downloadToolForUser(toolId, u.userId, isAdmin(u));
      return reply
        .header("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`)
        .type(contentType)
        .send(data);
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.get<{ Params: { toolId: string } }>("/v1/tools/:toolId/content", async (req, reply) => {
    const u = getUser(req)!;
    const toolId = Number(req.params.toolId);
    if (!Number.isFinite(toolId)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    try {
      const text = await getToolContentText(toolId, u.userId, isAdmin(u));
      return reply.type("text/markdown; charset=utf-8").send(text);
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.get<{ Params: { toolId: string } }>("/v1/tools/:toolId", async (req, reply) => {
    const u = getUser(req)!;
    const toolId = Number(req.params.toolId);
    if (!Number.isFinite(toolId)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    try {
      const row = await getToolForUser(toolId, u.userId, isAdmin(u));
      return { ok: true, data: row };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  const putOrPatchTool = async (
    req: FastifyRequest<{ Params: { toolId: string }; Body?: JsonObject }>,
    reply: FastifyReply,
  ) => {
    const u = getUser(req)!;
    const toolId = Number(req.params.toolId);
    if (!Number.isFinite(toolId)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    const body = req.body as JsonObject;
    const fieldsSet = new Set(Object.keys(body ?? {}));
    try {
      const row = await updateToolForUser(toolId, body, u.userId, isAdmin(u), fieldsSet, (u.userName || "").trim() || null);
      return { ok: true, data: row };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  };

  app.put<{ Params: { toolId: string } }>("/v1/tools/:toolId", putOrPatchTool);
  app.patch<{ Params: { toolId: string } }>("/v1/tools/:toolId", putOrPatchTool);

  app.post<{ Params: { toolId: string } }>("/v1/tools/:toolId/new-version", async (req, reply) => {
    const u = getUser(req)!;
    const toolId = Number(req.params.toolId);
    if (!Number.isFinite(toolId)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    const body = req.body as JsonObject;
    const ver = String(body.version ?? "").trim();
    const name = String(body.name ?? "").trim();
    if (!ver) return reply.status(400).send(authErrorPayload("bad_request", "version must not be empty"));
    if (!name) return reply.status(400).send(authErrorPayload("bad_request", "name must not be empty"));
    try {
      await getToolForUser(toolId, u.userId, isAdmin(u));
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
    const overrides: JsonObject = { ...body };
    delete overrides.version;
    delete overrides.name;
    overrides.owner_user_id = u.userId;
    overrides.author = (u.userName || "").trim() || null;
    try {
      const row = await createToolNewVersion(toolId, ver, name, Object.keys(overrides).length ? overrides : null);
      if (!row) return reply.status(404).send(authErrorPayload("not_found", "tool not found"));
      return { ok: true, data: row };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.delete<{ Params: { toolId: string } }>("/v1/tools/:toolId", async (req, reply) => {
    const u = getUser(req)!;
    const toolId = Number(req.params.toolId);
    if (!Number.isFinite(toolId)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    try {
      await deleteToolForUser(toolId, u.userId, isAdmin(u));
      return { ok: true, data: { message: "tool deleted successfully" } };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.post("/v1/tools/run", async (_req, reply) => {
    try {
      runToolsNotConfigured();
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.post("/v1/tools/icon", async (req, reply) => {
    const u = getUser(req)!;
    const allowed = new Set(["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"]);
    let mp: { toBuffer: () => Promise<Buffer>; mimetype?: string; filename?: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        mp = part;
        break;
      }
    }
    if (!mp) return reply.status(400).send(authErrorPayload("bad_request", "file required"));
    const ct = mp.mimetype || "application/octet-stream";
    if (!allowed.has(ct)) return reply.status(400).send(authErrorPayload("invalid_file_type", "Only png/jpg/svg/webp allowed"));
    const raw = await mp.toBuffer();
    if (raw.length > ICON_MAX) return reply.status(400).send(authErrorPayload("file_too_large", "File size exceeds 2MB limit"));
    try {
      const url = await uploadIconBytes(u.userId, mp.filename || "icon.png", raw, ct);
      return { ok: true, data: { icon_url: url } };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.post<{ Querystring: { offset?: string; limit?: string } }>("/v1/tools/import/discover", async (req, reply) => {
    const u = getUser(req)!;
    let fileBuf: Buffer | null = null;
    let filename = "";
    let githubUrl = "";
    let githubToken = "";
    for await (const part of req.parts()) {
      if (part.type === "file") {
        fileBuf = await part.toBuffer();
        filename = part.filename || "";
      } else if ("fieldname" in part && part.fieldname === "github_url") {
        githubUrl = String((part as { value?: string }).value ?? "");
      } else if ("fieldname" in part && part.fieldname === "github_token") {
        githubToken = String((part as { value?: string }).value ?? "");
      }
    }
    const gu = githubUrl.trim();
    if (gu && fileBuf) return reply.status(400).send(authErrorPayload("bad_request", "provide either file or github_url, not both"));
    if (!gu && !fileBuf) return reply.status(400).send(authErrorPayload("bad_request", "either file or github_url is required"));
    // Pagination over the discovered candidate list; bounds match Python tools_api.
    const rawOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
    const rawLimit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 100;
    let archiveKey = "";
    let candidates: JsonObject[] = [];
    let total = 0;
    try {
      if (fileBuf) {
        const fn = filename.trim().toLowerCase();
        if (!fn.endsWith(".zip")) {
          return reply.status(400).send(
            authErrorPayload(
              "bad_request",
              "file upload must be a .zip archive (use github_url for repository imports)",
            ),
          );
        }
        [archiveKey, candidates, total] = await runDiscoverZip(fileBuf, { filename });
      } else {
        [archiveKey, candidates, total] = await runDiscoverGithub(
          gu,
          githubToken.trim() || null,
          { github_url: gu },
        );
      }
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
    const page = candidates.slice(offset, offset + limit);
    await enrichDiscoverCandidatesNameFlags(page, {
      userId: u.userId || "",
      isAdmin: isAdmin(u),
    });
    return { ok: true, data: { archive_key: archiveKey, candidates: page, total } };
  });

  app.post("/v1/tools/import/commit", async (req, reply) => {
    const u = getUser(req)!;
    const body = req.body as { archive_key?: string; selections?: JsonObject[]; tags?: string[]; version?: string };
    if (!body.selections?.length) return reply.status(400).send(authErrorPayload("bad_request", "selections must not be empty"));
    const archiveKey = String(body.archive_key ?? "");
    try {
      const items = await commitImportSelections(
        archiveKey,
        body.selections,
        u.userId,
        (u.userName || "").trim() || null,
        body.tags ?? [],
        body.version ?? null,
        isAdmin(u),
      );
      return { ok: true, data: { items } };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  // --- /v1/plugins ---------------------------------------------------------------

  app.post("/v1/plugins/upsert", async (req, reply) => {
    const u = getUser(req)!;
    const body = req.body as JsonObject;
    try {
      const payload = { ...body, owner_user_id: u.userId, author: (u.userName || "").trim() || null };
      const [row, action] = await upsertPlugin(payload, u.userId, isAdmin(u));
      const code = action === "updated" ? 200 : 201;
      const data = await formatPluginRow(row, true);
      return reply.status(code).send({ ok: true, data: { ...data, upsert_action: action } });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.post("/v1/plugins", async (req, reply) => {
    const u = getUser(req)!;
    const body = req.body as JsonObject;
    try {
      const row = await MarketplaceDb.pluginInsert({
        ...body,
        owner_user_id: u.userId,
        author: (u.userName || "").trim() || null,
      });
      return reply.status(201).send({ ok: true, data: await formatPluginRow(row, true) });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/plugins", async (req) => {
    const u = getUser(req)!;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const includeDeleted = req.query.include_deleted === "true" && isAdmin(u);
    const latestPerName = req.query.latest_per_name === "true";
    const nameExact = String(req.query.name_exact ?? "").trim();
    const nameFuzzy = String(req.query.name ?? "").trim();
    const { rows, total } = await MarketplaceDb.listPluginsRepo({
      status: String(req.query.status ?? "") || undefined,
      owner: String(req.query.owner ?? "") || undefined,
      viewerUserId: u.userId,
      isAdmin: isAdmin(u),
      includeDeleted,
      nameExact: nameExact || undefined,
      nameContains: nameExact ? undefined : nameFuzzy || undefined,
      latestPerName,
      sortField: "updated_at",
      sortOrder: "desc",
      offset,
      limit,
    });
    return {
      ok: true,
      data: {
        plugins: await Promise.all(rows.map((r) => formatPluginRow(r, true))),
        total,
        offset,
        limit,
      },
    };
  });

  app.get<{ Params: { pluginId: string } }>("/v1/plugins/:pluginId", async (req, reply) => {
    const u = getUser(req)!;
    const id = Number(req.params.pluginId);
    if (!Number.isFinite(id)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    const row = await MarketplaceDb.pluginGetById(id, false);
    if (!row) return reply.status(404).send(authErrorPayload("not_found", "plugin not found"));
    if (!canViewPlugin(row, u.userId, isAdmin(u))) {
      return reply.status(403).send(authErrorPayload("access_denied", "cannot view plugin"));
    }
    return { ok: true, data: await formatPluginRow(row, true) };
  });

  const patchPlugin = async (
    req: FastifyRequest<{ Params: { pluginId: string }; Body?: JsonObject }>,
    reply: FastifyReply,
  ) => {
    const u = getUser(req)!;
    const id = Number(req.params.pluginId);
    if (!Number.isFinite(id)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    const existing = await MarketplaceDb.pluginGetById(id, false);
    if (!existing) return reply.status(404).send(authErrorPayload("not_found", "plugin not found"));
    if (!ownerOrAdmin(existing, u.userId, isAdmin(u))) {
      return reply.status(403).send(authErrorPayload("forbidden", "not allowed to modify this plugin"));
    }
    const raw = { ...(req.body as JsonObject) };
    delete raw.owner_user_id;
    raw.author = (u.userName || "").trim() || null;
    try {
      const out = await MarketplaceDb.pluginUpdate(id, raw);
      if (!out) return reply.status(404).send(authErrorPayload("not_found", "plugin not found"));
      return { ok: true, data: await formatPluginRow(out, true) };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  };

  app.put<{ Params: { pluginId: string } }>("/v1/plugins/:pluginId", patchPlugin);
  app.patch<{ Params: { pluginId: string } }>("/v1/plugins/:pluginId", patchPlugin);

  app.post<{ Params: { pluginId: string } }>("/v1/plugins/:pluginId/new-version", async (req, reply) => {
    const u = getUser(req)!;
    const id = Number(req.params.pluginId);
    if (!Number.isFinite(id)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    const existing = await MarketplaceDb.pluginGetById(id, false);
    if (!existing) return reply.status(404).send(authErrorPayload("not_found", "plugin not found"));
    if (!ownerOrAdmin(existing, u.userId, isAdmin(u))) {
      return reply.status(403).send(authErrorPayload("access_denied", "cannot create new version for this plugin"));
    }
    const body = req.body as JsonObject;
    const ver = String(body.version ?? "").trim();
    const name = String(body.name ?? "").trim();
    if (!ver) return reply.status(400).send(authErrorPayload("bad_request", "version must not be empty"));
    if (!name) return reply.status(400).send(authErrorPayload("bad_request", "name must not be empty"));
    const overrides = { ...body };
    delete overrides.version;
    delete overrides.name;
    overrides.owner_user_id = u.userId;
    overrides.author = (u.userName || "").trim() || null;
    try {
      const row = await createPluginNewVersion(id, ver, name, Object.keys(overrides).length ? overrides : null);
      if (!row) return reply.status(404).send(authErrorPayload("not_found", "plugin not found"));
      return reply.status(201).send({ ok: true, data: await formatPluginRow(row, true) });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.delete<{ Params: { pluginId: string } }>("/v1/plugins/:pluginId", async (req, reply) => {
    const u = getUser(req)!;
    const id = Number(req.params.pluginId);
    if (!Number.isFinite(id)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    const existing = await MarketplaceDb.pluginGetById(id, false);
    if (!existing) return reply.status(404).send(authErrorPayload("not_found", "plugin not found"));
    if (!ownerOrAdmin(existing, u.userId, isAdmin(u))) {
      return reply.status(403).send(authErrorPayload("forbidden", "not allowed to delete this plugin"));
    }
    try {
      const ok = await MarketplaceDb.pluginSoftDelete(id);
      if (!ok) return reply.status(404).send(authErrorPayload("not_found", "plugin not found"));
      const out = await MarketplaceDb.pluginGetById(id, true);
      return { ok: true, data: { message: "plugin deleted", plugin: out ? await formatPluginRow(out, true) : null } };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  // --- /v1/resources -------------------------------------------------------------

  app.post("/v1/resources", async (req, reply) => {
    const u = getUser(req)!;
    if (!isAdmin(u)) return reply.status(403).send(authErrorPayload("access_denied", "only administrators can create or modify resources"));
    const body = req.body as JsonObject;
    try {
      const row = await MarketplaceDb.resourceInsert({
        ...body,
        owner_user_id: u.userId,
        author: (u.userName || "").trim() || null,
      });
      return reply.status(201).send({ ok: true, data: formatResourceRow(row) });
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/resources", async (req) => {
    getUser(req)!;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const includeDeleted = req.query.include_deleted === "true";
    const type = String(req.query.type ?? "").trim() || undefined;
    const { rows, total } = await MarketplaceDb.listResourcesRepo({
      includeDeleted,
      type,
      // Anthropic Managed Agents compat Environment rows (type='anthropic_env',
      // see routes/anthropic-managed-agents.ts) are not real Primus resources and must
      // not leak into the native resource picker when no explicit `type` is
      // requested (design doc §9.5.2/§12).
      excludeType: type ? undefined : "anthropic_env",
      offset,
      limit,
    });
    return {
      ok: true,
      data: {
        resources: rows.map((r) => formatResourceRow(r)),
        total,
        offset,
        limit,
      },
    };
  });

  app.get<{ Params: { resourceId: string } }>("/v1/resources/:resourceId", async (req, reply) => {
    getUser(req)!;
    const id = Number(req.params.resourceId);
    if (!Number.isFinite(id)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    const row = await MarketplaceDb.resourceGetById(id, false);
    if (!row) return reply.status(404).send(authErrorPayload("not_found", "resource not found"));
    return { ok: true, data: formatResourceRow(row) };
  });

  const putOrPatchResource = async (
    req: FastifyRequest<{ Params: { resourceId: string }; Body?: JsonObject }>,
    reply: FastifyReply,
  ) => {
    const u = getUser(req)!;
    if (!isAdmin(u)) return reply.status(403).send(authErrorPayload("access_denied", "only administrators can create or modify resources"));
    const id = Number(req.params.resourceId);
    if (!Number.isFinite(id)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    // Edit is restricted to ``image`` and ``resource``. Identity fields
    // (name/type/owner/author) are immutable post-create; soft delete uses
    // the dedicated DELETE endpoint, not PATCH ``deleted_at``.
    const body = (req.body as JsonObject) ?? {};
    const patch: JsonObject = {};
    if ("image" in body) patch.image = body.image;
    if ("resource" in body) patch.resource = body.resource;
    try {
      const out = await MarketplaceDb.resourceUpdate(id, patch);
      if (!out) return reply.status(404).send(authErrorPayload("not_found", "resource not found"));
      return { ok: true, data: formatResourceRow(out) };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  };

  app.put<{ Params: { resourceId: string } }>("/v1/resources/:resourceId", putOrPatchResource);
  app.patch<{ Params: { resourceId: string } }>("/v1/resources/:resourceId", putOrPatchResource);

  app.delete<{ Params: { resourceId: string } }>("/v1/resources/:resourceId", async (req, reply) => {
    const u = getUser(req)!;
    if (!isAdmin(u)) return reply.status(403).send(authErrorPayload("access_denied", "only administrators can create or modify resources"));
    const id = Number(req.params.resourceId);
    if (!Number.isFinite(id)) return reply.status(400).send(authErrorPayload("bad_request", "invalid id"));
    try {
      const ok = await MarketplaceDb.resourceSoftDelete(id);
      if (!ok) return reply.status(404).send(authErrorPayload("not_found", "resource not found"));
      return { ok: true, data: { deleted: true } };
    } catch (e) {
      const m = mapServiceError(reply, e);
      if (m) return m;
      throw e;
    }
  });
}
