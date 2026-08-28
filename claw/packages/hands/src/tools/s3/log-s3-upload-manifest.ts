// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { z } from "zod";

const schema = {
  sessionId: z.string(),
  s3Prefix: z.string(),
  files: z.array(z.string()).describe("Workspace-local paths selected for upload"),
};

function logManifestEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level: 30,
    time: Date.now(),
    name: "s3-uploader",
    ...fields,
  }));
}

/**
 * Internal Brain->Hands tool that records the upload manifest in hands.log.
 *
 * It intentionally logs only workspace-local paths and the destination prefix,
 * never presigned URLs. Keeping this as a native Hands tool avoids passing
 * untrusted file names through a shell command just to append to hands.log.
 */
export const logS3UploadManifest = {
  name: "log_s3_upload_manifest",
  description: "Log the workspace file manifest selected for S3 upload",
  zodSchema: schema,
  execute: async (args: { sessionId: string; s3Prefix: string; files: string[] }) => {
    logManifestEvent({
      msg: "s3.upload.manifest",
      sessionId: args.sessionId,
      s3Prefix: args.s3Prefix,
      totalFiles: args.files.length,
    });
    args.files.forEach((path, index) => {
      logManifestEvent({
        msg: "s3.upload.manifest.file",
        sessionId: args.sessionId,
        index,
        path,
      });
    });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: true, totalFiles: args.files.length }),
      }],
    };
  },
};
