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
  entryPoints: [join(root, "src/cli.ts")],
  outfile: join(root, "dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@agentclientprotocol/sdk", "smol-toml", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
chmodSync(join(root, "dist/cli.js"), 0o755);
