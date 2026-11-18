// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `/approvals [on|off]`: the person's switch for the questions their own terminals ask, read and set at Claw. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError } from "../../src/claw/errors.js";
import { TerminalApprovalsCommand } from "../../src/remote/approvals-command.js";
import type { CommandRoute } from "../../src/ports/routing.js";

function rig(start = true, fail?: Error) {
  let enabled = start;
  const calls: string[] = [];
  const said: string[] = [];
  const command = new TerminalApprovalsCommand({
    approvals: (key) => {
      calls.push(`get ${key}`);
      return fail ? Promise.reject(fail) : Promise.resolve(enabled);
    },
    setApprovals: (key, on) => {
      calls.push(`put ${key} ${String(on)}`);
      if (fail) return Promise.reject(fail);
      enabled = on;
      return Promise.resolve(enabled);
    },
  });
  const route = (lang: "en" | "zh" = "en") =>
    ({
      credential: "ak-1",
      lang: () => lang,
      conversation: {
        send: (m: { body: { text: string } }) => {
          said.push(m.body.text);
          return Promise.resolve();
        },
      },
    }) as unknown as CommandRoute;
  return { command, calls, said, route };
}

test("with no word it says which it is; on and off set it with the person's own key", async () => {
  const r = rig();
  assert.equal(r.command.name, "approvals");
  assert.equal(await r.command.run(r.route(), ""), true);
  assert.match(r.said.at(-1) ?? "", /are on/);
  await r.command.run(r.route(), " OFF ");
  assert.match(r.said.at(-1) ?? "", /Turned off/);
  await r.command.run(r.route("zh"), "on");
  assert.match(r.said.at(-1) ?? "", /已开启/);
  assert.deepEqual(r.calls, ["get ak-1", "put ak-1 false", "put ak-1 true"]);
});

test("any other word gets the usage and changes nothing; Claw refusing says so", async () => {
  const r = rig();
  await r.command.run(r.route(), "maybe");
  assert.match(r.said.at(-1) ?? "", /approvals on/);
  assert.deepEqual(r.calls, []);
  const bad = rig(true, new ClawError(503, "{}"));
  await bad.command.run(bad.route(), "off");
  assert.match(bad.said.at(-1) ?? "", /could not reach/);
});
