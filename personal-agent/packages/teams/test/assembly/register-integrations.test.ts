// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `WorkerOptions.registerIntegrations`: a deployment's assembly registers its MCP servers and /whoami lines as the worker
 * is built, on top of the plugins' own. And the built worker's /metrics carries `personal_agent_build_info`. The real
 * `buildWorker` through the release gate's test entry.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  integrationRegistry,
  noIntegrations,
  silentLogger,
  type IntegrationRegistry,
} from "@primusclaw/personal-agent";

import { buildWorker, withRegistered } from "../../src/assembly/worker.js";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "os4a-integrations-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("what the options register joins the plugins' integrations, after them; without a hook they are left as given", () => {
  const given = integrationRegistry();
  given.addMcpServer("Dispatch", "Dispatch", { query: true });
  given.addConnectionLine(() => "first");
  assert.equal(withRegistered(given, undefined), given);
  const merged = withRegistered(given, (registry) => {
    registry.addMcpServer("Pulse", "Pulse");
    registry.addConnectionLine((_owner, lang) => `second ${lang}`);
  });
  assert.deepEqual(
    [...merged.mcpServers],
    [
      ["dispatch", "Dispatch"],
      ["pulse", "Pulse"],
    ],
  );
  assert.deepEqual([...merged.queryServers], ["dispatch"]);
  assert.deepEqual(
    merged.connectionLines.map((line) => line(undefined, "en")),
    ["first", "second en"],
  );
  // (the plugins' own registry is not changed)
  assert.deepEqual([...given.mcpServers.keys()], ["dispatch"]);
  assert.equal(withRegistered(noIntegrations, () => undefined).mcpServers.size, 0);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return typeof address === "object" && address !== null ? address.port : 0;
}

it("buildWorker calls registerIntegrations once as it builds, and its /metrics names the build", async () => {
  const metricsPort = await freePort();
  const env = {
    TEAMS_ENCRYPTION_KEYS: "x".repeat(43) + "=",
    TEAMS_DB_PATH: join(dir, "state.db"),
    PUBLIC_BASE_URL: "https://claw.example.com",
    CLAW_API_URL: "http://claw.invalid",
    SAFE_API_URL: "http://safe.invalid/api/v1",
    OUTBOUND_MODE: "direct",
    BOT_MSI_CLIENT_ID: "x",
    SECRETS_SOURCE: "env",
    TEAMS_GATE_ENTRY: "1",
    GATE_RUN_ID: "integrations-test",
    TEAMS_GATE_CONNECTOR_URL: "http://127.0.0.1:9",
    PORT: String(await freePort()),
    METRICS_PORT: String(metricsPort),
  };
  const registries: IntegrationRegistry[] = [];
  const own = integrationRegistry();
  own.addMcpServer("dispatch", "Dispatch");
  const worker = await buildWorker(env, () => ({ integrations: own }), {
    logger: silentLogger,
    registerIntegrations: (registry) => {
      registries.push(registry);
      registry.addMcpServer("pulse", "Pulse");
    },
  });
  assert.equal(registries.length, 1);
  // (the registry it was given already held the plugins' own servers, and took the deployment's after them)
  const held = registries[0] as unknown as { mcpServers: ReadonlyMap<string, string> };
  assert.deepEqual([...held.mcpServers.keys()], ["dispatch", "pulse"]);
  const running = worker.run();
  try {
    let text = "";
    for (let i = 0; i < 100 && text === ""; i++) {
      text = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`).then(
        (r) => (r.ok ? r.text() : ""),
        () => "",
      );
      if (text === "") await delay(50);
    }
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    assert.ok(
      text.includes(`\npersonal_agent_build_info{version="${pkg.version}",node="${process.version}"} 1\n`),
      text,
    );
  } finally {
    await worker.stop();
    await running;
  }
});
