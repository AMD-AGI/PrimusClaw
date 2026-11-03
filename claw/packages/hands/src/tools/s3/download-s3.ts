// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { WORKSPACE } from "../../config.js";

const downloadItem = z.object({
  local_path: z.string(),
  presigned_url: z.string(),
  // The object's size: a file already there with this size is not fetched again.
  size: z.number().int().nonnegative().optional(),
});

const schema = {
  files: z.array(downloadItem).describe("Array of {local_path, presigned_url} to download"),
};

function sizeOf(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * The first symbolic link on the way from the workspace root to `p`, if any.
 *
 * Hands writes as its own identity, which can differ from the one the model's
 * commands run as, and a download into a sandbox that is already running (the
 * uploads a reused sandbox is given) lands where links made there point. Only
 * the part below the workspace root is checked: the root itself is the
 * deployment's to place.
 */
function linkOnTheWay(p: string): string | null {
  const root = path.resolve(WORKSPACE);
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  let at = root;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch {
      return null;   // nothing there yet: the rest is created below, as directories
    }
    if (st.isSymbolicLink()) return at;
  }
  return null;
}

/**
 * Counterpart to upload_to_s3 — pulls files from S3 into the sandbox using
 * pre-signed GET URLs. Same zero-credential model: Brain signs, Hands fetches.
 * Returns a structured JSON envelope so Brain can retry failures.
 */
export const downloadS3 = {
  name: "download_from_s3",
  description: "Download files from S3 using pre-signed GET URLs (no S3 credentials needed)",
  zodSchema: schema,
  execute: async (args: { files: Array<{ local_path: string; presigned_url: string; size?: number }> }) => {
    const ok: string[] = [];
    const failed: Array<{ path: string; status: number; error: string }> = [];
    for (const file of args.files) {
      try {
        const safePath = guardPath(file.local_path);
        if (file.size !== undefined && sizeOf(safePath) === file.size) {
          ok.push(file.local_path);
          continue;
        }
        const resp = await fetch(file.presigned_url);
        if (!resp.ok) {
          failed.push({ path: file.local_path, status: resp.status, error: (await resp.text().catch(() => "")).slice(0, 200) });
          continue;
        }
        const body = Buffer.from(await resp.arrayBuffer());
        const link = linkOnTheWay(safePath);
        if (link) {
          failed.push({ path: file.local_path, status: 0, error: `not written: ${link} is a symbolic link` });
          continue;
        }
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        // O_NOFOLLOW: a link put in the file's place after the check is not followed either.
        const fd = fs.openSync(safePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
        try { fs.writeFileSync(fd, body); } finally { fs.closeSync(fd); }
        ok.push(file.local_path);
      } catch (e: any) {
        failed.push({ path: file.local_path, status: 0, error: e?.message || String(e) });
      }
    }
    const result = { ok, failed, total: args.files.length };
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
};
