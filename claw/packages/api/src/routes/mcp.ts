// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * MCP endpoint — exposes Claw v2 API as MCP tools for Cursor / AI agents.
 *
 * Strategy: tool handlers call existing API routes via app.inject() so all
 * business logic (auth, transactions, NATS, S3) is reused with zero duplication.
 * Exceptions: wait_for_result uses DB-polling subscription directly (streaming),
 * list_models fetches SaFE external API, prompt builders are pure functions.
 */

import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createSessionSubscription } from "../events/store.js";
import {
  SAFE_API_URL,
  HYPERLOOM_DEFAULT_IMAGE,
  GEAK_DEFAULT_IMAGE,
  LITELLM_API_BASE,
  SAFE_DEFAULT_WORKSPACE,
} from "../config.js";
import { buildHyperloomPrompt, buildGeakPrompt } from "../workbenches/prompt-builders.js";
import pino from "pino";

const logger = pino({ name: "mcp" });

function unwrapInject(resp: { statusCode: number; body: string }): any {
  const data = JSON.parse(resp.body);
  if (resp.statusCode >= 400) {
    throw new Error(data.error || data.message || `HTTP ${resp.statusCode}`);
  }
  return data;
}

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function promptImageParam(defaultImage: string, envName: string) {
  const configuredImage = defaultImage.trim();
  const schema = z.string().trim().min(1, `${envName} is not configured; pass image explicitly`);
  if (configuredImage) {
    return schema.default(configuredImage).describe(`Container image (defaults to ${envName} env)`);
  }
  return schema.describe(`Container image (required because ${envName} env is unset)`);
}

function promptApiBaseParam(defaultApiBase: string) {
  const configuredApiBase = defaultApiBase.trim();
  const schema = z.string().trim().url().min(
    1,
    "LITELLM_API_BASE is not configured; pass api_base explicitly",
  );
  if (configuredApiBase) {
    return schema.default(configuredApiBase).describe(
      "OpenAI-compatible API base (defaults to LITELLM_API_BASE env)",
    );
  }
  return schema.describe(
    "OpenAI-compatible API base (required because LITELLM_API_BASE env is unset)",
  );
}

