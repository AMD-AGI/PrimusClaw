// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B36 -- the mixed-version window must not open a cross-run door.
 *
 * A sandbox whose Hands predates the record scheme resolves read, wait and kill
 * by owner scope and id alone. Brain stamping a run header changes nothing
 * there: an older Hands does not read it, so two run identities sharing an
 * owner -- a later message in a conversation, a sibling node under one graph
 * root -- could name one id and reach each other's shells for as long as it
 * answers. N10.2.1's first negative case has no mixed-version exemption.
 *
 * Exercised through `HandsClient` against a sandbox shaped like each version,
 * because the boundary is only real if the transform is on the call path the
 * model's tool calls actually take.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { HandsClient } from "../src/clients/hands.js";
import { decodeKeyPart } from "@claw/protocol";
import { bindShellRecordsCapabilityForTest } from "../src/clients/hands.js";
import { bindBgHandleRowsForTest } from "../src/sandbox/bg-row-store.js";

let restoreRows: (() => void) | null = null;
let restoreCapability: (() => void) | null = null;

afterEach(() => {
  restoreRows?.();
  restoreCapability?.();
  restoreRows = null;
  restoreCapability = null;
});

/** Which sandbox version this client is talking to. */
function sandboxOfVersion(filesRecords: boolean | "unreachable"): void {
  restoreCapability = bindShellRecordsCapabilityForTest(async () => {
    if (filesRecords === "unreachable") throw new Error("unreachable");
    return filesRecords;
  });
}

/**
 * A client wired to a recording stand-in for the MCP transport.
 *
 * The transport is replaced rather than stubbed at a seam of its own: what is
 * under test is which arguments leave Brain, so the substitution has to sit
 * exactly where the SDK call does.
 */
function clientFor(run: string): { hands: HandsClient; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const hands = new HandsClient("http://sandbox:9100/mcp", "tok", "sess-shared", run);
  (hands as unknown as { connected: boolean }).connected = true;
  (hands as unknown as { client: unknown }).client = {
    callTool: async ({ arguments: args }: { arguments: Record<string, unknown> }) => {
      sent.push(args);
      return { content: [{ type: "text", text: `Started background shell ${args.shell_id}.` }] };
    },
  };
  return { hands, sent };
}

test("against a pre-scheme sandbox, two runs cannot name one shell", async () => {
  // No rows bound: the transform alone is what makes the boundary hold, so this
  // is the weakest configuration it has to hold in.
  restoreRows = bindBgHandleRowsForTest(null);
  sandboxOfVersion(false);

  const mine = clientFor("ktsk_1");
  const theirs = clientFor("ktsk_2");
  await mine.hands.callTool("bash", { command: "train", run_in_background: true, shell_id: "server" });
  await theirs.hands.callTool("bash_output", { shell_id: "server" });

  assert.notEqual(mine.sent[0].shell_id, "server",
    "an unqualified id is the address an owner-keyed registry cannot partition");
  assert.notEqual(mine.sent[0].shell_id, theirs.sent[0].shell_id,
    "'server' is the obvious name and both runs will pick it; the wire form is "
      + "what keeps them apart on a sandbox that cannot");

  const [runPart, idPart] = String(mine.sent[0].shell_id).split(".");
  assert.equal(decodeKeyPart(runPart), "ktsk_1");
  assert.equal(decodeKeyPart(idPart), "server", "and the public id is carried whole, never truncated");
});

test("a start with no id of its own is still addressable afterwards", async () => {
  // The common start: the caller names nothing and the sandbox mints an id. Left
  // that way against an owner-keyed registry, the id that comes back is one
  // Brain never qualified, and every later poll or kill qualifies it into
  // something that sandbox never stored. Brain fixes the id before the dispatch
  // instead, so the value it addresses with is the value that was stored.
  restoreRows = bindBgHandleRowsForTest(null);
  sandboxOfVersion(false);

  const { hands, sent } = clientFor("ktsk_1");
  const started = await hands.callTool("bash", { command: "train", run_in_background: true });

  const publicId = /background shell (\S+?)\./.exec(started)![1];
  assert.match(publicId, /^bg-[0-9a-f]{12}$/,
    "in the sandbox's own shape, and derived rather than minted so a replay "
      + "recovers the same one");
  const onTheWire = String(sent[0].shell_id);
  assert.notEqual(onTheWire, publicId, "qualified going out");

  await hands.callTool("bash_output", { shell_id: publicId });
  assert.equal(String(sent[1].shell_id), onTheWire,
    "and a later read resolves to exactly the id the sandbox stored");

  await hands.callTool("kill_shell", { shell_id: publicId });
  assert.equal(String(sent[2].shell_id), onTheWire);
});

test("the model is never shown the wire form, so it can poll with what it sent", async () => {
  restoreRows = bindBgHandleRowsForTest(null);
  sandboxOfVersion(false);

  const { hands, sent } = clientFor("ktsk_1");
  const text = await hands.callTool(
    "bash", { command: "train", run_in_background: true, shell_id: "server" },
  );

  assert.match(text, /Started background shell server\./);
  assert.ok(!text.includes(String(sent[0].shell_id)),
    "left in the text, the qualified id becomes what the model sends back -- and "
      + "Brain would qualify it a second time, addressing a shell that does not exist");
});

test("against a record-writing sandbox the id goes out untouched", async () => {
  // There the run identity is part of the address the sandbox itself resolves,
  // so qualifying would be a second boundary over one that already holds.
  restoreRows = bindBgHandleRowsForTest(null);
  sandboxOfVersion(true);

  const { hands, sent } = clientFor("ktsk_1");
  await hands.callTool("bash", { command: "train", run_in_background: true, shell_id: "server" });
  assert.equal(sent[0].shell_id, "server");
});

test("a sandbox that cannot be asked is treated as the more restrictive version", async () => {
  restoreRows = bindBgHandleRowsForTest(null);
  sandboxOfVersion("unreachable");

  const { hands, sent } = clientFor("ktsk_1");
  await hands.callTool("kill_shell", { shell_id: "server" });
  assert.notEqual(sent[0].shell_id, "server",
    "guessing the permissive way round costs the boundary; guessing this way "
      + "costs at most a qualified id a newer Hands would have taken plain");
});

test("an id predating the transform is answered as never-issued, not served verbatim", async () => {
  // Such a shell went out unqualified, so a qualified lookup finds nothing --
  // which is the answer it has to get: it carries no recorded run identity, and
  // serving it verbatim would let any run of one owner reach it.
  restoreRows = bindBgHandleRowsForTest(null);
  sandboxOfVersion(false);

  const { hands, sent } = clientFor("ktsk_1");
  await hands.callTool("kill_shell", { shell_id: "started-before-the-upgrade" });

  assert.notEqual(sent[0].shell_id, "started-before-the-upgrade");
});

test("a foreground call carries no shell id and is left alone", async () => {
  restoreRows = bindBgHandleRowsForTest(null);
  sandboxOfVersion(false);

  const { hands, sent } = clientFor("ktsk_1");
  await hands.callTool("bash", { command: "ls" });
  assert.deepEqual(sent[0], { command: "ls" });
});
