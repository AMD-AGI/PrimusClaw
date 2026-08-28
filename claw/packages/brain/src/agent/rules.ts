// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { RULES_ENABLED, RULES_DIR } from "../config.js";
import pino from "pino";

const logger = pino({ name: "rules" });

let _cachedRules: string | null = null;

/** Load and concatenate all .md rule files from RULES_DIR. Cached after first load. */
export function loadRules(): string {
  if (_cachedRules !== null) return _cachedRules;
  if (!RULES_ENABLED || !fs.existsSync(RULES_DIR)) {
    _cachedRules = "";
    return "";
  }

  const parts: string[] = [];
  const walkMd = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkMd(full); continue; }
      if (!entry.name.endsWith(".md")) continue;
      try {
        const text = fs.readFileSync(full, "utf-8").trim();
        if (text) parts.push(text);
      } catch { /* skip */ }
    }
  };
  walkMd(RULES_DIR);

  _cachedRules = parts.join("\n\n");
  if (_cachedRules) logger.info({ count: parts.length, chars: _cachedRules.length }, "rules.loaded");
  return _cachedRules;
}
