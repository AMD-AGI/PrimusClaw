// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { spawnBackground } from "./bg-manager.js";
import { currentOwner, currentRun } from "../../runtime/owner-context.js";
import { runForegroundShell } from "./process-runner.js";
import { BG_SHELL_ENABLED } from "../../config.js";

const MAX_OUTPUT_BYTES = parseInt(process.env.BASH_OUTPUT_BYTES || `${10 * 1024 * 1024}`, 10);
const DEFAULT_TIMEOUT_SEC = parseInt(process.env.BASH_DEFAULT_TIMEOUT_SEC || "120", 10);

/**
 * The foreground ceiling, F in the handover constraint F <= S < G.
 *
 * It used to be ten hours, on the reading that a longer ceiling is a more
 * capable one. That has it backwards. The ceiling's job is to bound how long a
 * command that is *writing* can still be in flight, because when a run moves to
 * another Brain replica the safety argument is that every foreground command
 * the previous owner started has already ended. A ten-hour ceiling means the
 * window in which two replicas can both be driving the same workspace is ten
 * hours wide.
 *
 * G is the graceful shutdown period, 300s in the Helm chart. F is set to 120s:
 * equal to the default timeout, so nothing that does not explicitly ask for
 * more is affected, and leaving most of G for the checkpoint and final
 * workspace sync that have to happen after the command stops.
 *
 * Ten hours was also never reachable. Brain abandons any MCP call at one hour,
 * so a command given a longer timeout died at that boundary and reported a
 * JSON-RPC code, which is the confusion this removes rather than preserves.
 *
 * All of which holds only while long work has somewhere else to go. With
 * background shells off, `run_in_background` is refused and `wait` says so, so a
 * 120s ceiling would mean nothing slower than two minutes can run by any route
 * -- most builds, most test suites, every training run. So the ceiling follows
 * its escape hatch: F where there is one, and the old ten hours where there is
 * not. Brain applies the same rule and forwards the result, so the number the
 * model is shown is the number enforced here; this fallback is for a Hands
 * started without it.
 */
const MAX_TIMEOUT_SEC = parseInt(
  process.env.BASH_MAX_TIMEOUT_SEC || (BG_SHELL_ENABLED ? "120" : "36000"),
  10,
);

const schema = {
  command: z.string().describe("Shell command to execute"),
  timeout: z.number().optional().describe(`Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, capped at ${MAX_TIMEOUT_SEC}). Use run_in_background=true plus wait for longer work.`),
  run_in_background: z.boolean().optional().describe("Start in background; returns shell_id immediately"),
  shell_id: z.string().optional().describe("Reuse this id (advanced); auto-generated when omitted"),
  background_kind: z.enum(["background", "monitor"]).optional()
    .describe("Only with run_in_background=true. monitor shells skip stall-prompt notifications"),
};



/**
 * Uses the shared process-runner: detached process groups (so timeout
 * cleanup can kill the full tree, not just the top-level /bin/sh), capped
 * stdout/stderr buffers (truncates with marker, keeps streaming), and
 * non-blocking execution so the MCP server can serve other tool calls
 * concurrently.
 */
export const bash = {
  name: "bash",
  description: "Execute a shell command in the workspace directory. Foreground commands have a default 120s timeout and kill the whole process group on timeout; use run_in_background=true for long-running work.",
  zodSchema: schema,
  execute: async (args: {
    command: string; timeout?: number;
    run_in_background?: boolean; shell_id?: string; background_kind?: "background" | "monitor";
  }) => {
    if (args.run_in_background) {
      try {
        const shell = spawnBackground(
          currentOwner(), currentRun(), args.command, args.shell_id, args.background_kind ?? "background",
        );
        return { content: [{ type: "text" as const, text: `Started background shell ${shell.id}. Poll output with bash_output, terminate with kill_shell.` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }

    const requestedSec = args.timeout ?? DEFAULT_TIMEOUT_SEC;
    if (!Number.isFinite(requestedSec) || requestedSec <= 0) {
      return { content: [{ type: "text" as const, text: `Error: timeout must be a positive number of seconds (default ${DEFAULT_TIMEOUT_SEC})` }] };
    }
    // Clamped, not refused. Asking for longer is a reasonable thing to want and
    // refusing outright only costs a turn before the model tries something
    // else; running it up to the ceiling at least gets short commands done. If
    // it does hit the ceiling the message below explains which limit it met.
    const grantedSec = Math.min(requestedSec, MAX_TIMEOUT_SEC);

    const timeoutMs = grantedSec * 1000;
    const result = await runForegroundShell(args.command, {
      timeoutMs,
      bufferBytes: MAX_OUTPUT_BYTES,
    });

    if (result.timedOut) {
      // Naming the ceiling matters more than naming the elapsed time: without
      // it the obvious repair is to re-run with a larger timeout, which is the
      // one thing that cannot work.
      const clamped = grantedSec < requestedSec;
      const ceiling = clamped
        ? ` The requested ${requestedSec}s was reduced to the ${MAX_TIMEOUT_SEC}s foreground limit, so raising it again will not help.`
        : "";
      // What to try instead depends on what this deployment has. Pointing at
      // run_in_background where it is refused sends the model round a loop it
      // cannot leave, and so does suggesting a longer timeout to a command that
      // was just clamped.
      const advice = BG_SHELL_ENABLED
        ? ` For work that takes longer, start it with run_in_background=true and then call wait.`
        : clamped
          ? ` Split it into steps that each finish inside the limit.`
          : ` For work that takes longer, raise the timeout, up to ${MAX_TIMEOUT_SEC}s.`;
      return {
        content: [{
          type: "text" as const,
          text: `timeout after ${grantedSec}s (killed the whole process group, so nothing survived).${ceiling}${advice}`
            + `\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        }],
        isError: true,
      };
    }
    if (result.exitCode === 0) {
      return { content: [{ type: "text" as const, text: result.stdout }] };
    }
    // Mark non-zero exit as an error so callers (script-runner, agent loop
    // tool router) can distinguish "succeeded with stderr noise" from
    // "process exited non-zero" and apply the right on_fail policy
    // (task-design.md §7.3 / §8.2). LLM agent loops also see this as a
    // tool-result `is_error:true` which is the standard MCP signal.
    return {
      content: [{
        type: "text" as const,
        text: `exit ${result.exitCode}${result.signal ? ` (signal=${result.signal})` : ""}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      }],
      isError: true,
    };
  },
};
