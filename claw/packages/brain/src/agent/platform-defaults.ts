// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import pino from "pino";
import { PLATFORM_DEFAULTS_FILE } from "../config.js";
import { metrics } from "../infra/metrics.js";
import { downloadSkill } from "../tools/resolve.js";
import { lookupTool, type LookupFailure } from "../tools/lookup.js";
export { platformToolsBase } from "../tools/lookup.js";
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
  /**
   * Brain-local directory that directly contains SKILL.md (the archive's own
   * root, even if it was wrapped in a folder); uploaded as `.skills/<name>/`
   * only when first needed.
   */
  localDir: string;
  /** Stage again when `localDir` is gone (e.g. the Brain restarted its cache). */
  restage?: () => Promise<string>;
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const DESCRIPTION_MAX = 300;
export const MAX_DEFAULT_SKILLS = 50;

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
  let text: string;
  try {
    // One descriptor for both the mtime and the bytes, so the cache key always
    // describes the content that was read.
    const fd = fs.openSync(file, "r");
    try {
      mtimeMs = fs.fstatSync(fd).mtimeMs;
      if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.value;
      text = fs.readFileSync(fd, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (!cache || cache.file !== file || cache.mtimeMs !== -1) {
      logger.error({ file, err: (err as Error).message }, "platform_defaults.file_unreadable");
    }
    metrics.onPlatformDefault("config", "failed", "unreadable");
    cache = { file, mtimeMs: -1, value: null };
    return null;
  }
  let value: PlatformDefaults | null = null;
  try {
    value = parseDefaults(JSON.parse(text));
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
    if (raw.skills.length > MAX_DEFAULT_SKILLS) throw new Error(`at most ${MAX_DEFAULT_SKILLS} default skills are supported`);
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
/**
 * A staged directory is never deleted while a chat may still hold it: it is
 * only garbage-collected once older than this, which must exceed the longest
 * chat (the lazy upload can happen long after the prompt was built).
 */
const STAGE_GC_AGE_MS = 24 * 3_600_000;
/** Mutable only so a test can shorten them. */
export const timeouts = { lookupMs: 10_000, stageMs: 60_000 };

function versionKey(tool: Record<string, unknown>): string {
  const v = tool.updated_at ?? tool.updatedAt ?? tool.version ?? "";
  return String(v).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

/** key -> staged dir. The index, not the filesystem, answers "is it cached". */
const stagedIndex = new Map<string, { dir: string; at: number }>();
const stagedAll: Array<{ dir: string; at: number }> = [];

export function resetStagedIndexForTest(): void {
  stagedIndex.clear();
  stagedAll.length = 0;
}

/**
 * Locate the directory that holds SKILL.md: the archive root if it has one,
 * else the shallowest directory that does (a `zip -r skill.zip skill/` archive
 * wraps everything in a top-level folder). Breadth-first so a SKILL.md deep in
 * references/ can never win over the real one.
 */
export function locateSkillRoot(dir: string): string | null {
  let level = [dir];
  while (level.length) {
    const next: string[] = [];
    for (const d of level) {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) return d;
      for (const e of entries) if (e.isDirectory()) next.push(path.join(d, e.name));
    }
    level = next;
  }
  return null;
}

/** Delete staged dirs older than the GC age. Never touches a younger one. */
function gcStaged(now = Date.now()): void {
  for (let i = stagedAll.length - 1; i >= 0; i--) {
    const e = stagedAll[i];
    if (now - e.at > STAGE_GC_AGE_MS) {
      fs.rmSync(e.dir, { recursive: true, force: true });
      stagedAll.splice(i, 1);
      for (const [k, v] of stagedIndex) if (v.dir === e.dir) stagedIndex.delete(k);
    }
  }
}

/** Test hook: GC as if `now` were this time. */
export function gcStagedForTest(now: number): void { gcStaged(now); }

/**
 * Stage one default skill under the Brain-local cache, keyed by tool id and
 * version, so concurrent chats do not each download it. Every stage gets its
 * own fresh directory and a published version is never replaced in place, so a
 * chat that was handed a directory keeps a valid one. Returns the SKILL.md root.
 */
async function stageCached(toolId: number, name: string, version: string, apiKey: string): Promise<string> {
  const key = `${toolId}:${version}`;
  const hit = stagedIndex.get(key);
  if (hit && (version || Date.now() - hit.at < UNVERSIONED_TTL_MS)) {
    // The directory can vanish under the index (a tmp cleaner, an operator).
    // That is a cache miss, not an error: drop the entry and stage again.
    let root: string | null = null;
    try { root = locateSkillRoot(hit.dir); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (root) return root;
    stagedIndex.delete(key);
    const i = stagedAll.indexOf(hit);
    if (i >= 0) stagedAll.splice(i, 1);
  }
  gcStaged();
  fs.mkdirSync(cacheRoot(), { recursive: true });
  const dir = fs.mkdtempSync(path.join(cacheRoot(), `${toolId}-`));
  try {
    // Same download + zip-slip-guarded extraction as a tool_ids skill, staged
    // here instead of being uploaded to a sandbox.
    await withTimeout(downloadSkill(toolId, name, apiKey, undefined, undefined, dir), timeouts.stageMs, "download");
    if (!locateSkillRoot(dir)) throw new Error("SKILL.md not found after extraction");
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const entry = { dir, at: Date.now() };
  stagedIndex.set(key, entry);
  stagedAll.push(entry);
  return locateSkillRoot(dir) as string;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const LOOKUP_BRIEF: Record<LookupFailure, string> = {
  not_found: "not found",
  forbidden: "not readable by this user",
  endpoint_unreachable: "lookup endpoint unreachable (check the Tools API base URL)",
  lookup: "lookup failed",
};

/**
 * Resolve the default skills for one chat: look each configured tool up by id
 * with the caller's own key (so access control stays the marketplace's, and
 * the result does not depend on how many other tools the caller can see),
 * stage each permitted skill on Brain, and read its description. No sandbox is
 * touched.
 *
 * Failures never block the chat, but none is silent: an unresolvable default is
 * logged at error level, counted by reason, and raised as an error event. A
 * tool the caller cannot see is skipped, which is why an operator must publish
 * default tools as readable by every user.
 */
export async function resolveDefaultSkills(
  defaults: PlatformDefaults,
  platformKey: string,
  onEvent?: EventCallback,
): Promise<DefaultSkill[]> {
  if (!defaults.skills.length) return [];
  const looked = await Promise.all(defaults.skills.map((e) => lookupTool(e.toolId, platformKey, timeouts.lookupMs)));
  // Stage in parallel: the chat waits for the slowest one, bounded by the
  // per-stage deadline, not for the sum.
  const staged = await Promise.all(defaults.skills.map(async (entry, i): Promise<DefaultSkill | null> => {
    const found = looked[i];
    const fail = async (outcome: "failed" | "skipped", reason: string, brief: string) => {
      logger.error({ toolId: entry.toolId, reason }, "platform_defaults.skill_unresolved");
      metrics.onPlatformDefault("skill", outcome, reason);
      await onEvent?.({ type: "toolUsed", tool: "platform_defaults", actionId: `platform_default_${entry.toolId}`, status: "error", brief });
      return null;
    };
    if (!found.ok) {
      const infra = found.reason === "endpoint_unreachable" || found.reason === "lookup";
      return fail(infra ? "failed" : "skipped", found.reason, `Default skill ${entry.toolId} is unavailable (${LOOKUP_BRIEF[found.reason]})`);
    }
    const tool = found.tool;
    if (tool.type !== "skill") return fail("skipped", "not_skill", `Default tool ${entry.toolId} is not a skill`);
    const name = entry.name ?? String(tool.name ?? `tool_${entry.toolId}`);
    if (!SKILL_NAME_RE.test(name)) return fail("skipped", "bad_name", `Default skill ${entry.toolId} has an unusable name`);
    const toolId = entry.toolId;
    const version = versionKey(tool);
    try {
      const localDir = await stageCached(toolId, name, version, platformKey);
      const md = path.join(localDir, "SKILL.md");
      const skill: DefaultSkill = {
        name, toolId, localDir,
        description: skillDescription(fs.readFileSync(md, "utf-8"), name),
        restage: () => stageCached(toolId, name, version, platformKey),
      };
      metrics.onPlatformDefault("skill", "ok", "staged");
      return skill;
    } catch (err) {
      logger.warn({ toolId, name, err: (err as Error).message }, "platform_defaults.skill_failed");
      return fail("failed", "download", `Failed to load default skill: ${name}`);
    }
  }));
  const out: DefaultSkill[] = [];
  const seen = new Set<string>();
  for (const sk of staged) {
    if (!sk) continue;
    if (seen.has(sk.name)) {
      logger.error({ toolId: sk.toolId, name: sk.name }, "platform_defaults.skill_unresolved");
      metrics.onPlatformDefault("skill", "skipped", "duplicate_name");
      await onEvent?.({ type: "toolUsed", tool: "platform_defaults", actionId: `platform_default_${sk.toolId}`, status: "error", brief: `Default skill ${sk.toolId} duplicates the name ${sk.name}` });
      continue;
    }
    seen.add(sk.name);
    out.push(sk);
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

  /**
   * Write the skills `text` refers to (all pending ones if it names none).
   * A call that names only skills already written has nothing to write: with a
   * dozen plugin skills behind one writer, re-reading a file of a skill that is
   * on disk must not upload the other eleven.
   */
  async ensure(hands: HandsClient, text: string, coldSandbox = false): Promise<void> {
    if (hands !== this.lastHands) { this.written.clear(); this.lastHands = hands; }
    const pending = this.skills.filter((s) => !this.written.has(s.name));
    if (!pending.length) return;
    const named = pending.filter((s) => text.includes(s.name));
    const namesAWrittenSkill = this.skills.some((s) => this.written.has(s.name) && text.includes(s.name));
    const todo = named.length ? named : namesAWrittenSkill ? [] : pending;
    const rel = this.sessionDir === "/workspace" ? "" : this.sessionDir.replace(/^\/workspace\/?/, "").replace(/^\/+/, "");
    for (const s of todo) {
      const t0 = Date.now();
      try {
        const base = rel ? path.posix.join(rel, ".skills", s.name) : path.posix.join(".skills", s.name);
        const attempt = async () => {
          const up = await uploadDirToSandbox(hands, s.localDir, base);
          const shippable = up.total - up.skipped;
          if (up.failed > 0 || (shippable > 0 && up.uploaded === 0) || up.total === 0) throw new Error("upload failed");
        };
        try {
          await attempt();
        } catch (first) {
          // The staged copy may be gone; stage again rather than leave the
          // agent with a skill the prompt promised.
          if (!s.restage) throw first;
          s.localDir = await s.restage();
          await attempt();
        }
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
