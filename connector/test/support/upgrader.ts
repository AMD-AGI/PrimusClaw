// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** An AutoUpgrader that stops at the decision to upgrade: no npm, no prefix, a download made of one package.json. */
import fs from "node:fs";
import path from "node:path";
import { AutoUpgrader, upgradeTiming, type Layout, type StageResult } from "../../src/auto-upgrade.js";
import type { Dirs } from "../../src/paths.js";
import { silentLogger } from "../../src/util.js";
import { tmpdir } from "./tmp.js";

const LAYOUT: Layout = { pkgDir: "/nowhere/lib/node_modules/@primusclaw/connector", prefix: "/nowhere", cli: "/nowhere/cli.js", node: process.execPath, npm: ["npm"], npmShown: "npm" };

export function stubUpgrader(dirs: Dirs, o: { version?: string; idleMs?: number; retryMs?: number } = {}): { up: AutoUpgrader; preflights: string[]; stages: string[] } {
  const preflights: string[] = [];
  const stages: string[] = [];
  const up = new AutoUpgrader({
    dirs, env: {}, version: o.version ?? "1.0.0", supervised: true, cli: LAYOUT.cli, node: process.execPath, log: silentLogger,
    timing: { ...upgradeTiming({}), checkMs: 30, idleMs: o.idleMs ?? 150, retryMs: o.retryMs ?? 300 },
    layout: async () => LAYOUT,
    preflight: async (_l, target) => { preflights.push(target); return null; },
    stage: async (_l, target): Promise<StageResult> => {
      stages.push(target);
      const prefix = tmpdir();
      const pkgDir = path.join(prefix, "pkg");
      fs.mkdirSync(pkgDir);
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: target }));
      return { staged: { version: target, prefix, pkgDir } };
    },
  });
  return { up, preflights, stages };
}
