// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `deliver_file`: hand a file from the sandbox to the user.
 *
 * The user cannot reach the sandbox, so a path in an answer is not a file they
 * have. This copies the file, as it is now, to the session's delivery directory
 * in the object store (see `@claw/protocol` deliveries.ts) and reports it on the
 * tool's terminal event, where a client shows a download for it. The download
 * itself is the API's (`GET /v1/sessions/:id/deliveries/:id`), for the signed-in
 * owner only.
 *
 * The copy is made by Hands with a presigned PUT, as the workspace sync does, so
 * the object-store credentials never enter the sandbox.
 */
import crypto from "node:crypto";
import path from "node:path";
import {
  DELIVERY_INLINE_MAX_BYTES, DELIVERY_INLINE_TYPES, deliveryContentType, deliveryKeyPrefix, type Delivery, type ToolSchema,
} from "@claw/protocol";
import type { HandsClient } from "../clients/hands.js";
import { presignPut } from "../workspace/s3-uploader.js";

export const DELIVER_FILE_TOOL = "deliver_file";

const WORKSPACE = "/workspace";
const CAPTION_MAX = 300;
const STAT_TIMEOUT_SEC = 15;
/** Printed in front of each answer of the probe so it is told from anything else the shell says. */
const STAT_MARK = "__claw_deliver_stat__";
const REAL_MARK = "__claw_deliver_real__";
const DATA_MARK = "__claw_deliver_data__";
const STAT_LINE = new RegExp(`^${STAT_MARK}(regular (?:empty )?file|[a-z ]+)\\|(\\d+)$`, "m");

export function deliverFileSchema(): ToolSchema {
  return {
    name: DELIVER_FILE_TOOL,
    description: "Give the user a file from the workspace: they get a download (an image may be shown inline). "
      + "The user cannot open paths in the sandbox, so use this for every file they asked for or should keep "
      + "(a report, chart, spreadsheet, document, archive) instead of only naming its path. "
      + "The file is copied as it is now; deliver it again after changing it.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file, under /workspace (absolute, or relative to /workspace)" },
        caption: { type: "string", description: "One line shown with the file; optional" },
      },
      required: ["path"],
    },
  };
}

/** The absolute sandbox path for `input`, or null when it is not a file path under /workspace. */
export function workspaceFilePath(input: unknown): string | null {
  // No control characters: the probe's answer is read line by line.
  if (typeof input !== "string" || !input.trim() || /[\x00-\x1f\x7f]/.test(input)) return null;
  const resolved = path.posix.resolve(WORKSPACE, input.trim());
  return resolved.startsWith(`${WORKSPACE}/`) ? resolved : null;
}

