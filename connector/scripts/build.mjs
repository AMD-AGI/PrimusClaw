// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Bundles the CLI into one file. The wire contract is compiled in from
// claw/packages/protocol (see src/protocol.ts), so the published package has no
// second copy of it to drift; the runtime dependencies stay external and are
// installed from the registry.
import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist"), { recursive: true });
await build({
  // The hook is its own, small bundle: SessionStart waits for it, so it must not load the connector's dependencies.
  entryPoints: [join(root, "src/cli.ts"), join(root, "src/terminal-hook.ts")],
  outdir: join(root, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@agentclientprotocol/sdk", "smol-toml", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
chmodSync(join(root, "dist/cli.js"), 0o755);
chmodSync(join(root, "dist/terminal-hook.js"), 0o755);
