// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A connector's refusal codes are told as what happened and what to do, never as the bare code, through the chat
// (teams/tests/test_connector_reasons.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import { decode } from "../../../src/remote/events.js";
import { queuedLine } from "../../../src/remote/lines.js";
import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import { ALICE, Script, WORLD_ERRORS, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD } from "./helpers.js";
import { Refusing } from "./menu.js";

const CLAUDE = [["claude", "claude", "Claude Code"]] as const;

test("a refused command is decoded with its type and reason", () => {
  const step = decode(
    {
      name: "command_rejected",
      id: "1",
      data: { data: { type: "set_mode", cmd_id: "c", reason: "mode_unavailable" } },
    },
    WORLD_ERRORS,
  );
  assert.deepEqual(step.rejected, { type: "set_mode", reason: "mode_unavailable", cmdSeq: null });
  const named = decode(
    { name: "command_rejected", id: "2", data: { data: { type: "prompt", cmd_seq: 7, reason: "cancelled" } } },
    WORLD_ERRORS,
  );
  assert.equal(named.rejected?.cmdSeq, 7, "a refusal names its prompt by Claw's number");
  assert.equal(step.finished, false);
  assert.equal(step.closed, null);
});

test("a new session refused with mode unavailable says what to do not the code", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", CLAUDE, { version: "0.1.4" });
    w.server.onCommand = new Refusing("mode_unavailable").hook;
    await w.say("/agent new claude /repo");
    const said = w.last();
    assert.ok(
      said.startsWith("The session could not start: The agent on that machine does not offer the permission mode"),
      said,
    );
    assert.ok(!said.includes("mode_unavailable"));
    assert.ok(
      said.includes("npm install -g @primusclaw/connector@latest") && said.includes('env = { IS_SANDBOX = "1" }'),
      said,
    );
    assert.ok(said.endsWith("Your messages go to PrimusClaw again."), said);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

test("the same refusal from a fixed connector offers no upgrade", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", CLAUDE, { version: "0.1.5" });
    w.server.onCommand = new Refusing("mode_unavailable").hook;
    await w.say("/agent new claude /repo");
    assert.ok(!w.last().includes("npm install") && w.last().includes("claw-connector status"), w.last());
  }));

test("a refusal is said in chinese to a person answered in chinese", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    w.server.addConnector(ALICE, "dev-pod", CLAUDE);
    w.server.onCommand = new Refusing("cwd_outside_roots").hook;
    await w.say("/agent new claude /repo");
    assert.equal(
      w.last(),
      "会话没能启动：这个目录不在该 agent 允许的 roots 里。换一个 roots 里的目录，或在 agents.toml 的 `roots` 里加上它" +
        "并重启连接器。 你的消息会重新发给 PrimusClaw。",
    );
  }));

/** A connector that refuses every mode switch. */
class RefusingModes extends Script {
  protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    if (cmd.type !== "set_mode") return super.handle(srv, cmd);
    await srv.emit(cmd.session_id, "command_rejected", {
      type: "set_mode",
      cmd_id: cmd.body["cmd_id"] ?? null,
      reason: "mode_not_allowed",
    });
  }
}

test("a refused mode switch says why", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", CLAUDE);
    w.server.onCommand = new RefusingModes().hook;
    await w.say("/agent new claude /repo");
    assert.notEqual(w.test.store.remoteState.attachedRemote(AAD), null, w.said().join(" | "));
    await w.say("/agent mode plan");
    await w.until(() => w.said().some((t) => t.includes("did not switch")));
    const said = w.said().find((t) => t.includes("did not switch")) ?? "";
    assert.ok(said.includes('set `approval = "never"`') && !said.includes("mode_not_allowed"), said);
  }));

test("a session that ends while idle says why in words", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", CLAUDE);
    w.server.onCommand = new Script().hook;
    await w.say("/agent new claude /repo");
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    await w.server.emit(sid, "session_closed", { reason: "adapter_gone" });
    await w.until(() => w.said().some((t) => t.includes("The session ended")));
    const said = w.said().find((t) => t.includes("The session ended")) ?? "";
    assert.ok(said.startsWith("The session ended: The agent program on that machine has exited."), said);
    assert.ok(!said.includes("adapter_gone"));
    assert.ok(said.includes("Your messages go to PrimusClaw again."), said);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

test("a session claw closed with its machine says why in words", async () => {
  for (const [reason, words] of [
    ["machine_reconnected", "That machine registered again"],
    ["connector_revoked", "That machine's connector was signed out"],
  ] as const) {
    await remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "dev-pod", CLAUDE);
      w.server.onCommand = new Script().hook;
      await w.say("/agent new claude /repo");
      const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
      await w.server.emit(sid, "session_closed", { reason, by: "claw" });
      await w.until(() => w.said().some((t) => t.includes("The session ended")));
      const said = w.said().find((t) => t.includes("The session ended")) ?? "";
      assert.ok(said.startsWith(`The session ended: ${words}`) && !said.includes(reason), said);
      assert.ok(!said.includes("do not know"));
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    });
  }
});

for (const [reason, words] of [
  ["terminal_working", "已排队"],
  ["terminal_typing", "输入框"],
  ["terminal_dialog", "弹窗"],
  ["terminal_screen", "等终端"],
  ["something_new", "等终端"],
] as const) {
  test(`a message waiting for its terminal says why in the chat language: ${reason}`, () => {
    const step = decode(
      { name: "terminal_input_queued", data: { data: { reason, cmd_seq: 7 } }, id: "9" },
      WORLD_ERRORS,
    );
    assert.equal(step.queued, reason);
    assert.equal(step.finished, false);
    const zh = queuedLine(step.queued, "zh");
    assert.ok(zh.includes(words), zh);
    assert.notEqual(queuedLine(step.queued, "en"), zh);
  });
}
