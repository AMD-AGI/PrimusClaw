// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Prompt template builders for Hyperloom / GEAK optimization tasks.
 * Ported from the Python v1 MCP — logic-identical, typed.
 */

import {
  HYPERLOOM_DEFAULT_IMAGE,
  GEAK_DEFAULT_IMAGE,
  LITELLM_API_BASE,
  SAFE_DEFAULT_WORKSPACE,
} from "../config.js";

function requirePromptImage(image: string | undefined, envName: string): string {
  const resolved = image?.trim();
  if (!resolved) {
    throw new Error(`${envName} is not configured; pass image explicitly`);
  }
  return resolved;
}

export interface HyperloomPromptOpts {
  modelName: string;
  modelPath: string;
  framework?: string;
  precision?: string;
  isl?: number;
  osl?: number;
  concurrency?: number;
  tp?: number;
  ep?: number;
  gpuType?: string;
  image?: string;
  inferencexPath?: string;
  workspace?: string;
  kernelBackends?: string;
  kernelBackendModels?: string;
  geakStepLimit?: number;
  resultsPath?: string;
  rayReplica?: number;
  rayGpu?: number;
  rayCpu?: number;
  rayMemory?: number;
  mode?: string;
  baselineData?: string;
  targetGpu?: string;
}

export function buildHyperloomPrompt(opts: HyperloomPromptOpts): string {
  const {
    modelName,
    modelPath,
    framework = "sglang",
    precision = "FP4",
    isl = 1024,
    osl = 1024,
    concurrency = 64,
    tp = 1,
    ep = 1,
    gpuType = "MI355X",
    image = HYPERLOOM_DEFAULT_IMAGE,
    inferencexPath = "/hyperloom/InferenceX",
    workspace = SAFE_DEFAULT_WORKSPACE,
    kernelBackends = "geak",
    kernelBackendModels = "",
    geakStepLimit = 100,
    resultsPath = "/workspace/hyperloom/",
    rayReplica = 1,
    rayGpu = 1,
    rayCpu = 32,
    rayMemory = 128,
    mode = "local",
    baselineData = "",
    targetGpu = "",
  } = opts;
  const promptImage = requirePromptImage(image, "HYPERLOOM_DEFAULT_IMAGE");

  const backends = kernelBackends.split(",").map((b) => b.trim());
  const hasGeak = backends.some((b) => b.toLowerCase().includes("geak"));
  const backendPrompt = backends.join(", ");

  const backendModelsMap: Record<string, string> = {};
  for (const pair of kernelBackendModels.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const [bk, mid] = trimmed.split("=", 2);
    if (bk?.trim() && mid?.trim()) {
      backendModelsMap[bk.trim().toLowerCase()] = mid.trim();
    }
  }

  const pathParts = modelPath.trim().split("/").filter(Boolean);
  const sharedRoot = pathParts.length ? `/${pathParts[0]}` : "/hyperloom";

  const lines: string[] = [];

  lines.push(
    `Use the inference-optimization skill to optimize ${modelName.toLowerCase()} inference performance.`,
  );
  lines.push(`mode: ${mode}`);
  lines.push("");

  lines.push("Configuration:");
  lines.push(`Model path: ${modelPath}`);
  lines.push(`Framework: ${framework}`);
  lines.push(`Precision: ${precision}`);
  lines.push(`Inference params: ISL=${isl}, OSL=${osl}, CONC=${concurrency}`);
  lines.push(`TP=${tp}, EP=${ep}`);
  lines.push(`GPU type: ${gpuType}`);
  lines.push(`InferenceX path: ${inferencexPath}`);
  lines.push("");

  if (mode === "local") {
    lines.push(`SandboxImage: ${promptImage}`);
    lines.push("");
  }

  if (mode === "claw") {
    const envAccessors = ["RayJob"];
    if (hasGeak) envAccessors.push("GEAK");
    envAccessors.push("TraceLens");

    lines.push("Environment:");
    lines.push(`The current runtime (Claw client) cannot access ${sharedRoot} directly`);
    lines.push(`${envAccessors.join(" / ")} can all access ${sharedRoot}`);
    lines.push(
      "The default Python on the Claw client does not have the ray package; use /opt/ray-venv/bin/python3 to execute ray_submit.py",
    );
    lines.push("");

    lines.push("Task submission:");
    lines.push(`RayJob${hasGeak ? " and kernel tasks" : ""} submit to the ${workspace} workspace`);
    lines.push(`RayJob image: ${promptImage}`);
    lines.push(
      `RayJob resources: ${rayReplica} replica, ${rayGpu} GPU, ${rayCpu} CPU, ${rayMemory}Gi memory, 500Gi ephemeral`,
    );
    lines.push("");
  }

  lines.push("Kernel Optimization:");
  lines.push(`KERNEL_OPT_BACKENDS: ${backendPrompt}`);
  for (const bk of backends) {
    const norm = bk.toLowerCase();
    if (norm in backendModelsMap) {
      lines.push(`KERNEL_OPT_${norm.toUpperCase()}_MODEL: ${backendModelsMap[norm]}`);
    }
  }
  if (hasGeak) {
    lines.push(`GEAK image: ${promptImage}`);
    lines.push(`GEAK_WORKSPACE: ${workspace}`);
    lines.push(`GEAK step_limit: ${geakStepLimit}`);
  }
  lines.push("Must optimize at least 5 kernels");
  lines.push("");

  lines.push("Requirements:");
  lines.push(`Save all results and the optimization report to ${resultsPath}`);
  lines.push("Execute the full skill pipeline (Phase 0-10), including parameter sweep.");

  if (targetGpu && baselineData) {
    lines.push("");
    lines.push("InferenceX Baseline:");
    lines.push(`Target GPU: ${targetGpu}`);
    lines.push("Raw performance values:");
    lines.push(baselineData);
    lines.push(
      `Optimize and push ahead of ${targetGpu}. Use InferenceX data from Hyperloom as starting point for ${framework} ${gpuType.toLowerCase()} baseline.`,
    );
  }

  return lines.join("\n");
}

