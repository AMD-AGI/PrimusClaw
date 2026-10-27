// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import pino from "pino";
import { PLATFORM_DEFAULTS_FILE, TOOLS_API_URL } from "../config.js";
import { metrics } from "../infra/metrics.js";
import { findSkillMd, stageSkillArchive } from "../tools/resolve.js";
import { uploadDirToSandbox } from "../sandbox/write.js";
import { createPrivateStagingRoot } from "../tasks/plugin-from-message.js";
import type { HandsClient } from "../clients/hands.js";
import type { EventCallback } from "@claw/protocol";

const logger = pino({ name: "platform-defaults" });

/**
 * Deployment-level defaults mounted into every chat.
 *
 * The file is supplied by the operator (e.g. a ConfigMap) and names skills by
 * marketplace tool id, so no site-specific address or id lives in this code.
 */
export interface PlatformDefaults {
  skills: Array<{ toolId: number; name?: string }>;
  mcpServers: Record<string, Record<string, unknown>>;
}

/** A default skill ready to be listed in the prompt; its body is not loaded. */
export interface DefaultSkill {
  name: string;
  description: string;
  toolId: number;
  /** Brain-local staged copy; uploaded to the sandbox only when first needed. */
  localDir: string;
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DESCRIPTION_MAX = 300;

let cache: { file: string; mtimeMs: number; value: PlatformDefaults | null } | null = null;

/**
 * Read the defaults file, re-reading when its mtime changes.
 *
 * Never throws: a missing, unreadable or malformed file means "not enabled",
 * so a broken ConfigMap cannot fail a chat. A corrupt file is logged and
 * counted, which is what distinguishes it from a deployment that never set one.
 */
export function loadPlatformDefaults(file: string = PLATFORM_DEFAULTS_FILE): PlatformDefaults | null {
  if (!file) return null;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    if (!cache || cache.file !== file || cache.value !== null || cache.mtimeMs !== -1) {
      logger.error({ file, err: (err as Error).message }, "platform_defaults.file_unreadable");
    }
    metrics.onPlatformDefault("config", "failed", "unreadable");
    cache = { file, mtimeMs: -1, value: null };
    return null;
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.value;
  let value: PlatformDefaults | null = null;
  try {
    value = parseDefaults(JSON.parse(fs.readFileSync(file, "utf-8")));
    metrics.onPlatformDefault("config", "ok", "loaded");
  } catch (err) {
    logger.error({ file, err: (err as Error).message }, "platform_defaults.file_invalid");
    metrics.onPlatformDefault("config", "failed", "invalid");
  }
  cache = { file, mtimeMs, value };
  return value;
}

export function resetPlatformDefaultsCacheForTest(): void {
  cache = null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseDefaults(raw: unknown): PlatformDefaults {
  if (!isRecord(raw)) throw new Error("top level must be an object");
  const skills: PlatformDefaults["skills"] = [];
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) throw new Error("skills must be an array");
    for (const s of raw.skills) {
      const id = isRecord(s) ? s.tool_id : undefined;
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
        throw new Error("each skill needs a positive integer tool_id");
      }
      const name = isRecord(s) && typeof s.name === "string" && s.name ? s.name : undefined;
      if (name !== undefined && !SKILL_NAME_RE.test(name)) throw new Error(`invalid skill name '${name}'`);
      skills.push({ toolId: id, name });
    }
  }
  const mcpServers: PlatformDefaults["mcpServers"] = {};
  if (raw.mcp_servers !== undefined) {
    if (!isRecord(raw.mcp_servers)) throw new Error("mcp_servers must be an object");
    for (const [k, v] of Object.entries(raw.mcp_servers)) {
      if (!isRecord(v)) throw new Error(`mcp server '${k}' must be an object`);
      mcpServers[k] = v;
    }
  }
  return { skills, mcpServers };
}

/**
 * One-line description of a SKILL.md for the prompt.
 *
 * The text comes from the marketplace and is treated as untrusted: it is only
 * ever concatenated into the list, collapsed to a single line and truncated.
 * Order: frontmatter `description`, else the first body paragraph that is not a
 * heading, else the skill name.
 */