/** One single-quoted shell word. */
function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The name a delivery is stored and offered under: the base name, without characters that break a header or a line. */
function deliveryName(file: string): string {
  const name = path.posix.basename(file).replace(/[\x00-\x1f\x7f"\\/]/g, "_");
  return name || "file";
}

export interface DeliverContext {
  /** The owner segment of the session prefix (`users/<id>/sessions/<sid>/`), as the workspace sync builds it. */
  userId: string;
  sessionId: string;
  maxBytes: number;
}

export type DeliverOutcome =
  | { ok: true; delivery: Delivery; text: string }
  | { ok: false; error: string };

/** Seams for tests: the presigner and the id. */
export const deliverPorts = {
  presignPut: (key: string) => presignPut(key),
  newId: () => crypto.randomUUID(),
};

/**
 * The two paths `realpath -ez` printed (the workspace, then the file), or none:
 * exactly two NUL-terminated names, each valid UTF-8 as it is, since the path
 * Hands is handed must be byte for byte the one that was checked.
 */
function resolvedPaths(probe: string): string[] {
  const line = new RegExp(`^${REAL_MARK}([A-Za-z0-9+/=]+)$`, "m").exec(probe)?.[1];
  if (!line) return [];
  const raw = Buffer.from(line, "base64");
  if (raw.length === 0 || raw[raw.length - 1] !== 0) return [];
  const names = raw.subarray(0, raw.length - 1).toString("utf8").split("\0");
  if (names.length !== 2 || names.some((n) => !n)) return [];
  return Buffer.from(names.join("\0") + "\0", "utf8").equals(raw) ? names : [];
}

/** A small image's bytes, base64, read from the path that was copied; null when they cannot be read as that size. */
async function inlineData(hands: HandsClient, real: string, size: number, signal?: AbortSignal): Promise<string | null> {
  const out = await hands.callTool("bash", {
    command: `printf '${DATA_MARK}%s\\n' "$(base64 -w0 -- ${shellWord(real)})"`,
    timeout: STAT_TIMEOUT_SEC,
  }, signal);
  const data = new RegExp(`^${DATA_MARK}([A-Za-z0-9+/=]*)$`, "m").exec(out)?.[1] ?? "";
  return data && Buffer.from(data, "base64").length === size ? data : null;
}

/** The file a `deliver_file` path names, as the sandbox resolves it: a regular file under /workspace, with its size. */
export type WorkspaceFile = { ok: true; file: string; real: string; size: number } | { ok: false; error: string };

/**
 * Resolve `rawPath` as `deliver_file` does: a path under /workspace, existing, a regular file, and still under /workspace once its
 * links are followed (`real`, the path every later read and copy uses).
 */
export async function workspaceFile(hands: HandsClient, rawPath: unknown, signal?: AbortSignal): Promise<WorkspaceFile> {
  const file = workspaceFilePath(rawPath);
  if (!file) return { ok: false, error: "Error: path must name a file under /workspace." };

  // What the file is, and where it really is: a link under /workspace may point anywhere in the sandbox, and Hands
  // reads whatever the path it is given resolves to, so the resolved path is checked and is what gets copied.
  const probe = await hands.callTool("bash", {
    command: `stat -L -c '${STAT_MARK}%F|%s' -- ${shellWord(file)} 2>&1`
      // NUL-separated and base64-wrapped: a link target may hold any byte but NUL, a newline included.
      + ` && printf '${REAL_MARK}%s\\n' "$(realpath -ez -- ${WORKSPACE} ${shellWord(file)} | base64 -w0)"`,
    timeout: STAT_TIMEOUT_SEC,
  }, signal);
  const stat = STAT_LINE.exec(probe);
  if (!stat) return { ok: false, error: `Error: ${file} does not exist or cannot be read.` };
  const [root, real] = resolvedPaths(probe);
  if (!root || !real || !real.startsWith(`${root}/`)) {
    return { ok: false, error: `Error: ${file} resolves to a file outside /workspace; deliver a file in the workspace.` };
  }
  if (!stat[1].startsWith("regular")) return { ok: false, error: `Error: ${file} is a ${stat[1]}, not a file. Deliver one file (zip a directory first).` };
  return { ok: true, file, real, size: Number(stat[2]) };
}

export async function deliverFile(
  hands: HandsClient,
  ctx: DeliverContext,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DeliverOutcome> {
  const found = await workspaceFile(hands, input.path, signal);
  if (!found.ok) return found;
  const { file, real, size } = found;
  const captionIn = typeof input.caption === "string" ? input.caption.replace(/\s+/g, " ").trim() : "";
  const caption = captionIn.slice(0, CAPTION_MAX);
  if (size > ctx.maxBytes) {
    return { ok: false, error: `Error: ${file} is ${size} bytes; at most ${ctx.maxBytes} can be delivered. Compress or split it.` };
  }

  const id = deliverPorts.newId();
  const name = deliveryName(file);
  const key = `${deliveryKeyPrefix(`users/${ctx.userId}/sessions/${ctx.sessionId}/`, id)}${name}`;
  const raw = await hands.callTool("upload_to_s3", {
    files: [{ local_path: real, presigned_url: await deliverPorts.presignPut(key) }],
  }, signal);
  let uploaded = false;
  let reason = "";
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown; failed?: Array<{ error?: string }> };
    uploaded = Array.isArray(parsed.ok) && parsed.ok.includes(real);
    reason = parsed.failed?.[0]?.error ?? "";
  } catch {
    reason = raw.slice(0, 200);
  }
  if (!uploaded) return { ok: false, error: `Error: ${file} could not be copied for delivery${reason ? `: ${reason}` : ""}.` };

  const contentType = deliveryContentType(name);
  const inline = DELIVERY_INLINE_TYPES.includes(contentType) && size <= DELIVERY_INLINE_MAX_BYTES
    ? await inlineData(hands, real, size, signal) : null;
  const delivery: Delivery = {
    id, name, size, content_type: contentType, ...(caption ? { caption } : {}), ...(inline ? { data_base64: inline } : {}),
  };
  return { ok: true, delivery, text: `Delivered ${name} (${size} bytes) to the user as a download.` };
}
