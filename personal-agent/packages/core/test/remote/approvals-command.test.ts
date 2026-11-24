// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `/approvals [on|off]`: the person's switch for the questions their own terminals ask, read and set at Claw; `mute|unmute #<item>` for one conversation. */
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
    muteTerminal: (key, item, muted) => {
      calls.push(`mute ${key} ${String(item)} ${String(muted)}`);
      if (fail) return Promise.reject(fail);
      return Promise.resolve({ item, muted, machine: "laptop", title: "修 CI" });
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

test("mute and unmute #<item> name one terminal conversation, with the person's own key, and say what was muted", async () => {
  const r = rig();
  await r.command.run(r.route(), "mute #12");
  assert.equal(
    r.said.at(-1),
    "Muted #12 (laptop · 修 CI): what that conversation asks, waits for or finishes stays in its terminal. `/approvals unmute #12` brings it back.",
  );
  await r.command.run(r.route("zh"), "UNMUTE 12");
  assert.equal(r.said.at(-1), "已恢复 #12（laptop · 修 CI）：这个会话的提问和完成会重新推到这里。");
  assert.deepEqual(r.calls, ["mute ak-1 12 true", "mute ak-1 12 false"]);
  // a number that is not one is the usage, and nothing is asked
  await r.command.run(r.route(), "mute #x");
  assert.match(r.said.at(-1) ?? "", /approvals mute #12/);
  assert.equal(r.calls.length, 2);
});

test("an item that is not theirs, or not a terminal conversation, is said as such; Claw out of reach says so", async () => {
  const gone = rig(true, new ClawError(404, JSON.stringify({ ok: false, error: "item_not_found" })));
  await gone.command.run(gone.route(), "mute #7");
  assert.equal(gone.said.at(-1), "I have no item #7 of yours.");
  const other = rig(true, new ClawError(409, JSON.stringify({ ok: false, error: "not_a_terminal_item" })));
  await other.command.run(other.route("zh"), "mute #7");
  assert.equal(other.said.at(-1), "#7 不是你终端里打开的会话，没有可静音的。");
  const down = rig(true, new ClawError(503, "{}"));
  await down.command.run(down.route(), "unmute #7");
  assert.match(down.said.at(-1) ?? "", /could not reach/);
});
