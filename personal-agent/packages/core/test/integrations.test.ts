// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { integrationRegistry, noIntegrations } from "../src/plugins/integrations.js";

test("a deployment registers its MCP servers and its /whoami lines, and the public build has none", () => {
  const registry = integrationRegistry();
  registry.addMcpServer("JobService", "Job Service", { query: true });
  registry.addMcpServer("fleet", "Fleet");
  registry.addConnectionLine((owner, lang) =>
    lang === "zh" ? `作业：${owner?.name ?? "?"}` : `Jobs: ${owner?.name ?? "?"}`,
  );
  assert.deepEqual(
    [...registry.mcpServers],
    [
      ["jobservice", "Job Service"],
      ["fleet", "Fleet"],
    ],
  );
  assert.deepEqual([...registry.queryServers], ["jobservice"]);
  const [line] = registry.connectionLines;
  assert.ok(line !== undefined);
  assert.equal(line(undefined, "en"), "Jobs: ?");
  assert.equal(line({ id: "u", name: "Ann", email: "", accountType: "sso" }, "zh"), "作业：Ann");
  assert.equal(
    noIntegrations.mcpServers.size + noIntegrations.queryServers.size + noIntegrations.connectionLines.length,
    0,
  );
});
