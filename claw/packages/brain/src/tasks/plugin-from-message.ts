// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Plugin resolution from the NATS task payload only (parity with the original
 * executor's prepareExecution).
 * No DB or HTTP plugin API — API must send `plugin_tools` on ExecuteRequest.
 */

import fs from "node:fs";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pino from "pino";
import type { ExecuteRequest, EventCallback } from "@claw/protocol";
import {
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  S3_API_ENDPOINT,
  S3_REGION,
  S3_PLUGINS_BUCKET,
  S3_FORCE_PATH_STYLE,
} from "../config.js";
import { isSafeRelativePath } from "../sandbox/write.js";
import type { HandsClient } from "../clients/hands.js";
import {
  type HookRegistry,
  buildRegistryFromHooksField,
  mergeHookRegistries,
  registryHasAny,
} from "../agent/hooks.js";

const logger = pino({ name: "plugin-from-message" });

const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

interface PluginToolRow {
  id: number;
  type?: string;
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
}

let _s3: S3Client | null = null;

function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: S3_API_ENDPOINT || undefined,
      region: S3_REGION,
      forcePathStyle: S3_FORCE_PATH_STYLE,
      credentials:
        S3_ACCESS_KEY && S3_SECRET_KEY
          ? { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY }
          : undefined,
    });
  }
  return _s3;
}

async function downloadS3File(key: string, localPath: string, bucket: string): Promise<void> {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const data = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await data.Body!.transformToByteArray();
  fs.writeFileSync(localPath, bytes);
}

async function syncS3PrefixToLocal(prefix: string, localDir: string, bucket: string): Promise<void> {
  const resp = await getS3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  for (const obj of resp.Contents ?? []) {
    const key = obj.Key!;
    const rel = key.slice(prefix.length).replaceAll("\\", "/");
    if (!rel || rel === ".keep") continue;
    if (!isSafeRelativePath(rel)) {
      logger.warn({ key, rel }, "plugin.s3_unsafe_key_skipped");
      continue;
    }
    const localPath = path.join(localDir, rel);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const data = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await data.Body!.transformToByteArray();
    fs.writeFileSync(localPath, bytes);
  }
}

function skillNameFromS3Key(key: string, fallback: string): string {
  const parts = key.split("/").filter(Boolean);
  const candidate = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (candidate && SAFE_SKILL_NAME.test(candidate)) return candidate;
  if (SAFE_SKILL_NAME.test(fallback)) return fallback;
  return `tool_${fallback}`;
}

function findSkillMd(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "SKILL.md") return full;
    }
  }
  return null;
}

async function downloadPluginSkill(
  cfg: Record<string, unknown>,
  s3Key: string,
  skillDir: string,
): Promise<void> {
  fs.mkdirSync(skillDir, { recursive: true });
  const isPrefix = cfg.is_prefix === true || s3Key.endsWith("/");
  const bucket = S3_PLUGINS_BUCKET;
  if (isPrefix) {
    const prefix = s3Key.endsWith("/") ? s3Key : `${s3Key}/`;
    await syncS3PrefixToLocal(prefix, skillDir, bucket);
  } else {
    const outPath = path.join(skillDir, path.basename(s3Key));
    await downloadS3File(s3Key, outPath, bucket);
  }
}

/**
 * When `plugin_id` is set, marketplace `tool_ids` are not resolved (executor-ts base.prepareExecution).
 */
export function marketplaceToolIds(request: ExecuteRequest): number[] {
  const pid = request.plugin_id;
  if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
    if ((request.tool_ids?.length ?? 0) > 0) {
      logger.info(
        { pluginId: pid, ignoredToolIds: request.tool_ids },
        "plugin.skips_marketplace_tool_ids",
      );
    }
    return [];
  }
  return request.tool_ids?.length ? request.tool_ids : [];
}

export interface PluginFromMessageResult {
  mcpServers: Record<string, Record<string, unknown>>;
  /** Inlined into the user prompt via ``buildPrompt`` (SKILL blocks). */
  skillContents: Record<string, string>;
  /** Local directory path for each skill (to be tar'd and sent to sandbox). */
  skillDirs: Record<string, string>;
  /** Concatenated rule bodies; engines pass this into ``buildPrompt`` (user turn), not system. */
  rulesContent: string;
  /** Merged hook registry across all `hooks` plugin_tools; empty when none. */
  hooks: HookRegistry;
}

/** Sandbox root where hook scripts are staged, per-plugin-tool-id. */
const SANDBOX_HOOKS_ROOT = "/workspace/.claw/hooks";

/**
 * Rewrite plugin-relative hook command paths to absolute sandbox paths.
 * Matches `<prefix>/hooks/<rest>` tokens (e.g. `.cursor/hooks/validate.sh`,
 * `hooks/on_stop.py`) and replaces them with `${sandboxDir}/<rest>`.
 */