export function skillDescription(skillMd: string, fallbackName: string): string {
  let desc = "";
  let body = skillMd.replace(/^﻿/, "");
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fm) {
    body = body.slice(fm[0].length);
    try {
      const parsed = YAML.parse(fm[1]);
      if (isRecord(parsed) && typeof parsed.description === "string") desc = parsed.description;
    } catch { /* fall through to the body */ }
  }
  if (!desc.trim()) {
    for (const para of body.split(/\r?\n\s*\r?\n/)) {
      const t = para.trim();
      if (t && !t.startsWith("#")) { desc = t; break; }
    }
  }
  desc = desc.replace(/\s+/g, " ").trim();
  if (!desc) desc = fallbackName;
  return desc.length > DESCRIPTION_MAX ? desc.slice(0, DESCRIPTION_MAX - 1) + "…" : desc;
}


/**
 * Per-process staging cache. Built with the same private-directory checks as
 * plugin staging: a predictable shared /tmp path would let a local account
 * plant the skill body that later lands in every sandbox.
 */
let cacheRootDir: string | null = null;
function cacheRoot(): string {
  if (!cacheRootDir) cacheRootDir = createPrivateStagingRoot(path.join(os.tmpdir(), "claw-platform-skills"));
  return cacheRootDir;
}
/** Without a version field on the tool record, a staged copy is trusted this long. */
const UNVERSIONED_TTL_MS = 5 * 60_000;

