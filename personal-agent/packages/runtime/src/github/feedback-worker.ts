// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a report says about the deployment (feedback's `WorkerInfo`), read at start as the Python worker read it in
 * `FeedbackService.collect`: the worker's version is its package's own (`importlib.metadata.version(...)`, "unknown"
 * when it cannot be read), and the image tags are WORKER_IMAGE_TAG, CLAW_API_IMAGE_TAG and CLAW_BRAIN_IMAGE_TAG
 * (`_env_tag`: stripped; a tag that is not one becomes "unknown" when the scene is built).
 */
import { readFileSync } from "node:fs";

import { pyStrip, type WorkerInfo } from "@primusclaw/personal-agent";

/** The environment variables a report's image tags come from. */
type ImageTagName = "WORKER_IMAGE_TAG" | "CLAW_API_IMAGE_TAG" | "CLAW_BRAIN_IMAGE_TAG";

/**
 * The `version` of a package.json (the worker's own package: whoever assembles the worker passes its URL), "unknown"
 * when the file cannot be read or names no version.
 */
export function packageVersion(packageJson: URL): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** The deployment as a report names it. */
export function workerInfoFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  worker: { readonly pluginId: string; readonly version: string },
): WorkerInfo {
  const tag = (name: ImageTagName): string => pyStrip(env[name] ?? "");
  return {
    pluginId: worker.pluginId,
    version: worker.version,
    workerImage: tag("WORKER_IMAGE_TAG"),
    apiImage: tag("CLAW_API_IMAGE_TAG"),
    brainImage: tag("CLAW_BRAIN_IMAGE_TAG"),
  };
}
