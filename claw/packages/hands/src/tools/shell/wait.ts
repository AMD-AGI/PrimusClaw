// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { currentOwner } from "../../runtime/owner-context.js";
import { waitForShellExit, pollOutput, BG_SHELL_DISABLED_MESSAGE } from "./bg-manager.js";
import { BG_SHELL_ENABLED } from "../../config.js";

/**
 * Why a foreground command may run for twenty seconds but a wait may run for
 * twenty minutes.
 *
 * The foreground ceiling is not there to bound how long work may take -- it is
 * there so that when a run is handed to another Brain replica, no command from
 * the previous owner is still mid-write. That argument is about commands that
 * *do* something. A wait does nothing: abandoning one at any instant costs
 * exactly nothing and leaves nothing half-written, so it is not what the
 * ceiling is protecting against and does not need to share it.
 *
 * Without this the ceiling would be unusable. Pressing foreground commands down
 * to seconds while the only way to await a background job is to poll would cost
 * one LLM turn per interval -- for a two-hour training run, hundreds of turns
 * spent asking "done yet". Parking in a single call costs one.
 */
const WAIT_DEFAULT_SEC = parseInt(process.env.WAIT_DEFAULT_SEC || "300", 10);
const WAIT_MAX_SEC = parseInt(process.env.WAIT_MAX_SEC || "1800", 10);

const schema = {
  shell_id: z.string().describe("Background shell id to wait for, from bash run_in_background=true"),
  timeout_sec: z.number().optional()
    .describe(`Give up waiting after this long and report it is still running (default ${WAIT_DEFAULT_SEC}, max ${WAIT_MAX_SEC})`),
};

export const wait = {
  name: "wait",
  description:
    "Block until a background shell finishes, then return its final output. "
    + "Use this instead of running a long command in the foreground, and instead "
    + "of polling bash_output in a loop. Returns as soon as the shell exits; if "
    + "the timeout is reached first it says so and the shell keeps running, so "
    + "you can simply wait again.",
  zodSchema: schema,
  execute: async (args: { shell_id: string; timeout_sec?: number }) => {
    if (!BG_SHELL_ENABLED) {
      return { content: [{ type: "text" as const, text: `Error: ${BG_SHELL_DISABLED_MESSAGE}` }], isError: true };
    }

    const requested = args.timeout_sec ?? WAIT_DEFAULT_SEC;
    if (!Number.isFinite(requested) || requested <= 0) {
      return {
        content: [{ type: "text" as const, text: `Error: timeout_sec must be a positive number of seconds (default ${WAIT_DEFAULT_SEC})` }],
        isError: true,
      };
    }
    // Clamped rather than refused. The model asking to wait longer than the
    // cap is asking for the right thing; the answer is a shorter wait it can
    // repeat, not an error it has to work around.
    const timeoutSec = Math.min(requested, WAIT_MAX_SEC);

    const owner = currentOwner();
    const pending = waitForShellExit(owner, args.shell_id, timeoutSec * 1000);
    if (!(pending instanceof Promise)) {
      return { content: [{ type: "text" as const, text: `Error: ${pending.error}` }], isError: true };
    }

    const startedAt = Date.now();
    const shell = await pending;
    const waitedSec = Math.round((Date.now() - startedAt) / 1000);

    // The output is read through the ordinary poll so that a wait and a
    // bash_output leave the read offset in the same place: whichever the model
    // used, it has seen the same bytes and the next call continues after them.
    const output = pollOutput(owner, args.shell_id, undefined);

    const header = shell
      ? `Shell ${args.shell_id} finished after ~${waitedSec}s (status=${shell.status}, exit_code=${shell.exitCode ?? "?"})`
      : `Shell ${args.shell_id} is still running after ${waitedSec}s. Call wait again to keep waiting, or kill_shell to stop it.`;

    return {
      content: [{ type: "text" as const, text: `${header}\n\n${output}` }],
      // The same answer as a field rather than a sentence.
      //
      // The text above has always said whether the shell finished, and a caller
      // that is a person or a model reads it. A script cannot: matching prose is
      // how a loop comes to run forever because somebody reworded a header. This
      // is what a repeat step's `until` reads.
      structuredContent: {
        shell_id: args.shell_id,
        finished: !!shell,
        status: shell?.status ?? "running",
        exit_code: shell?.exitCode ?? null,
        waited_sec: waitedSec,
      },
    };
  },
};
