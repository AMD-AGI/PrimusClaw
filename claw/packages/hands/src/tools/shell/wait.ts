// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { currentCallSignal, currentOwner, currentRun } from "../../runtime/owner-context.js";
import {
  waitForShellExit, pollOutput, leaderExitHow, BG_SHELL_DISABLED_MESSAGE, UNKNOWN_SHELL_MESSAGE,
} from "./bg-manager.js";
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
/*
 * Why one wait is nonetheless held under two minutes.
 *
 * A wait is answered by the HTTP request that carries it, and the reply is a
 * single JSON body written when the wait ends -- so nothing reaches the caller
 * until then, not even headers. Every hop in between may give up on a request
 * that has sent nothing: the sandbox Router's port proxy, for one, stops
 * waiting for response headers after 120s and answers 502 "sandbox service
 * unreachable". A wait longer than that limit is not a long wait, it is a
 * failed call; the agent sees an unreachable sandbox, not a running job.
 *
 * Those limits belong to whatever proxy a deployment puts in front of Hands,
 * and none of them is visible from here, so the per-call ceiling sits well
 * under the shortest one known rather than being derived from any. The long
 * wait the argument above is about is still one call per slice: a wait that
 * runs out says the shell is still running, and the caller waits again.
 */
export const WAIT_DEFAULT_SEC = parseInt(process.env.WAIT_DEFAULT_SEC || "100", 10);
export const WAIT_MAX_SEC = parseInt(process.env.WAIT_MAX_SEC || "100", 10);

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
    const run = currentRun();
    const signal = currentCallSignal();
    const pending = waitForShellExit(owner, run, args.shell_id, timeoutSec * 1000, signal);
    // Not a wait at all: the class already settles the question, so the caller
    // is answered now rather than held for the timeout on a shell that can
    // never produce an exit event.
    if (!(pending instanceof Promise)) {
      if (pending.cls === "unknown") {
        return {
          content: [{ type: "text" as const, text: `Error: ${UNKNOWN_SHELL_MESSAGE}` }],
          isError: true,
          structuredContent: { shell_class: "unknown" as const },
        };
      }
      // Through the ordinary poll, for the reason the blocking path below gives:
      // a wait and a bash_output have to leave the read offset in the same
      // place. Skipping it here did both halves of the harm -- the final output
      // of a shell that had already finished was not returned at all, so
      // whether `wait` produced it depended on losing a race with the shell,
      // and the bytes it did not read went at the reap deadline.
      const finishedOutput = pollOutput(owner, run, args.shell_id, undefined);
      const tail = finishedOutput.text ? `\n\n${finishedOutput.text}` : "";

      return {
        content: [{
          type: "text" as const,
          text: `Shell ${args.shell_id} is ${pending.cls}; nothing was waited for${tail}`,
        }],
        structuredContent: {
          shell_id: args.shell_id,
          shell_class: pending.cls,
          // What this call did, so a caller that decided whether to hand back
          // its execution slot can be checked against it rather than trusted.
          blocking: false,
          finished: pending.cls === "finished",
          status: pending.status ?? null,
          exit_code: pending.exitCode ?? null,
          waited_sec: 0,
        },
      };
    }

    const startedAt = Date.now();
    const shell = await pending;
    const waitedSec = Math.round((Date.now() - startedAt) / 1000);

    // The request carrying this wait is gone, so whatever is returned now is
    // written to nobody. Reading the output here would advance the read offset
    // past bytes the caller never received, and the next wait or bash_output
    // would start after them: the shell's output, lost. Left unread, it is
    // all still there for the call that comes next.
    if (signal?.aborted) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: the request carrying this wait ended after ${waitedSec}s; no output was read`,
        }],
        isError: true,
      };
    }

    // The output is read through the ordinary poll so that a wait and a
    // bash_output leave the read offset in the same place: whichever the model
    // used, it has seen the same bytes and the next call continues after them.
    const polled = pollOutput(owner, run, args.shell_id, undefined);

    // A timeout on a shell whose command already returned says so: the wait is
    // for the group, which a command that ends by starting daemons never
    // drains, and "still running" alone hid that the command had finished.
    const leaderExited = polled.structured.leader_exited === true;
    const header = shell
      ? `Shell ${args.shell_id} finished after ~${waitedSec}s (status=${shell.status}, exit_code=${shell.exitCode ?? "?"})`
      : leaderExited
        ? `Shell ${args.shell_id} is still running after ${waitedSec}s, but its command has exited `
          + `(${leaderExitHow({
            exitCode: (polled.structured.leader_exit_code as number | null | undefined) ?? null,
            signal: (polled.structured.leader_signal as string | null | undefined) ?? null,
          })}); what remains are processes it started. `
          + "Waiting again waits for those; kill_shell stops them."
        : `Shell ${args.shell_id} is still running after ${waitedSec}s. Call wait again to keep waiting, or kill_shell to stop it.`;

    return {
      content: [{ type: "text" as const, text: `${header}\n\n${polled.text}` }],
      // The same answer as a field rather than a sentence.
      //
      // The text above has always said whether the shell finished, and a caller
      // that is a person or a model reads it. A script cannot: matching prose is
      // how a loop comes to run forever because somebody reworded a header. This
      // is what a repeat step's `until` reads.
      structuredContent: {
        shell_id: args.shell_id,
        shell_class: polled.structured.shell_class,
        blocking: true,
        finished: !!shell,
        status: shell?.status ?? "running",
        exit_code: shell?.exitCode ?? null,
        waited_sec: waitedSec,
        ...(leaderExited && !shell ? {
          leader_exited: true,
          leader_exit_code: polled.structured.leader_exit_code ?? null,
          leader_signal: polled.structured.leader_signal ?? null,
        } : {}),
      },
    };
  },
};
