// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A script step that reads a JSON file feeds a capture a later step digs into
 * with `${captures.<key>.<field>}`, which parses the capture as JSON. Hands'
 * `read` numbers its lines for the model, and a numbered document does not
 * parse, so the field resolved to nothing and the later step ran without it.
 * The read here is Hands' own tool over a real file, not a model of it.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecuteRequest, ScriptStep } from "@claw/protocol";

import { runScript } from "../src/tasks/script-runner.js";
import { read } from "../../hands/src/tools/fs/read.js";

const dir = mkdtempSync(join(tmpdir(), "claw-script-read-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function hands() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      callToolFull: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "read") {
          const out = await read.execute(args as Parameters<typeof read.execute>[0]);
          return { text: out.content[0].text, structured: undefined, isError: false };
        }
        return { text: "ok", structured: undefined, isError: false };
      },
    } as never,
  };
}

function request(script: ScriptStep[]): ExecuteRequest {
  return {
    session_id: "s-1", task_id: "t-1", message_id: "m-1", user_id: "u-1", mode: "script", script,
  } as unknown as ExecuteRequest;
}

test("a field of a JSON file a script read resolves in the next step", async () => {
  const path = join(dir, "job.json");
  writeFileSync(path, `${JSON.stringify({ job: { id: "j-42" } }, null, 2)}\n`);
  const h = hands();
  const result = await runScript(request([
    { name: "read", arguments: { path }, captures: "cfg" },
    { name: "bash", arguments: { command: "echo ${captures.cfg.job.id}" } },
  ] as ScriptStep[]), { hands: h.client }, async () => {});
  assert.equal(result.failureReason, undefined);
  assert.equal(h.calls[1].args.command, "echo j-42");
  assert.deepEqual(JSON.parse(result.captures!.cfg), { job: { id: "j-42" } });
});

test("a script that asks for numbered lines still gets them", async () => {
  const path = join(dir, "notes.txt");
  writeFileSync(path, "one\ntwo");
  const h = hands();
  const result = await runScript(request([
    { name: "read", arguments: { path, line_numbers: true }, captures: "notes" },
  ] as ScriptStep[]), { hands: h.client }, async () => {});
  assert.equal(result.captures!.notes, "1|one\n2|two");
});
