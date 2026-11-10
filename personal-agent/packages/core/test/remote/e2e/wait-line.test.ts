// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A message that waits for the terminal on the machine says why in the floating status (teams/tests/test_direct_chat.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FakeRemote } from "../../../../../test-support/remote-fake.js";
import type { Recorded } from "../../../../../test-support/surface.js";
import { ALICE, type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";

/** The live view's waits stay virtual, but a wait of more than a minute (the stream's own closing before the chat's limit) does
 * not come within a test: a turn of a few events is not a turn of nine minutes. */
function neverPastAMinute(w: RemoteWorld): void {
  const virtual = w.virtual.sleep.bind(w.virtual);
  w.virtual.sleep = (ms, signal) =>
    ms > 60_000
      ? new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        })
      : virtual(ms, signal);
}

const informative = (outbox: readonly Recorded[]): string[] =>
  outbox.flatMap((r) => (r.op === "stream.inform" ? [r.text] : []));

test("a message waiting for a busy terminal says why in the floating status not only thinking", () =>
  remoteWorld(
    async (w) => {
      let free = (): void => undefined;
      const freed = new Promise<void>((resolve) => {
        free = resolve;
      });
      neverPastAMinute(w);
      const work = async (srv: FakeRemote, sid: string): Promise<void> => {
        await srv.emit(sid, "terminal_input_queued", { reason: "terminal_working", cmd_seq: 1, queued: 1 });
        await freed;
        await srv.tool(sid, "t1", "make test");
        await srv.say(sid, "All 312 tests pass.");
        await srv.end(sid);
      };
      const script = new Script();
      const tasks: Promise<void>[] = [];
      // (the connector answers the prompt at once; the terminal takes it later)
      script.onPrompt = (srv, sid) => {
        tasks.push(work(srv, sid));
        return Promise.resolve();
      };
      w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
      w.server.onCommand = script.hook;
      await w.say("/agent new claude /home/me/repo");
      assert.ok(w.test.store.remoteState.attachedRemote(AAD), w.said().join("\n"));
      w.setLang(AAD, "zh");
      const said = w.say("run the tests");
      const waitLine = "⏳ 已排队";
      // (the terminal is let go whatever happens: a turn left waiting would keep the world from closing)
      const shown = await w
        .until(() => informative(w.surface.outbox).some((t) => t.includes(waitLine)))
        .then(() => informative(w.surface.outbox).length)
        .finally(free);
      await said;
      await Promise.all(tasks);
      // (the turn's own words then fill the bubble; no later status says it still waits)
      const later = informative(w.surface.outbox).slice(shown);
      assert.ok(!later.some((t) => t.includes(waitLine)), later.join(" | "));
      const finals = w.surface.outbox.flatMap((r) => (r.op === "stream.finish" ? [r] : []));
      const last = finals.at(-1);
      assert.ok(last && JSON.stringify(last.message).includes("All 312 tests pass."), JSON.stringify(finals));
    },
    { direct: true, streaming: true },
  ));
