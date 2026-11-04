// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Which commands the signal handlers belong to: only `run` takes over Ctrl-C. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { processStart } from "../src/children.js";
import { sleep } from "../src/util.js";
import { FakeIdentity } from "./support/fake-identity.js";
import { tmpdir } from "./support/harness.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** Run the CLI as its own process (node + tsx, so the pid we signal is the CLI itself). */
function start(args: string[], home: string) {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], { env: { ...process.env, CLAW_CONNECTOR_HOME: home }, stdio: "ignore" });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited };
}

test("Ctrl-C ends a login that is waiting for the browser, at once", async () => {
  const id = await FakeIdentity.start();
  id.pollScript = ["authorization_pending"];
  const { child, exited } = start(["login", "--server", "https://claw.example/api", "--identity-url", id.url], tmpdir());
  try {
    const t0 = Date.now();
    while (!id.requests.some((r) => r.path === "/oauth/device_authorization")) {
      assert.ok(Date.now() - t0 < 20_000, "the login never started");
      await sleep(50);
    }
    child.kill("SIGINT");
    const end = await Promise.race([exited, sleep(4000).then(() => null)]);
    assert.ok(end, "login ignored Ctrl-C");
    assert.ok(end.signal === "SIGINT" || end.code === 130 || end.code === 1, JSON.stringify(end));
  } finally {
    if (processStart(child.pid!) !== null) child.kill("SIGKILL");
    await id.close();
  }
});
