// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * NF9 end to end: a real command, stopped by a real ceiling, counted by Brain.
 *
 * The unit test fabricates the result the sandbox would have produced, which
 * proves the counting and not the signal: the two halves are in different
 * packages and either could stop naming the same thing without the other
 * noticing. Here a genuine Hands process runs a command past its ceiling, the
 * result crosses MCP, and Brain's counter is read afterwards.
 *
 * A real child process and a real port, because what is under test is exactly
 * the boundary a stand-in would replace.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HandsClient } from "../src/clients/hands.js";
import { registry } from "../src/infra/metrics.js";

const HANDS_DIST = fileURLToPath(new URL("../../hands/dist/index.js", import.meta.url));
const CEILING_SEC = 2;
const TOKEN = "e2e-internal-token";

let hands: ChildProcess | null = null;
let workspace = "";
let stateDir = "";
let port = 0;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, () => {
    const { port: p } = s.address() as { port: number };
    s.close(() => resolve(p));
  });
});

async function counted(clamped: "true" | "false"): Promise<number> {
  const metric = (await registry.getMetricsAsJSON())
    .find((m) => m.name === "claw_bash_foreground_timeout_total") as
      { values?: Array<{ labels: Record<string, string>; value: number }> };
  return metric?.values?.find((v) => v.labels.clamped === clamped)?.value ?? 0;
}

before(async () => {
  // Loud rather than skipped: a suite that quietly passes without the binary it
  // is about is the shape of test this one exists to replace.
  assert.ok(existsSync(HANDS_DIST), `${HANDS_DIST} not built -- run npm run build first`);

  workspace = mkdtempSync(join(tmpdir(), "claw-e2e-ws-"));
  stateDir = mkdtempSync(join(tmpdir(), "claw-e2e-state-"));
  port = await freePort();
  hands = spawn(process.execPath, [HANDS_DIST], {
    env: {
      ...process.env,
      WORKSPACE_PATH: workspace,
      HANDS_STATE_DIR: stateDir,
      MCP_PORT: String(port),
      AUTH_CLAW_TOKEN: TOKEN,
      BG_SHELL_ENABLED: "false",
      BASH_MAX_TIMEOUT_SEC: String(CEILING_SEC),
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    assert.ok(Date.now() < deadline, "Hands never came up");
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  hands?.kill("SIGKILL");
  for (const dir of [workspace, stateDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a command the sandbox clamps and kills reaches Brain's counter", async () => {
  const before = await counted("true");
  const client = new HandsClient(`http://127.0.0.1:${port}/mcp`, TOKEN, "sess-e2e", "ktsk_1");

  // Asks past the ceiling, so the sandbox clamps it -- which is the regression a
  // tightened ceiling produces and the one the rollout watches for.
  const text = await client.callTool("bash", { command: "sleep 30", timeout: 600 });
  await client.close();

  assert.match(text, new RegExp(`timeout after ${CEILING_SEC}s`));
  assert.match(text, /was reduced/, "clamped, not merely out of its own time");
  assert.equal(await counted("true"), before + 1,
    "the signal is emitted where the timeout happens and crosses MCP as a field, "
      + "so neither side can stop naming the same thing unnoticed");
});

test("a command that runs out of its own timeout is counted apart, end to end", async () => {
  const beforeClamped = await counted("true");
  const before = await counted("false");
  const client = new HandsClient(`http://127.0.0.1:${port}/mcp`, TOKEN, "sess-e2e", "ktsk_1");

  const text = await client.callTool("bash", { command: "sleep 30", timeout: 1 });
  await client.close();

  assert.match(text, /timeout after 1s/);
  assert.equal(await counted("false"), before + 1);
  assert.equal(await counted("true"), beforeClamped,
    "nothing was reduced, so it is not evidence about the ceiling");
});
