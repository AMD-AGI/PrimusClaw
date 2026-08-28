// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The foreground ceiling, and why a bigger one is not a better one.
 *
 * The ceiling used to be ten hours, on the reading that a longer limit is a
 * more capable tool. It is the other way round. What the ceiling bounds is how
 * long a command that is *writing* can still be in flight, and the argument
 * that makes it safe to hand a run to another Brain replica is that every
 * foreground command the previous owner started has already ended. At ten
 * hours, the window where two replicas can both be driving one workspace is
 * ten hours wide.
 *
 * So the constraint is F <= S < G: the foreground ceiling under the graceful
 * shutdown period, which the Helm chart sets to 300s. F is 120s, equal to the
 * default timeout, which leaves the rest of G for the checkpoint and final
 * workspace sync that can only start once the command has stopped.
 *
 * It was also never reachable: Brain abandons any MCP call at one hour, so a
 * command given a ten-hour timeout died at that boundary reporting a JSON-RPC
 * code, which looks like a fault in the command rather than a limit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
// The real ceiling is 120s, which is pinned on the Brain side where it is put
// in front of the model. Here it is lowered so the clamp can be exercised
// without the suite spending two minutes proving a sleep is still asleep.
const CEILING_SEC = 2;
process.env.BASH_MAX_TIMEOUT_SEC = String(CEILING_SEC);
const { bash } = await import("../src/tools/shell/bash.js");

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

test("a command over the ceiling is cut at it, and told which limit it met", async () => {
  const result = await bash.execute({ command: "sleep 30", timeout: 600 });
  const text = textOf(result as { content: Array<{ text: string }> });

  assert.match(text, new RegExp(`timeout after ${CEILING_SEC}s`),
    "clamped to the ceiling, not run for the 600s asked");
  assert.match(text, /600s was reduced/, "says the request was lowered rather than just failing");
  assert.match(
    text,
    /will not help/,
    "without this the obvious repair is a larger timeout, which is the one "
      + "thing that cannot work",
  );
  // Background shells are off in this file, so the route that does work is a
  // smaller command, not a background one -- naming a tool the deployment
  // refuses is how a model ends up retrying the same call until the turn budget
  // runs out. The other half of this is in bg-shell-ownership, where the flag is
  // on and the message points at run_in_background.
  assert.doesNotMatch(text, /run_in_background/);
  assert.match(text, /Split it into steps/, "names something the model can act on");
  assert.equal((result as { isError?: boolean }).isError, true);
});

test("a command inside the ceiling is untouched", async () => {
  const result = await bash.execute({ command: "echo fine", timeout: 1 });
  assert.match(textOf(result as { content: Array<{ text: string }> }), /fine/);
  assert.equal((result as { isError?: boolean }).isError, undefined);
});

test("hitting the ceiling without having asked for more says so plainly", async () => {
  // No "was reduced" clause here: nothing was reduced, the command simply ran
  // out of its own default, and claiming otherwise would be a false lead.
  const result = await bash.execute({ command: "sleep 3", timeout: 1 });
  const text = textOf(result as { content: Array<{ text: string }> });

  assert.match(text, /timeout after 1s/);
  assert.doesNotMatch(text, /was reduced/);
  assert.match(text, /process group/, "the model must not assume its child survived");
});

test("a nonsense timeout is refused rather than silently defaulted", async () => {
  const result = await bash.execute({ command: "echo hi", timeout: -1 });
  assert.match(textOf(result as { content: Array<{ text: string }> }), /must be a positive number/);
});