function createMcpServer(app: FastifyInstance, authHeader: string): McpServer {
  const mcp = new McpServer({ name: "PrimusClaw", version: "2.0.0" });

  const injectHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authHeader) injectHeaders["authorization"] = authHeader;

  async function api(
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
  ): Promise<any> {
    const resp = await app.inject({
      method,
      url,
      headers: injectHeaders,
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
    return unwrapInject(resp);
  }

  // ===================== Session CRUD =====================

  mcp.tool(
    "claw_create_session",
    "Create a new PrimusClaw v2 session. Use parent_session_id to form an agent team (parent=leader, child=worker).",
    {
      name: z.string().default("").describe("Human-readable session name"),
      agent_id: z.string().default("agent_default").describe("Agent to use"),
      system_prompt: z.string().default("").describe("Optional system prompt override"),
      mode: z.string().default("claw-harness").describe('Session mode: "claw-harness" or "local-harness" (GPU sandbox)'),
      parent_session_id: z.string().optional().describe("Parent session ID to form an agent team. The parent is the leader; this new session becomes a worker."),
      team_role: z.string().optional().describe('Role name within the team (e.g. "researcher", "coder", "reviewer"). Only meaningful when parent_session_id is set.'),
    },
    async (params) => {
      const body: Record<string, unknown> = {
        name: params.name,
        agent_id: params.agent_id,
        system_prompt: params.system_prompt,
        mode: params.mode,
      };
      if (params.parent_session_id) body.parent_session_id = params.parent_session_id;
      if (params.team_role) body.team_role = params.team_role;
      const data = await api("POST", "/v1/sessions", body);
      return textResult(data);
    },
  );

  mcp.tool(
    "claw_list_sessions",
    "List all PrimusClaw sessions for the current user",
    {},
    async () => textResult(await api("GET", "/v1/sessions")),
  );

  mcp.tool(
    "claw_list_team_members",
    "List child sessions (agent team workers) of a parent session",
    { session_id: z.string().describe("The parent (leader) session UUID") },
    async (params) => textResult(await api("GET", `/v1/sessions/${params.session_id}/children`)),
  );

  mcp.tool(
    "claw_get_session",
    "Get details of a specific session",
    { session_id: z.string().describe("The session UUID") },
    async (params) => textResult(await api("GET", `/v1/sessions/${params.session_id}`)),
  );

  mcp.tool(
    "claw_delete_session",
    "Delete a session and clean up its resources (sandbox, S3, NATS)",
    { session_id: z.string().describe("The session UUID to delete") },
    async (params) => textResult(await api("DELETE", `/v1/sessions/${params.session_id}`)),
  );

  // ===================== Messaging =====================

  mcp.tool(
    "claw_send_message",
    "Send a message to an existing session (fire-and-forget). Use claw_wait_for_result() afterwards.",
    {
      session_id: z.string().describe("Target session UUID"),
      content: z.string().describe("The prompt / message text"),
      task_mode: z.string().default("agent").describe('"agent" for full Agent execution'),
      plugin_id: z.number().optional().describe("Optional plugin ID"),
      workspace_id: z.string().optional().describe("Target K8s namespace for sandbox"),
    },
    async (params) => {
      const body: Record<string, unknown> = {
        content: params.content,
        contents: [{ type: "text", value: params.content }],
        messageType: "text",
        taskMode: params.task_mode,
        attachments: [],
        tools: [],
      };
      if (params.plugin_id !== undefined) body.pluginId = params.plugin_id;
      if (params.workspace_id) body.workspaceId = params.workspace_id;

      const data = await api("POST", `/v1/sessions/${params.session_id}/messages`, body);
      return textResult(data);
    },
  );

  mcp.tool(
    "claw_interrupt_session",
    "Interrupt a running agent session",
    { session_id: z.string().describe("The session UUID to interrupt") },
    async (params) => {
      const data = await api("POST", `/v1/sessions/${params.session_id}/messages`, {
        messageType: "interrupt",
      });
      return textResult(data);
    },
  );

  // ===================== Wait for result (DB-polling subscription) =====================

  mcp.tool(
    "claw_wait_for_result",
    "Subscribe to session events and wait until the Agent finishes. Returns the assistant reply and tool call summary.",
    {
      session_id: z.string().describe("The session to monitor"),
      timeout: z.number().default(600).describe("Max seconds to wait (default 600)"),
    },
    async (params) => {
      // Reuse the HTTP route's ownership/operator policy before opening the
      // direct DB subscription. Full and read-only system admins may monitor
      // any tenant; ordinary callers are limited to their own sessions.
      await api("GET", `/v1/sessions/${params.session_id}`);
      const timeoutMs = params.timeout * 1000;
      const subscription = createSessionSubscription(params.session_id);

      const assistantParts: string[] = [];
      const toolCalls: Array<{ tool: string; status: string; brief: string }> = [];
      let agentStatus = "unknown";
      let brief = "";
      let eventCount = 0;

      const timer = setTimeout(() => subscription.close(), timeoutMs);

      try {
        for await (const evt of subscription.events()) {
          if (!evt) continue;
          eventCount++;
          const t = evt.type as string;

          if (t === "AssistantMessage") {
            const blocks = ((evt.data as any)?.content as any[]) || [];
            const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n\n");
            if (text) assistantParts.push(text);
          } else if (t === "toolUsed") {
            toolCalls.push({
              tool: (evt.tool as string) || "",
              status: (evt.status as string) || "",
              brief: (evt.brief as string) || "",
            });
          } else if (t === "statusUpdate") {
            agentStatus = (evt.agentStatus as string) || agentStatus;
            brief = (evt.brief as string) || brief;
            if (agentStatus === "stopped") break;
          }

          if (eventCount % 20 === 0) {
            logger.info({ sessionId: params.session_id, eventCount, agentStatus }, "mcp.wait.progress");
          }
        }
      } finally {
        clearTimeout(timer);
        subscription.close();
      }

      return textResult({
        status: agentStatus,
        brief,
        assistant_reply: assistantParts.join(""),
        tool_calls_count: toolCalls.length,
        tool_calls: toolCalls.slice(-20),
      });
    },
  );

  // ===================== Pipeline (compose) =====================

  mcp.tool(
    "claw_run_pipeline",
    "One-shot: create session → send prompt → wait for completion → return result.",
    {
      prompt: z.string().describe("The task prompt. For inference optimization, use claw_build_hyperloom_prompt() first."),
      session_name: z.string().default("").describe("Optional session name"),
      agent_id: z.string().default("agent_default").describe("Agent to use"),
      system_prompt: z.string().default("").describe("Optional system prompt override"),
      mode: z.string().default("claw-harness").describe("Session mode"),
      timeout: z.number().default(600).describe("Max seconds to wait"),
      plugin_id: z.number().optional().describe("Optional plugin ID"),
      workspace_id: z.string().optional().describe("Target K8s namespace for sandbox"),
    },
    async (params) => {
      const createResp = await api("POST", "/v1/sessions", {
        name: params.session_name,
        agent_id: params.agent_id,
        system_prompt: params.system_prompt,
        mode: params.mode,
      });
      const sessionId = createResp.data?.session_id ?? createResp.session_id;
      if (!sessionId) throw new Error("Failed to create session: no session_id returned");

      const msgBody: Record<string, unknown> = {
        content: params.prompt,
        contents: [{ type: "text", value: params.prompt }],
        messageType: "text",
        taskMode: "agent",
        attachments: [],
        tools: [],
      };
      if (params.plugin_id !== undefined) msgBody.pluginId = params.plugin_id;
      if (params.workspace_id) msgBody.workspaceId = params.workspace_id;
      await api("POST", `/v1/sessions/${sessionId}/messages`, msgBody);

      const timeoutMs = params.timeout * 1000;
      const subscription = createSessionSubscription(sessionId);
      const assistantParts: string[] = [];
      const toolCalls: Array<{ tool: string; status: string; brief: string }> = [];
      let agentStatus = "unknown";
      let brief = "";

      const timer = setTimeout(() => subscription.close(), timeoutMs);
      try {
        for await (const evt of subscription.events()) {
          if (!evt) continue;
          const t = evt.type as string;
          if (t === "AssistantMessage") {
            const blocks = ((evt.data as any)?.content as any[]) || [];
            const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n\n");
            if (text) assistantParts.push(text);
          } else if (t === "toolUsed") {
            toolCalls.push({
              tool: (evt.tool as string) || "",
              status: (evt.status as string) || "",
              brief: (evt.brief as string) || "",
            });
          } else if (t === "statusUpdate") {
            agentStatus = (evt.agentStatus as string) || agentStatus;
            brief = (evt.brief as string) || brief;
            if (agentStatus === "stopped") break;
          }
        }
      } finally {
        clearTimeout(timer);
        subscription.close();
      }

      return textResult({
        session_id: sessionId,
        status: agentStatus,
        brief,
        assistant_reply: assistantParts.join(""),
        tool_calls_count: toolCalls.length,
        tool_calls: toolCalls.slice(-20),
      });
    },
  );

  // ===================== Files =====================

  mcp.tool(
    "claw_list_files",
    "List files in a session's workspace (S3-backed storage)",
    { session_id: z.string().describe("The session UUID") },
    async (params) => textResult(await api("GET", `/v1/sessions/${params.session_id}/files`)),
  );

  // ===================== Models (external SaFE API) =====================

  mcp.tool(
    "claw_list_models",
    "List available models from SaFE for inference optimization.",
    { workspace: z.string().default("").describe("Optional workspace filter") },
    async (params) => {
      if (!SAFE_API_URL) throw new Error("SAFE_API_URL not configured");

      const qs = params.workspace ? `?workspace=${encodeURIComponent(params.workspace)}` : "";
      const resp = await fetch(`${SAFE_API_URL}/playground/models${qs}`, {
        headers: authHeader ? { Authorization: authHeader } : {},
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`SaFE API error: HTTP ${resp.status}`);
      const body = await resp.json();
      const raw = body.data ?? body;
      const items: any[] = Array.isArray(raw) ? raw : raw.items ?? [];

      const models = items
        .filter((m: any) => ["local", "local_path"].includes(m.accessMode) && m.phase === "Ready")
        .map((m: any) => ({
          displayName: m.displayName ?? "",
          localPath: m.localPath ?? "",
          accessMode: m.accessMode ?? "",
          phase: m.phase ?? "",
          hasInferenceX: m.hasInferenceX ?? false,
          workspace: m.workspace ?? "",
        }));

      return textResult(models);
    },
  );

  // ===================== Prompt Builders =====================

  mcp.tool(
    "claw_build_hyperloom_prompt",
    "Build a structured Hyperloom inference-optimization prompt (same template as the web UI). Pass the result to claw_run_pipeline().",
    {
      model_name: z.string().describe('Model display name, e.g. "Qwen3.5-397B-A17B"'),
      model_path: z.string().describe('NFS path to the model, e.g. "/hyperloom/models/Qwen3.5-397B-A17B"'),
      framework: z.string().default("sglang").describe('"sglang" or "vllm"'),
      precision: z.string().default("FP4").describe('"FP4" or "FP8"'),
      isl: z.number().default(1024).describe("Input sequence length"),
      osl: z.number().default(1024).describe("Output sequence length"),
      concurrency: z.number().default(64).describe("Concurrent requests"),
      tp: z.number().default(1).describe("Tensor parallelism"),
      ep: z.number().default(1).describe("Expert parallelism"),
      gpu_type: z.string().default("MI355X").describe("GPU type"),
      image: promptImageParam(HYPERLOOM_DEFAULT_IMAGE, "HYPERLOOM_DEFAULT_IMAGE"),
      inferencex_path: z.string().default("/hyperloom/InferenceX").describe("Path to InferenceX"),
      workspace: z.string().default(SAFE_DEFAULT_WORKSPACE).describe("SaFE workspace ID"),
      kernel_backends: z.string().default("geak").describe('Comma-separated backends, e.g. "geak"'),
      kernel_backend_models: z.string().default("").describe('Per-backend LLM model overrides, e.g. "claude=claude-opus-4-6"'),
      geak_step_limit: z.number().default(100).describe("GEAK step limit"),
      results_path: z.string().default("/workspace/hyperloom/").describe("Results output path"),
      ray_replica: z.number().default(1).describe("RayJob replicas"),
      ray_gpu: z.number().default(1).describe("GPUs per worker"),
      ray_cpu: z.number().default(32).describe("CPUs per worker"),
      ray_memory: z.number().default(128).describe("Memory (Gi) per worker"),
      mode: z.string().default("local").describe('"local" (GPU sandbox) or "claw" (standard)'),
      baseline_data: z.string().default("").describe("Optional CSV baseline data"),
      target_gpu: z.string().default("").describe('Optional target GPU, e.g. "b300"'),
    },
    async (params) => {
      const prompt = buildHyperloomPrompt({
        modelName: params.model_name,
        modelPath: params.model_path,
        framework: params.framework,
        precision: params.precision,
        isl: params.isl,
        osl: params.osl,
        concurrency: params.concurrency,
        tp: params.tp,
        ep: params.ep,
        gpuType: params.gpu_type,
        image: params.image,
        inferencexPath: params.inferencex_path,
        workspace: params.workspace,
        kernelBackends: params.kernel_backends,
        kernelBackendModels: params.kernel_backend_models,
        geakStepLimit: params.geak_step_limit,
        resultsPath: params.results_path,
        rayReplica: params.ray_replica,
        rayGpu: params.ray_gpu,
        rayCpu: params.ray_cpu,
        rayMemory: params.ray_memory,
        mode: params.mode,
        baselineData: params.baseline_data,
        targetGpu: params.target_gpu,
      });
      return { content: [{ type: "text" as const, text: prompt }] };
    },
  );

  mcp.tool(
    "claw_build_geak_prompt",
    "Build a GEAK kernel optimization prompt",
    {
      files: z.string().describe("Comma-separated kernel file paths to optimize"),
      image: promptImageParam(GEAK_DEFAULT_IMAGE, "GEAK_DEFAULT_IMAGE"),
      api_base: promptApiBaseParam(LITELLM_API_BASE),
      workspace: z.string().default(SAFE_DEFAULT_WORKSPACE).describe("SaFE workspace ID"),
      step_limit: z.number().default(100).describe("GEAK step limit"),
    },
    async (params) => {
      const prompt = buildGeakPrompt({
        files: params.files,
        image: params.image,
        apiBase: params.api_base,
        workspace: params.workspace,
        stepLimit: params.step_limit,
      });
      return { content: [{ type: "text" as const, text: prompt }] };
    },
  );

  return mcp;
}

// ===================== Route Registration =====================

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {

  app.all("/mcp", async (req, reply) => {
    const authHeader = (req.headers.authorization as string) || "";
    const mcp = createMcpServer(app, authHeader);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined as any,
    });
    await mcp.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  logger.info("mcp.routes_registered");
}
