// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { killShell } from "./bg-manager.js";
import { currentOwner } from "../../runtime/owner-context.js";

const schema = {
  shell_id: z.string().describe("ID returned by bash(run_in_background=true)"),
};

export const kill_shell = {
  name: "kill_shell",
  description: "Terminate a background shell started with bash(run_in_background=true). Sends SIGTERM to the process group, then SIGKILL after 5s.",
  zodSchema: schema,
  execute: async (args: { shell_id: string }) => {
    const text = killShell(currentOwner(), args.shell_id);
    return { content: [{ type: "text" as const, text }] };
  },
};
