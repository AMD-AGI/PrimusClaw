// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";

const uploadItem = z.object({
  local_path: z.string(),
  presigned_url: z.string(),
});

const schema = {
  files: z.array(uploadItem).describe("Array of {local_path, presigned_url} to upload"),
};

function logUploadEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level: 30,
    time: Date.now(),
    name: "hands-upload-s3",
    ...fields,
  }));
}

/**
 * Returns a structured JSON envelope so Brain can tell ok vs failed uploads
 * and retry the failed subset. Body stays under `content[0].text` to keep the
 * MCP text-only contract; callers JSON.parse it.
 */
export const uploadS3 = {
  name: "upload_to_s3",
  description: "Upload workspace files to S3 using pre-signed PUT URLs (no S3 credentials needed)",
  zodSchema: schema,
  execute: async (args: { files: Array<{ local_path: string; presigned_url: string }> }) => {
    const ok: string[] = [];
    const failed: Array<{ path: string; status: number; error: string }> = [];
    logUploadEvent({ msg: "s3.upload.batch_start", totalFiles: args.files.length });
    for (const file of args.files) {
      const startedAt = Date.now();
      try {
        const safePath = guardPath(file.local_path);
        const body = fs.readFileSync(safePath);
        logUploadEvent({
          msg: "s3.upload.file_start",
          path: file.local_path,
          sizeBytes: body.byteLength,
        });
        const resp = await fetch(file.presigned_url, {
          method: "PUT",
          body,
          headers: { "Content-Type": "application/octet-stream" },
        });
        if (resp.ok) {
          ok.push(file.local_path);
          logUploadEvent({
            msg: "s3.upload.file_done",
            path: file.local_path,
            status: resp.status,
            sizeBytes: body.byteLength,
            durationMs: Date.now() - startedAt,
          });
        } else {
          const error = (await resp.text().catch(() => "")).slice(0, 300);
          failed.push({ path: file.local_path, status: resp.status, error });
          logUploadEvent({
            msg: "s3.upload.file_failed",
            path: file.local_path,
            status: resp.status,
            sizeBytes: body.byteLength,
            durationMs: Date.now() - startedAt,
            error,
          });
        }
      } catch (e: any) {
        const error = String(e?.message || e).slice(0, 300);
        failed.push({ path: file.local_path, status: 0, error });
        logUploadEvent({
          msg: "s3.upload.file_failed",
          path: file.local_path,
          status: 0,
          durationMs: Date.now() - startedAt,
          error,
        });
      }
    }
    const result = { ok, failed, total: args.files.length };
    logUploadEvent({
      msg: "s3.upload.batch_done",
      ok: ok.length,
      failed: failed.length,
      total: args.files.length,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
};
