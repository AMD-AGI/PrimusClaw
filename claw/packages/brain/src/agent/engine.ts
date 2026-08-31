// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { HandsClient } from "../clients/hands.js";
import { ToolRouter } from "../tools/router.js";
import { agentLoop } from "./agent-loop.js";
import { resolveToolIds } from "../tools/resolve.js";
import { marketplaceToolIds, resolvePluginToolsFromMessage } from "../tasks/plugin-from-message.js";
import { loadRules } from "./rules.js";
import { normalizeMcpConfigs } from "../clients/mcp-config.js";
import { connectPlatformMcp } from "../clients/mcp.js";
import { buildPrompt } from "./prompt.js";
import { resolveRequestLlmKey } from "../llm/key-source.js";
import {
  isSafeRelativePath,
  uploadDirToSandbox,
  writeFileToSandbox,
  writeTextFileToSandbox,
} from "../sandbox/write.js";
import {
  ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, OPENAI_BASE_URL, OPENAI_API_KEY, LLM_API_STYLE,
  DEFAULT_MODEL, MAX_TURNS,
  WEB_SEARCH_PROVIDER, WEB_FETCH_ENABLED,
} from "../config.js";
import { WebSearchService, WebFetchService, SimpleSessionCostTracker } from "../tools/web/index.js";
import type { ExecuteRequest, ExecuteResult, EventCallback } from "@claw/protocol";
import type { ExecuteExtras } from "./index.js";
import { HookRunner, registryHasAny } from "./hooks.js";
import pino from "pino";

const logger = pino({ name: "agent-engine" });

/**
 * Agent engine: self-built agent loop calling the LLM directly (Anthropic
 * Messages or OpenAI Chat Completions, see ../llm/ and config.ts
 * LLM_API_STYLE for provider selection). No Claude/Agent SDK dependency.
 * All state is local (multi-user safe).
 */
/**
 * Headers for the web-tool Anthropic client.
 *
 * A named function so the absence of `x-auto-prompt-caching` is a line a test
 * can hold down, the same way the agent-loop client's headers are. That header
 * lived here too, and removing it from only one of the two clients would have
 * left the guard on one path and not the other -- which is how it survives a
 * fix and comes back.
 *
 * These calls get no cache markers either. web_search and the web_fetch
 * summariser are single-shot with no reusable prefix, so a breakpoint would
 * bill the write premium for an entry nothing ever reads back.
 */
export function webToolClientHeaders(): Record<string, string> {
  return {};
}

