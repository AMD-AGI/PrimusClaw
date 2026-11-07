// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run by tmp-cleanup.test.ts as a test file of its own, under a TMPDIR of its own: it sets up what the suite sets up
 * (a harness with an attach agent, one with a session open, and directories from `tmpdir`) and ends the way TMP_FIXTURE_END says:
 *   pass   the test passes and the file's hooks run
 *   fail   the test fails and the file's hooks run
 *   exit   the process exits in the middle of the test, so no hook runs
 * Before it ends it writes the directories it made, and the adapters it started (one by a session, one below a wrapper
 * that has exited), to TMP_FIXTURE_REPORT (outside that TMPDIR).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { ChildRegistry } from "../../src/children.js";
import { Harness, tmpdir } from "./harness.js";
import { liveTmpdirs } from "./tmp.js";

const end = process.env.TMP_FIXTURE_END ?? "pass";

test("the suite's setup", async () => {
  const attach = await Harness.create({ attach: { sessions: [] } });
  await attach.online();
  // A session starts an adapter: a detached process writing into the home, which must not outlive the file. Some real
  // adapters do not leave when their stdin closes; this one is told not to either. The home is a folder inside a
  // temporary directory, not one itself, as in the tests that start a connector without the harness.
  const h = await Harness.create({ home: path.join(tmpdir("cc-nest-"), "home"), env: { FAKE_SURVIVE_EOF: "1" } });
  await h.newSession();
  const recorded = (): number[] => {
    try { return (JSON.parse(fs.readFileSync(path.join(h.dirs.state, "children.json"), "utf8")) as Array<{ pid: number }>).map((r) => r.pid); } catch { return []; }
  };
  const adapters = await h.claw.until("children.json to name the adapter", () => (recorded().length > 0 ? recorded() : undefined));
  // A wrapper (`npx` and the like) that started the agent and left: the recorded leader is gone, its group lives on.
  const reg = new ChildRegistry(path.join(tmpdir("cc-wrap-"), "state", "children.json"));
  const wrapper = spawn("sh", ["-c", "sleep 300 & echo $!; read _"], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  reg.add({ pid: wrapper.pid!, pgid: wrapper.pid!, agent_id: "wrapped", session_id: "s" });
  const agent = Number(await new Promise<string>((r) => wrapper.stdout!.once("data", (d) => r(String(d).trim()))));
  wrapper.stdin!.end();
  await new Promise((r) => wrapper.once("exit", r));
  wrapper.stdout!.destroy();
  adapters.push(agent);
  fs.writeFileSync(`${h.work}/file`, "x");
  tmpdir("cc-claudecfg-");
  tmpdir("cc-fakecli-");
  tmpdir("w-");
  fs.writeFileSync(process.env.TMP_FIXTURE_REPORT!, JSON.stringify({ dirs: liveTmpdirs(), adapters }));
  if (end === "exit") process.exit(3);
  if (end === "fail") throw new Error("this test fails on purpose");
});
