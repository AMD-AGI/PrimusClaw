// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import pino from "pino";
import { TOOLS_API_URL } from "../config.js";
import type { EventCallback } from "@claw/protocol";
import type { HandsClient } from "../clients/hands.js";
import { isSafeRelativePath, uploadDirToSandbox } from "../sandbox/write.js";

const logger = pino({ name: "resolve-tools" });

interface ResolvedTools {
  mcpServers: Record<string, Record<string, unknown>>;
  skillContents: Record<string, string>;
}

// Sandbox workspace root: Hands' path-guard treats paths as relative to this.
const SANDBOX_WORKSPACE = "/workspace";

/**
 * Resolve marketplace tool_ids via SaFE Tools API.
 * type=mcp → merge MCP server configs
 * type=skill → download ZIP, extract into the sandbox workspace via Hands (if provided),
 *             otherwise fall back to Brain-local filesystem.
 */
export async function resolveToolIds(
  toolIds: number[],
  platformKey: string,
  onEvent?: EventCallback,
  sessionDir?: string,
  hands?: HandsClient,
): Promise<ResolvedTools> {
  if (!toolIds.length) return { mcpServers: {}, skillContents: {} };

  const mcpServers: Record<string, Record<string, unknown>> = {};
  const skillContents: Record<string, string> = {};
  const apiKey = platformKey;

  if (onEvent) {
    await onEvent({ type: "toolUsed", tool: "resolve_tools", actionId: "resolve_tools_fetch", status: "running", brief: `Fetching tool configuration`, description: `Fetching configuration for ${toolIds.length} tools from the marketplace...` });
  }

  let tools: Record<number, Record<string, unknown>> = {};
  try {
    const resp = await fetch(`${TOOLS_API_URL}?offset=0&limit=100&order=desc`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: { tools?: Record<string, unknown>[] } };
    for (const t of data.data?.tools ?? []) {
      tools[t.id as number] = t;
    }
  } catch (err) {
    logger.error({ err }, "resolve_tools.fetch_failed");
    if (onEvent) {
      await onEvent({ type: "toolUsed", tool: "resolve_tools", actionId: "resolve_tools_fetch", status: "error", brief: "Failed to fetch tool configuration" });
    }
    return { mcpServers, skillContents };
  }

  if (onEvent) {
    await onEvent({ type: "toolUsed", tool: "resolve_tools", actionId: "resolve_tools_fetch", status: "success", brief: "Fetched tool configuration" });
  }

  for (const tid of toolIds) {
    const tool = tools[tid];
    if (!tool) { logger.warn({ tid }, "resolve_tools.not_found"); continue; }
    const toolName = (tool.name as string) ?? `tool_${tid}`;

    if (tool.type === "mcp") {
      const servers = ((tool.config as Record<string, unknown>)?.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      Object.assign(mcpServers, servers);
      logger.info({ tid, toolName, servers: Object.keys(servers) }, "resolve_tools.mcp");
    } else if (tool.type === "skill") {
      if (onEvent) {
        await onEvent({ type: "toolUsed", tool: "download_skill", actionId: `skill_download_${tid}`, status: "running", brief: `Downloading skill: ${toolName}` });
      }
      try {
        const content = await downloadSkill(tid, toolName, apiKey, sessionDir, hands);
        if (content) {
          skillContents[toolName] = content;
          logger.info({ tid, toolName, length: content.length }, "resolve_tools.skill_downloaded");
        }
        if (onEvent) {
          await onEvent({ type: "toolUsed", tool: "download_skill", actionId: `skill_download_${tid}`, status: "success", brief: `Downloaded skill: ${toolName}` });
        }
      } catch (err) {
        logger.warn({ err, tid, toolName }, "resolve_tools.skill_download_failed");
        if (onEvent) {
          await onEvent({ type: "toolUsed", tool: "download_skill", actionId: `skill_download_${tid}`, status: "error", brief: `Failed to download skill: ${toolName}` });
        }
      }
      continue;
    }

    if (onEvent) {
      await onEvent({ type: "toolUsed", tool: "resolve_tools", actionId: `tool_${tid}`, status: "success", brief: `Loaded: ${toolName}` });
    }
  }

  return { mcpServers, skillContents };
}

/**
 * Download skill from SaFE Tools API, extract ZIP if needed.
 * When `hands` is provided, files are written into the Hands sandbox under
 * `<sessionDir>/.skills/<skillName>/` so the LLM can `cat` them via bash.
 * Otherwise, files are written to a Brain-local temp directory (legacy path).
 * Returns SKILL.md contents.
 */
async function downloadSkill(
  toolId: number,
  skillName: string,
  apiKey: string,
  sessionDir?: string,
  hands?: HandsClient,
): Promise<string> {
  const downloadUrl = `${TOOLS_API_URL}/${toolId}/download`;
  const resp = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get("content-type") ?? "";

  // Always stage to a Brain-local temp dir so we can read SKILL.md locally.
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), `claw-skill-${toolId}-`));

  // ZIP file (PK header or application/zip content-type)
  const isZip = (buf[0] === 0x50 && buf[1] === 0x4b) || contentType.includes("zip") || contentType.includes("octet-stream");
  if (isZip) {
    try {
      const zip = new AdmZip(buf);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName.replaceAll("\\", "/");
        if (!isSafeRelativePath(entryName)) {
          logger.warn({ toolId, skillName, entryName }, "skill.zip_unsafe_entry_skipped");
          continue;
        }
        const outPath = path.join(localDir, entryName);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, entry.getData());
      }
    } catch (err) {
      logger.warn({ err, toolId, skillName }, "skill.zip_extract_failed");
      fs.writeFileSync(path.join(localDir, "SKILL.md"), buf);
    }
  } else {
    fs.writeFileSync(path.join(localDir, "SKILL.md"), buf);
  }

  // Mirror files into the target (sandbox via Hands, or Brain-local fallback).
  if (hands && sessionDir) {
    // Sandbox path-guard resolves paths relative to /workspace. Compute a
    // relative path: "/workspace" → "", "/workspace/foo" → "foo".
    let rel: string;
    if (sessionDir === SANDBOX_WORKSPACE) rel = "";
    else if (sessionDir.startsWith(SANDBOX_WORKSPACE + "/")) rel = sessionDir.slice(SANDBOX_WORKSPACE.length + 1);
    else rel = sessionDir.replace(/^\/+/, "");
    const skillRel = rel ? path.posix.join(rel, ".skills", skillName) : path.posix.join(".skills", skillName);
    const upload = await uploadDirToSandbox(hands, localDir, skillRel);
    for (const item of upload.skips) {
      logger.warn({ toolId, skillName, file: item.file, reason: item.reason }, "skill.upload.skipped");
    }
    for (const item of upload.failures) {
      logger.warn({ toolId, skillName, file: item.file, err: item.error }, "skill.upload.failed");
    }
    const shippable = upload.total - upload.skipped;
    if (upload.failed > 0 || (shippable > 0 && upload.uploaded === 0)) {
      logger.error({ toolId, skillName, ...upload, sandboxRel: skillRel }, "skill.upload.failed_required");
      throw new Error(`Failed to upload skill '${skillName}' to sandbox`);
    }
    logger.info({ toolId, skillName, ...upload, sandboxRel: skillRel }, "skill.upload.done");
  } else if (sessionDir) {
    // Legacy path: copy Brain-local (works only when Brain and sandbox share fs).
    const outDir = path.join(sessionDir, ".skills", skillName);
    fs.mkdirSync(outDir, { recursive: true });
    copyDirSync(localDir, outDir);
  }

  const skillMd = findSkillMd(localDir);
  if (!skillMd) throw new Error(`SKILL.md not found after extraction`);
  return fs.readFileSync(skillMd, "utf-8");
}

/** Copy an entire directory tree. Used for the legacy non-Hands path. */
function copyDirSync(srcDir: string, dstDir: string): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDirSync(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

/** Recursively find SKILL.md in a directory. */
function findSkillMd(dir: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSkillMd(full);
      if (found) return found;
    } else if (entry.name === "SKILL.md") {
      return full;
    }
  }
  return null;
}