function makeHookPathRewriter(sandboxDir: string): (cmd: string) => string {
  return (cmd) => cmd.replace(/(?:[^\s"']+\/)?hooks\/([^\s"']+)/g, `${sandboxDir}/$1`);
}

/**
 * Upload every regular file under `localDir` into the sandbox at `sandboxDir`,
 * preserving subpaths. Binary files are skipped; scripts are chmod +x after
 * upload so `bash <script>` / direct invocation both work.
 */
async function uploadHooksDirToSandbox(
  hands: HandsClient,
  localDir: string,
  sandboxDir: string,
): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  };
  const files = fs.existsSync(localDir) ? walk(localDir) : [];
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const absPath of files) {
    const rel = path.relative(localDir, absPath).split(path.sep).join("/");
    const targetPath = path.posix.join(sandboxDir, rel);
    const raw = fs.readFileSync(absPath);
    if (raw.includes(0)) {
      logger.warn({ file: rel, sandboxDir }, "hooks.upload.skipped_binary");
      skipped++;
      continue;
    }
    try {
      await hands.callTool("write", { path: targetPath, contents: raw.toString("utf-8") });
      uploaded++;
    } catch (err) {
      logger.warn({ err, file: rel, sandboxDir }, "hooks.upload.failed");
      failed++;
    }
  }
  // Make scripts executable so plugin authors can write `./hooks/x.sh` or
  // rely on shebang. Ignore errors — commands invoked via `bash <path>` do
  // not require +x.
  try {
    await hands.callTool("bash", {
      command: `chmod -R +x ${sandboxDir} 2>/dev/null || true`,
      timeout: 10,
    });
  } catch {
    /* non-fatal */
  }
  return { uploaded, skipped, failed };
}

/**
 * Expand `plugin_tools` from the task message only (no DB / no plugin HTTP API).
 * Skill/rule assets are still loaded from S3 using `config.s3_key` when present.
 * When `hands` is provided, `hooks`-type plugins are staged into the sandbox
 * and their `hooks.json` is translated into a runtime HookRegistry.
 */