export interface GeakPromptOpts {
  files: string;
  image?: string;
  apiBase?: string;
  workspace?: string;
  stepLimit?: number;
}

export function buildGeakPrompt(opts: GeakPromptOpts): string {
  const {
    files,
    image = GEAK_DEFAULT_IMAGE,
    apiBase = LITELLM_API_BASE,
    workspace = SAFE_DEFAULT_WORKSPACE,
    stepLimit = 100,
  } = opts;
  const promptImage = requirePromptImage(image, "GEAK_DEFAULT_IMAGE");
  const resolvedApiBase = apiBase?.trim() ?? "";
  if (!resolvedApiBase) {
    throw new Error("LITELLM_API_BASE is not configured; pass apiBase explicitly");
  }

  const fileList = files.split(",").map((f) => f.trim()).filter(Boolean);
  const filesBlock = fileList.length
    ? fileList.map((f) => `   - ${f}`).join("\n")
    : "   - (TBD)";

  const sessionId = process.env.SESSION_ID || "";
  let extraHeadersBlock = "";
  if (sessionId) {
    const metadata = JSON.stringify({ session_id: sessionId, component: "geak" });
    extraHeadersBlock = [
      "    extra_headers:",
      '      x-litellm-tags: "product:primus-claw,component:geak"',
      `      x-litellm-spend-logs-metadata: '${metadata}'`,
    ].join("\n");
  }

  return `Set up and run a GEAK kernel optimization task with the following configuration, Replace ANTHROPIC_AUTH_TOKEN in environment variables:

model_config:
  model_class: "litellm"
  model_name: "openai/claude-opus-4-6"
  model_kwargs:
    max_tokens: 16384
    api_base: "${resolvedApiBase}"
    api_key: "\${ANTHROPIC_AUTH_TOKEN}"
${extraHeadersBlock}

task:
  input_type: "file"

  files:
${filesBlock}

  prompt: |
    Optimize this Triton kernel for AMD MI355X (gfx950, CDNA4).

    The kernel MUST be optimized to at least 1.5x speedup.
    Use homogeneous mode. Set max_rounds to 1.
    Do NOT search the filesystem with find / or grep -r /.

    MANDATORY CONSTRAINTS:
    1. Output function name MUST be EXACTLY: {original_function_name}
    2. Function signature MUST be IDENTICAL to the original.
    3. Do NOT add @triton.autotune or change decorators.

    Write the COMPLETE file to the output directory.

  image: "${promptImage}"

  workspace_id: "${workspace}"
  step_limit: ${stepLimit}

Detect all files in the kernel's directory; any useful files should be sent to GEAK MCP.
Check the logs of the currently submitted task every minute until the task is completed. Tell me the final optimization results.`;
}
