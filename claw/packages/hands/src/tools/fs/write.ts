// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";

const schema = {
  path: z.string().describe("File path (relative to workspace)"),
  contents: z.string().describe("File contents to write"),
  encoding: z.enum(["utf8", "base64"]).optional().describe("Content encoding; base64 writes raw bytes"),
};

/**
 * Decodes base64 only when it is syntactically valid, avoiding silent Buffer truncation.
 */
function decodeBase64Strict(contents: string): Buffer {
  const normalized = contents.replace(/\s+/g, "");
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized);
  if (!validBase64) throw new Error("Invalid base64 contents");
  return Buffer.from(normalized, "base64");
}

export const write = {
  name: "write",
  description: "Write contents to a file in the workspace. Creates parent directories if needed.",
  zodSchema: schema,
  execute: async (args: { path: string; contents: string; encoding?: "utf8" | "base64" }) => {
    try {
      const safePath = guardPath(args.path);
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      if (args.encoding === "base64") {
        fs.writeFileSync(safePath, decodeBase64Strict(args.contents));
      } else {
        fs.writeFileSync(safePath, args.contents, "utf-8");
      }
      return { content: [{ type: "text" as const, text: `Written to ${args.path}` }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error writing ${args.path}: ${e.message}` }] };
    }
  },
};
