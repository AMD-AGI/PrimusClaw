// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run by tmp-cleanup.test.ts as a test file of its own, under a TMPDIR of its own: it sets up what the suite sets up
 * (a harness with an attach agent, online, and directories from `tmpdir`) and ends the way TMP_FIXTURE_END says:
 *   pass   the test passes and the file's hooks run
 *   fail   the test fails and the file's hooks run
 *   exit   the process exits in the middle of the test, so no hook runs
 * Before it ends it writes the directories it made to TMP_FIXTURE_REPORT (outside that TMPDIR).
 */
import fs from "node:fs";
import test from "node:test";
import { Harness, tmpdir } from "./harness.js";
import { liveTmpdirs } from "./tmp.js";

const end = process.env.TMP_FIXTURE_END ?? "pass";

test("the suite's setup", async () => {
  const h = await Harness.create({ attach: { sessions: [] } });
  await h.online();
  fs.writeFileSync(`${h.work}/file`, "x");
  tmpdir("cc-claudecfg-");
  tmpdir("cc-fakecli-");
  tmpdir("w-");
  fs.writeFileSync(process.env.TMP_FIXTURE_REPORT!, JSON.stringify(liveTmpdirs()));
  if (end === "exit") process.exit(3);
  if (end === "fail") throw new Error("this test fails on purpose");
});