function versionKey(tool: Record<string, unknown>): string {
  const v = tool.updated_at ?? tool.updatedAt ?? tool.version ?? "";
  return String(v).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

/**
 * Stage one default skill under the Brain-local cache, keyed by tool id and
 * version, so concurrent chats do not each download it. Returns the staged dir.
 */
async function stageCached(toolId: number, name: string, version: string, apiKey: string): Promise<string> {
  const final = path.join(cacheRoot(), `${toolId}-${version || "unversioned"}`);
  try {
    const st = fs.statSync(final);
    if (version || Date.now() - st.mtimeMs < UNVERSIONED_TTL_MS) return final;
    fs.rmSync(final, { recursive: true, force: true });
  } catch { /* not cached */ }

  const resp = await fetch(`${TOOLS_API_URL}/${toolId}/download`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") ?? "";
  fs.mkdirSync(cacheRoot(), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(cacheRoot(), `.stage-${toolId}-`));
  try {
    stageSkillArchive(tmp, buf, contentType, toolId, name);
    if (!findSkillMd(tmp)) throw new Error("SKILL.md not found after extraction");
    try {
      fs.renameSync(tmp, final);
    } catch {
      // Another chat staged the same version first; its copy is equivalent.
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  // Older versions of this tool are dead weight now.
  try {
    for (const e of fs.readdirSync(cacheRoot())) {
      if (e.startsWith(`${toolId}-`) && path.join(cacheRoot(), e) !== final) {
        fs.rmSync(path.join(cacheRoot(), e), { recursive: true, force: true });
      }
    }
  } catch { /* best-effort */ }
  return final;
}

/**
 * Resolve the default skills for one chat: list the marketplace with the
 * caller's own key (so access control stays the marketplace's), stage each
 * permitted skill on Brain, and read its description. No sandbox is touched.
 *
 * Failures never block the chat; each is a visible event and a counted reason.
 * A tool the caller cannot see is skipped, which is why an operator must
 * publish default tools as readable by every user.
 */
export async function resolveDefaultSkills(
  defaults: PlatformDefaults,
  platformKey: string,
  onEvent?: EventCallback,
): Promise<DefaultSkill[]> {
  if (!defaults.skills.length) return [];
  const tools: Record<number, Record<string, unknown>> = {};
  try {
    const resp = await fetch(`${TOOLS_API_URL}?offset=0&limit=100&order=desc`, {
      headers: { Authorization: `Bearer ${platformKey}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: { tools?: Record<string, unknown>[] } };
    for (const t of data.data?.tools ?? []) tools[t.id as number] = t;
  } catch (err) {
    logger.error({ err: (err as Error).message }, "platform_defaults.list_failed");
    for (const _s of defaults.skills) metrics.onPlatformDefault("skill", "failed", "list");
    await onEvent?.({ type: "toolUsed", tool: "platform_defaults", actionId: "platform_defaults_list", status: "error", brief: "Failed to load platform default skills" });
    return [];
  }

  const out: DefaultSkill[] = [];
  const seen = new Set<string>();
  for (const entry of defaults.skills) {
    const tool = tools[entry.toolId];
    if (!tool || tool.type !== "skill") {
      logger.warn({ toolId: entry.toolId }, "platform_defaults.skill_not_visible");
      metrics.onPlatformDefault("skill", "skipped", tool ? "not_skill" : "not_visible");
      continue;
    }
    const name = entry.name ?? String(tool.name ?? `tool_${entry.toolId}`);
    if (!SKILL_NAME_RE.test(name) || seen.has(name)) {
      metrics.onPlatformDefault("skill", "skipped", seen.has(name) ? "duplicate_name" : "bad_name");
      continue;
    }
    try {
      const localDir = await stageCached(entry.toolId, name, versionKey(tool), platformKey);
      const md = findSkillMd(localDir);
      if (!md) throw new Error("SKILL.md missing");
      out.push({ name, toolId: entry.toolId, localDir, description: skillDescription(fs.readFileSync(md, "utf-8"), name) });
      seen.add(name);
      metrics.onPlatformDefault("skill", "ok", "staged");
    } catch (err) {
      logger.warn({ toolId: entry.toolId, name, err: (err as Error).message }, "platform_defaults.skill_failed");
      metrics.onPlatformDefault("skill", "failed", "download");
      await onEvent?.({ type: "toolUsed", tool: "platform_defaults", actionId: `platform_default_${entry.toolId}`, status: "error", brief: `Failed to load default skill: ${name}` });
    }
  }
  return out;
}

/**
 * Writes default skills into a sandbox the first time they are needed.
 *
 * Idempotent per sandbox: a rebuilt sandbox (different client) starts empty
 * again, so the next trigger re-writes. A failed write is reported and does
 * not throw -- the tool call that triggered it proceeds and the agent sees a
 * normal file-not-found for what is missing.
 */
export class LazyDefaultSkills {
  private written = new Set<string>();
  private lastHands: HandsClient | null = null;

  constructor(
    private skills: DefaultSkill[],
    private onEvent?: EventCallback,
    private sessionDir = "/workspace",
  ) {}

  /** Names of default skills this writer manages. */
  get names(): string[] { return this.skills.map((s) => s.name); }

  /** Write the skills `text` refers to (all pending ones if it names none). */
  async ensure(hands: HandsClient, text: string, coldSandbox = false): Promise<void> {
    if (hands !== this.lastHands) { this.written.clear(); this.lastHands = hands; }
    const pending = this.skills.filter((s) => !this.written.has(s.name));
    if (!pending.length) return;
    const named = pending.filter((s) => text.includes(s.name));
    const todo = named.length ? named : pending;
    const rel = this.sessionDir === "/workspace" ? "" : this.sessionDir.replace(/^\/workspace\/?/, "").replace(/^\/+/, "");
    for (const s of todo) {
      const t0 = Date.now();
      try {
        const base = rel ? path.posix.join(rel, ".skills", s.name) : path.posix.join(".skills", s.name);
        const up = await uploadDirToSandbox(hands, s.localDir, base);
        const shippable = up.total - up.skipped;
        if (up.failed > 0 || (shippable > 0 && up.uploaded === 0)) throw new Error("upload failed");
        this.written.add(s.name);
        metrics.onPlatformSkillLazyWrite("ok", (Date.now() - t0) / 1000, coldSandbox);
      } catch (err) {
        logger.warn({ name: s.name, err: (err as Error).message }, "platform_defaults.lazy_write_failed");
        metrics.onPlatformSkillLazyWrite("failed", (Date.now() - t0) / 1000, coldSandbox);
        metrics.onPlatformDefault("skill", "failed", "lazy_write");
        await this.onEvent?.({ type: "toolUsed", tool: "platform_defaults", actionId: `platform_default_write_${s.toolId}`, status: "error", brief: `Failed to write default skill: ${s.name}` });
      }
    }
  }
}