export async function resolvePluginToolsFromMessage(
  request: ExecuteRequest,
  onEvent: EventCallback | undefined,
  workRoot: string,
  hands?: HandsClient,
): Promise<PluginFromMessageResult> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  const skillContents: Record<string, string> = {};
  const skillDirs: Record<string, string> = {};
  const ruleParts: string[] = [];
  const hookRegistries: HookRegistry[] = [];

  const pid = request.plugin_id;
  if (!(typeof pid === "number" && Number.isFinite(pid) && pid > 0)) {
    return { mcpServers, skillContents, skillDirs, rulesContent: "", hooks: {} };
  }

  const raw = request.plugin_tools;
  if (!Array.isArray(raw) || raw.length === 0) {
    logger.warn({ pluginId: pid }, "plugin.no_plugin_tools_in_message");
    return { mcpServers, skillContents, skillDirs, rulesContent: "", hooks: {} };
  }

  fs.mkdirSync(workRoot, { recursive: true });

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const tool = item as PluginToolRow;
    if (typeof tool.id !== "number") continue;
    const cfg = (tool.config ?? {}) as Record<string, unknown>;
    const type = String(tool.type || "").toLowerCase();

    if (type === "mcp") {
      const servers = (cfg.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      Object.assign(mcpServers, servers);
      logger.info({ toolId: tool.id, servers: Object.keys(servers) }, "plugin.mcp_from_message");
      if (onEvent) {
        await onEvent({
          type: "toolUsed",
          tool: "load_mcp",
          actionId: `plugin_mcp_${tool.id}`,
          status: "success",
          brief: `Loaded plugin MCP (${Object.keys(servers).join(", ")})`,
        });
      }
      continue;
    }

    if (type === "skill") {
      const s3Key = cfg.s3_key as string | undefined;
      if (!s3Key) {
        logger.warn({ toolId: tool.id }, "plugin.skill.missing_s3_key");
        continue;
      }
      const toolName = (tool.name ?? "").trim();
      const name =
        toolName && SAFE_SKILL_NAME.test(toolName)
          ? toolName
          : skillNameFromS3Key(s3Key, String(tool.id));
      const skillDir = path.join(workRoot, "skills", name);
      try {
        if (onEvent) {
          await onEvent({
            type: "toolUsed",
            tool: "download_skill",
            actionId: `plugin_skill_${tool.id}`,
            status: "running",
            brief: `Downloading plugin skill: ${name}`,
          });
        }
        await downloadPluginSkill(cfg, s3Key, skillDir);
        const skillMdPath = findSkillMd(skillDir);
        if (!skillMdPath) {
          logger.warn({ toolId: tool.id, name, skillDir }, "plugin.skill.no_SKILL_md");
          if (onEvent) {
            await onEvent({
              type: "toolUsed",
              tool: "download_skill",
              actionId: `plugin_skill_${tool.id}`,
              status: "error",
              brief: `Plugin skill missing SKILL.md: ${name}`,
            });
          }
          continue;
        }
        skillContents[name] = fs.readFileSync(skillMdPath, "utf-8");
        skillDirs[name] = path.dirname(skillMdPath);

        if (onEvent) {
          await onEvent({
            type: "toolUsed",
            tool: "download_skill",
            actionId: `plugin_skill_${tool.id}`,
            status: "success",
            brief: `Downloaded plugin skill: ${name}`,
          });
        }
      } catch (err) {
        logger.warn({ err, toolId: tool.id, s3Key }, "plugin.skill.download_failed");
        if (onEvent) {
          await onEvent({
            type: "toolUsed",
            tool: "download_skill",
            actionId: `plugin_skill_${tool.id}`,
            status: "error",
            brief: `Failed to download plugin skill: ${name}`,
          });
        }
      }
      continue;
    }

    if (type === "rule") {
      const s3Key = cfg.s3_key as string | undefined;
      if (!s3Key) {
        logger.warn({ toolId: tool.id }, "plugin.rule.missing_s3_key");
        continue;
      }
      const base = path.basename(s3Key);
      const outPath = path.join(workRoot, "rules", `${tool.id}-${base}`);
      try {
        await downloadS3File(s3Key, outPath, S3_PLUGINS_BUCKET);
        const body = fs.readFileSync(outPath, "utf-8").trim();
        if (body) {
          const desc = (tool.description ?? "").trim();
          ruleParts.push(desc ? `## ${desc}\n\n${body}` : body);
        }
        if (onEvent) {
          await onEvent({
            type: "toolUsed",
            tool: "load_rule",
            actionId: `plugin_rule_${tool.id}`,
            status: "success",
            brief: `Loaded plugin rule: ${base}`,
          });
        }
      } catch (err) {
        logger.warn({ err, toolId: tool.id, s3Key }, "plugin.rule.download_failed");
      }
      continue;
    }

    if (type === "hooks" || type === "hook") {
      const s3Key = cfg.s3_key as string | undefined;
      if (!s3Key) {
        logger.warn({ toolId: tool.id }, "plugin.hooks.missing_s3_key");
        continue;
      }
      if (!hands) {
        logger.info({ toolId: tool.id }, "plugin.hooks.no_hands_skipped");
        continue;
      }
      const prefix = s3Key.endsWith("/") ? s3Key : `${s3Key}/`;
      const localHooks = path.join(workRoot, "hooks", String(tool.id));
      const sandboxDir = `${SANDBOX_HOOKS_ROOT}/${tool.id}`;
      try {
        if (onEvent) {
          await onEvent({
            type: "toolUsed",
            tool: "load_hooks",
            actionId: `plugin_hooks_${tool.id}`,
            status: "running",
            brief: `Loading plugin hooks`,
          });
        }
        await syncS3PrefixToLocal(prefix, localHooks, S3_PLUGINS_BUCKET);

        const hooksJsonPath = path.join(localHooks, "hooks.json");
        if (!fs.existsSync(hooksJsonPath)) {
          logger.warn({ toolId: tool.id, localHooks }, "plugin.hooks.missing_hooks_json");
          if (onEvent) {
            await onEvent({
              type: "toolUsed",
              tool: "load_hooks",
              actionId: `plugin_hooks_${tool.id}`,
              status: "error",
              brief: `Plugin hooks missing hooks.json`,
            });
          }
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          logger.warn({ err, toolId: tool.id }, "plugin.hooks.json_parse_failed");
          continue;
        }

        // Upload everything except hooks.json itself — that one stays on
        // Brain for registry building; scripts go into the sandbox.
        const uploadRoot = fs.mkdtempSync(path.join(workRoot, `hooks-upload-${tool.id}-`));
        try {
          for (const entry of fs.readdirSync(localHooks, { withFileTypes: true })) {
            if (entry.name === "hooks.json") continue;
            const src = path.join(localHooks, entry.name);
            const dst = path.join(uploadRoot, entry.name);
            fs.cpSync(src, dst, { recursive: true });
          }
          const up = await uploadHooksDirToSandbox(hands, uploadRoot, sandboxDir);
          logger.info({ toolId: tool.id, sandboxDir, ...up }, "plugin.hooks.staged");
        } finally {
          fs.rmSync(uploadRoot, { recursive: true, force: true });
        }

        const registry = buildRegistryFromHooksField(
          parsed.hooks,
          makeHookPathRewriter(sandboxDir),
        );
        if (registryHasAny(registry)) {
          hookRegistries.push(registry);
        }

        if (onEvent) {
          await onEvent({
            type: "toolUsed",
            tool: "load_hooks",
            actionId: `plugin_hooks_${tool.id}`,
            status: "success",
            brief: `Loaded plugin hooks (${Object.keys(registry).join(", ") || "none"})`,
          });
        }
      } catch (err) {
        logger.warn({ err, toolId: tool.id, s3Key }, "plugin.hooks.download_failed");
        if (onEvent) {
          await onEvent({
            type: "toolUsed",
            tool: "load_hooks",
            actionId: `plugin_hooks_${tool.id}`,
            status: "error",
            brief: `Failed to load plugin hooks`,
          });
        }
      }
      continue;
    }

    logger.warn({ toolId: tool.id, type }, "plugin.unknown_tool_type");
  }

  return {
    mcpServers,
    skillContents,
    skillDirs,
    rulesContent: ruleParts.join("\n\n"),
    hooks: mergeHookRegistries(...hookRegistries),
  };
}