export class AgentEngine {
  async execute(
    request: ExecuteRequest,
    onEvent: EventCallback,
    signal?: AbortSignal,
    hands?: HandsClient | null,
    extras?: ExecuteExtras,
  ): Promise<ExecuteResult> {
    // Which wire protocol Brain speaks to the LLM is a deployment-wide
    // choice (LLM_API_STYLE); apiKey still honors per-request BYOK/platform
    // key overrides via resolveRequestLlmKey on top of that provider's
    // configured default key.
    const apiUrl = LLM_API_STYLE === "openai" ? OPENAI_BASE_URL : ANTHROPIC_BASE_URL;
    const apiKey = resolveRequestLlmKey(request, LLM_API_STYLE === "openai" ? OPENAI_API_KEY : ANTHROPIC_API_KEY);
    const platformKey = request.platform_key || "";
    const model = request.model || DEFAULT_MODEL;
    const sessionId = request.session_id;

    logger.info({ sessionId, model, apiUrl, apiStyle: LLM_API_STYLE }, "engine.execute_start");

    const sessionDir = "/workspace";
    // A run may start without a sandbox (task-runner defers it for ordinary
    // chat turns). Everything below that reaches into /workspace asks for one
    // through `sandbox()`, so a turn that never touches a file never pays for
    // a pod. Once opened, the client is reused for the rest of the run.
    let attached: HandsClient | null = hands ?? null;
    const attach = extras?.attachHands;
    const sandbox = async (): Promise<HandsClient> => {
      if (attached) return attached;
      if (!attach) throw new Error("HandsClient is required for the agent engine");
      attached = await attach();
      return attached;
    };
    if (!attached && !attach) {
      throw new Error("HandsClient is required for the agent engine");
    }
    // Plugin work root: local staging on Brain for S3 downloads (skills,
    // rules, hooks). Must be writable by the Brain process; use os.tmpdir()
    // instead of BRAIN_SESSION_ROOT which may point at a read-only path
    // (e.g. /workspace owned by root in the container image).
    const pluginWorkRoot = path.join(os.tmpdir(), "claw-plugin-work", request.session_id);
    // Both resolvers install their payload into the sandbox, so each gets one
    // only when the request actually carries something for it to install —
    // they no-op on an empty tool list / absent plugin id.
    const toolIds = marketplaceToolIds(request);
    const resolved = await resolveToolIds(
      toolIds, platformKey, onEvent, sessionDir,
      toolIds.length ? await sandbox() : undefined,
    );
    const hasPlugin = typeof request.plugin_id === "number" && request.plugin_id > 0
      && Array.isArray(request.plugin_tools) && request.plugin_tools.length > 0;
    const pluginLayer = await resolvePluginToolsFromMessage(
      request, onEvent, pluginWorkRoot, hasPlugin ? await sandbox() : undefined,
    );

    const envOverrides: Record<string, string> = {};
    if (platformKey) envOverrides.SAFE_API_KEY = platformKey;
    const mergedMcp = normalizeMcpConfigs({
      ...(request.mcp_servers || {}),
      ...resolved.mcpServers,
      ...pluginLayer.mcpServers,
    }, envOverrides);

    const allSkills: Record<string, string> = {};
    const skillSources: Record<string, "plugin" | "local" | "marketplace"> = {};
    for (const [name, content] of Object.entries(pluginLayer.skillContents)) {
      allSkills[name] = content;
      skillSources[name] = "plugin";
    }
    for (const [name, spec] of Object.entries(request.skills || {})) {
      if (spec.enabled) {
        allSkills[name] = spec.content;
        skillSources[name] = "local";
      }
    }
    for (const [name, content] of Object.entries(resolved.skillContents)) {
      if (allSkills[name] && allSkills[name] !== content) {
        logger.info({ skillName: name }, "skill.local_overridden_by_marketplace");
      }
      allSkills[name] = content;
      skillSources[name] = "marketplace";
    }

    const rules = loadRules();
    const fullPrompt = buildPrompt(
      request.prompt ?? "",
      allSkills,
      Object.keys(mergedMcp),
      model,
      sessionDir,
      pluginLayer.rulesContent,
      {
        sessionId: request.session_id,
        userId: request.user_id || "default",
        parentSessionId: request.parent_session_id,
        teamRole: request.team_role,
      },
    );

    logger.info({
      sessionId,
      skillCount: Object.keys(allSkills).length,
      mcpServerCount: Object.keys(mergedMcp).length,
      promptLen: fullPrompt.length,
    }, "engine.tools_resolved");

    const mcpResult = Object.keys(mergedMcp).length > 0
      ? await connectPlatformMcp(mergedMcp)
      : { clients: new Map(), schemas: [], closeAll: async () => {} };

    try {
      // Web tools (native web_search + Haiku web_fetch summarization) are
      // intentionally always Anthropic-backed regardless of LLM_API_STYLE:
      // native web_search is an Anthropic-only server tool, and the
      // summarization model default (WEB_FETCH_SUMMARIZE_MODEL) is a Claude
      // model. Deployments running LLM_API_STYLE=openai without an
      // ANTHROPIC_BASE_URL configured should set WEB_SEARCH_PROVIDER to a
      // third-party provider (tavily/brave/serper) and/or disable
      // WEB_FETCH_SUMMARIZE — this block does not fall back automatically.
      // When the main provider is Anthropic, its already-resolved request key
      // is valid for these request-scoped Anthropic calls too. OpenAI-mode
      // deployments still need a separate deployment Anthropic key.
      const webApiKey = LLM_API_STYLE === "anthropic" ? apiKey : ANTHROPIC_API_KEY;
      const webToolCtx = (WEB_SEARCH_PROVIDER !== "disabled" || WEB_FETCH_ENABLED)
        ? (() => {
            const anthropicClient = new Anthropic({
              apiKey: webApiKey, baseURL: ANTHROPIC_BASE_URL, maxRetries: 2,
              defaultHeaders: webToolClientHeaders(),
            });
            const costTracker = new SimpleSessionCostTracker();
            return {
              sessionId: request.session_id,
              apiKey: webApiKey,
              apiUrl: ANTHROPIC_BASE_URL,
              model,
              anthropic: anthropicClient,
              sessionCost: costTracker,
              signal,
            };
          })()
        : undefined;

      const router = new ToolRouter(attached, mcpResult.clients, {
        webSearch: webToolCtx && WEB_SEARCH_PROVIDER !== "disabled"
          ? new WebSearchService(webToolCtx) : undefined,
        webFetch: webToolCtx && WEB_FETCH_ENABLED
          ? new WebFetchService(webToolCtx) : undefined,
        // a2a bearer: keep the platform_key fallback so safe-mode dispatch
        // (empty llm_api_key) still authenticates sub-agent calls.
      }, resolveRequestLlmKey(request) || request.platform_key || "", sandbox);
      const allToolSchemas = [...router.getToolSchemas(), ...mcpResult.schemas];

      const messages = [...(request.history || [])];
      const brainSystemParts = [rules, request.rules_text, request.system_append].filter(Boolean);
      if (brainSystemParts.length) {
        const brainSystem = brainSystemParts.join("\n\n");
        if (messages.length && messages[0].role === "system") {
          messages[0] = {
            role: "system" as const,
            content: typeof messages[0].content === "string"
              ? `${messages[0].content}\n\n${brainSystem}`
              : brainSystem,
          };
        } else {
          messages.unshift({ role: "system" as const, content: brainSystem });
        }
      }
      messages.push({ role: "user" as const, content: fullPrompt });

      {
        const activePluginSkillDirs = Object.fromEntries(
          Object.entries(pluginLayer.skillDirs || {})
            .filter(([name]) => skillSources[name] === "plugin"),
        );

        // Plugin skills — write each file from Brain local dir to sandbox
        for (const [name, localDir] of Object.entries(activePluginSkillDirs)) {
          const sandboxBase = `${sessionDir}/.skills/${name}`;
          const upload = await uploadDirToSandbox(await sandbox(), localDir, sandboxBase);
          for (const item of upload.skips) {
            logger.warn({ name, file: item.file, reason: item.reason }, "skill.plugin_write_file_skipped");
          }
          for (const item of upload.failures) {
            logger.warn({ name, file: item.file, err: item.error }, "skill.plugin_write_file_failed");
          }
          const shippable = upload.total - upload.skipped;
          if (upload.failed > 0 || (shippable > 0 && upload.uploaded === 0)) {
            throw new Error(`Failed to write plugin skill '${name}' to sandbox`);
          }
          logger.info({ name, sandboxBase, ...upload }, "skill.plugin_written_to_sandbox");
        }

        // Local skills with sub-files — write SKILL.md + sub-files.
        const localSkillEntries = Object.entries(allSkills)
          .filter(([name]) =>
            skillSources[name] === "local" && ((request.skills || {})[name]?.files?.length ?? 0) > 0
          );
        for (const [name, content] of localSkillEntries) {
          const sandboxBase = `${sessionDir}/.skills/${name}`;
          try {
            await writeTextFileToSandbox(await sandbox(), `${sandboxBase}/SKILL.md`, content);
          } catch (err: any) {
            logger.warn({ err: err.message, name }, "skill.local_write_skillmd_failed");
            throw new Error(`Failed to write local skill '${name}' SKILL.md to sandbox`);
          }
          const localFiles = (request.skills || {})[name]?.files || [];
          for (const f of localFiles) {
            if (!isSafeRelativePath(f.path)) {
              throw new Error(`Unsafe skill file path '${f.path}' in skill '${name}'`);
            }
            const targetPath = `${sandboxBase}/${f.path}`;
            try {
              await writeFileToSandbox(await sandbox(), targetPath, f.content, f.is_binary ? "base64" : "utf8");
            } catch (err: any) {
              logger.warn({ err: err.message, name, file: f.path }, "skill.local_write_file_failed");
              throw new Error(`Failed to write local skill '${name}' file '${f.path}' to sandbox`);
            }
          }
        }
      }

      // 7a. Legacy ExecuteRequest.hooks (template "hard hooks" via MCP tool calls).
      //     Not wired up to any API path today; preserved here to avoid breaking
      //     callers that still populate it. The new plugin hook system below is
      //     independent and runs regardless.
      for (const hook of request.hooks?.pre ?? []) {
        await onEvent({ type: "toolUsed", tool: hook.name, status: "start", brief: "Pre-hook" });
        await (await sandbox()).callTool(hook.name, hook.args);
        await onEvent({ type: "toolUsed", tool: hook.name, status: "success" });
      }

      // 7b. Plugin hooks runtime. Registry already built in pluginLayer; runner
      //     executes commands inside the sandbox and parses decisions. When no
      //     hooks were provided, agentLoop sees `hooks: undefined` and the
      //     dispatch cost is zero.
      const hookRunner = registryHasAny(pluginLayer.hooks)
        ? new HookRunner(pluginLayer.hooks, await sandbox(), onEvent, request.session_id)
        : undefined;

      // SessionStart: informational; decision is ignored (cannot block a
      // session before it exists in any meaningful sense).
      if (hookRunner?.has("SessionStart")) {
        await hookRunner.run("SessionStart", {});
      }

      // UserPromptSubmit: may block the task pre-LLM. When blocked, skip the
      // loop entirely and return the reason as finalText so the caller still
      // gets a well-formed ExecuteResult (no tokens spent).
      if (hookRunner?.has("UserPromptSubmit")) {
        const decision = await hookRunner.run("UserPromptSubmit", { prompt: request.prompt });
        if (decision.block) {
          const reason = decision.reason || "Prompt blocked by UserPromptSubmit hook";
          if (hookRunner.has("SessionEnd")) {
            await hookRunner.run("SessionEnd", { stop_reason: "blocked_by_hook" });
          }
          return {
            finalText: reason,
            tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
            turns: 0,
            errorCount: 0,
            toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
            elapsedMs: 0,
            pendingMemories: [],
            pendingSkills: [],
            skillsUsed: {},
          };
        }
      }

      // 8. Run agent loop (Hands tools + platform MCP tools available to LLM)
      //    Turn budget: request.max_turns (per-task override) → MAX_TURNS env → default.
      //    0 or negative disables the cap in agent-loop.
      const maxTurns = request.max_turns ?? MAX_TURNS;
      logger.info({
        sessionId,
        maxTurns,
        toolSchemaCount: allToolSchemas.length,
        messageCount: messages.length,
        mcpClients: mcpResult.clients.size,
        hasHooks: !!hookRunner,
      }, "engine.agent_loop_start");

      let loopResult: Awaited<ReturnType<typeof agentLoop>>;
      try {
        loopResult = await agentLoop(messages, allToolSchemas, {
          model,
          apiUrl,
          apiKey,
          maxTurns,
          router,
          onEvent,
          signal,
          userId: request.user_id,
          sessionId: request.session_id,
          depth: 0,
          hands: attached,
          attachHands: sandbox,
          runKey: request.dag_root_task_id || request.session_id,
          platformMcpClients: mcpResult.clients,
          recreateHands: extras?.recreateHands,
          hooks: hookRunner,
          onCheckpoint: extras?.onCheckpoint,
          resumeFrom: extras?.resumeCheckpoint,
        });
      } finally {
        // SessionEnd fires regardless of loop success/failure so cleanup hooks
        // (artifact upload, log flush, …) always run.
        if (hookRunner?.has("SessionEnd")) {
          await hookRunner.run("SessionEnd", {});
        }
      }

      // 9. Legacy ExecuteRequest.hooks post-lane (see 7a).
      for (const hook of request.hooks?.post ?? []) {
        await onEvent({ type: "toolUsed", tool: hook.name, status: "start", brief: "Post-hook" });
        await (await sandbox()).callTool(hook.name, hook.args);
        await onEvent({ type: "toolUsed", tool: hook.name, status: "success" });
      }

      // 10. Build skillsUsed map: only skills the Agent actually read during this run.
      //     Falls back to empty map when no skill was consulted — we do NOT credit
      //     skills that were merely loaded into context but ignored by the Agent.
      const skillsUsed: Record<string, number> = {};
      for (const name of router.skillsRead) {
        if (!allSkills[name]) continue; // skill read but unknown — ignore
        const reqSkill = (request.skills || {})[name];
        skillsUsed[name] = reqSkill?.version || 1;
      }

      logger.info({
        sessionId,
        turns: loopResult.turns,
        elapsedMs: loopResult.elapsedMs,
        toolCalls: loopResult.toolStats.total_calls,
        errors: loopResult.errorCount,
        finalTextLen: loopResult.finalText.length,
      }, "engine.execute_done");

      return {
        finalText: loopResult.finalText,
        tokenUsage: loopResult.tokenUsage,
        turns: loopResult.turns,
        errorCount: loopResult.errorCount,
        toolStats: loopResult.toolStats,
        elapsedMs: loopResult.elapsedMs,
        pendingMemories: router.pendingMemories,
        pendingSkills: router.pendingSkills,
        pendingSkillFileMutations: router.pendingSkillFileMutations,
        skillsUsed,
      };
    } finally {
      await mcpResult.closeAll();
      try { fs.rmSync(pluginWorkRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
