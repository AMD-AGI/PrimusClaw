// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Only `claw-connector stop` stops a supervised connector for good. A SIGTERM from anywhere else (a bare `kill`, a
 * container runtime) used to end the run with exit 0, which the supervisor took for a stop on purpose: it exited too,
 * and the machine stayed offline until the next keepalive.sh (seen on a development container, 2026-11-07).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, main, type Ctx } from "../src/commands.js";
import { pidFile, resolveDirs } from "../src/paths.js";
import { supervise } from "../src/service.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function runPid(c: Ctx): number | null {
  try { return (JSON.parse(fs.readFileSync(pidFile(c.dirs), "utf8")) as { pid: number }).pid; } catch { return null; }
}

async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test("a stray SIGTERM restarts a supervised run (exit 75); claw-connector stop ends it and the supervisor", async () => {
  const claw = await FakeClaw.start();
  const home = tmpdir("ss-");
  const work = tmpdir("ss-w-");
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  fs.writeFileSync(path.join(home, "config", "agents.toml"), `[[agents]]\nid = "fake"\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(ADAPTER)}]\nask_mode = "default"\nroots = [${JSON.stringify(work)}]\n`);
  const err: string[] = [];
  const c: Ctx = {
    dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv),
    env: { ...process.env, CLAW_CONNECTOR_HOME: home },
    out: () => {}, err: (l) => err.push(l), hostname: "box",
  };
  claw.tokens.add("good-token");
  assert.equal(await main(["login", "--server", claw.url, "--key", "good-token"], c), EXIT.ok);
  const sup = supervise(c, { command: [process.execPath, ["--import", "tsx", cli, "run", "--supervised"]], restartMs: 50 });
  try {
    const first = await until("the first run", () => runPid(c));
    await claw.until("online", () => claw.online, 20_000);
    process.kill(first, "SIGTERM");
    const second = await until("a run started again after the stray SIGTERM", () => { const p = runPid(c); return p !== null && p !== first ? p : null; });
    assert.notEqual(second, first);
    assert.match(err.join("\n"), /the connector ended \(exit 75\); restarting/);
    assert.equal(await main(["stop"], c), EXIT.ok);
    const code = await Promise.race([sup, sleep(20_000).then(() => "still running")]);
    assert.equal(code, 0, "the supervisor ends after claw-connector stop");
    assert.match(err.join("\n"), /stopped on purpose \(exit 0\); not restarting/);
  } finally {
    const p = runPid(c);
    if (p !== null) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    await claw.close();
  }
});
