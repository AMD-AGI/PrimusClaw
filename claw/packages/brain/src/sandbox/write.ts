// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { HandsClient } from "../clients/hands.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface SandboxUploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
  total: number;
  failures: Array<{ file: string; error: string }>;
  skips: Array<{ file: string; reason: string }>;
}

type SandboxWriteEncoding = "utf8" | "base64";

/**
 * Returns true when a relative path is safe to materialize under a sandbox base directory.
 */
export function isSafeRelativePath(relPath: string): boolean {
  return !!relPath && !relPath.startsWith("/") && !relPath.split(/[\\/]+/).includes("..");
}

/**
 * Encodes a local file for the Hands write tool, preserving binary data via base64.
 */
export function encodeFileForSandbox(absPath: string): { contents: string; encoding: SandboxWriteEncoding } {
  const raw = fs.readFileSync(absPath);
  try {
    return { contents: utf8Decoder.decode(raw), encoding: "utf8" };
  } catch {
    return { contents: raw.toString("base64"), encoding: "base64" };
  }
}

/**
 * Recursively lists regular files under a local directory.
 */
export function listRegularFiles(localDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(localDir)) return out;
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const full = path.join(localDir, entry.name);
    if (entry.isDirectory()) out.push(...listRegularFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Writes a file through Hands and fails loudly if the tool returned an error payload.
 */
export async function writeFileToSandbox(
  hands: HandsClient,
  targetPath: string,
  contents: string,
  encoding: SandboxWriteEncoding = "utf8",
): Promise<void> {
  const result = (await hands.callTool("write", { path: targetPath, contents, encoding })).trim();
  if (result.startsWith("Error writing ")) {
    throw new Error(result);
  }
}

/**
 * Writes a text file through Hands and fails loudly if the tool returned an error payload.
 */
export async function writeTextFileToSandbox(
  hands: HandsClient,
  targetPath: string,
  contents: string,
): Promise<void> {
  await writeFileToSandbox(hands, targetPath, contents, "utf8");
}

/**
 * Uploads every regular file in a local directory into the sandbox.
 */
export async function uploadDirToSandbox(
  hands: HandsClient,
  localDir: string,
  sandboxBase: string,
): Promise<SandboxUploadResult> {
  const files = listRegularFiles(localDir);
  const result: SandboxUploadResult = {
    uploaded: 0,
    skipped: 0,
    failed: 0,
    total: files.length,
    failures: [],
    skips: [],
  };

  for (const absPath of files) {
    const rel = path.relative(localDir, absPath).split(path.sep).join("/");
    if (!isSafeRelativePath(rel)) {
      result.skipped++;
      result.skips.push({ file: rel, reason: "unsafe_path" });
      continue;
    }

    const targetPath = path.posix.join(sandboxBase, rel);
    const encoded = encodeFileForSandbox(absPath);
    try {
      await writeFileToSandbox(hands, targetPath, encoded.contents, encoded.encoding);
      result.uploaded++;
    } catch (err: any) {
      result.failed++;
      result.failures.push({ file: rel, error: err.message });
    }
  }

  return result;
}
