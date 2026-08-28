// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { pollOutput } from "./bg-manager.js";
import { currentOwner } from "../../runtime/owner-context.js";

const schema = {
  shell_id: z.string().describe("ID returned by bash(run_in_background=true)"),
  filter: z.string().optional().describe("Optional regex; only matching lines are returned"),
};

export const bash_output = {
  name: "bash_output",
  description: "Read incremental output from a background shell started with bash(run_in_background=true) in this same run. Returns only the bytes produced since the previous poll, plus the exit status once the shell has finished.",
  zodSchema: schema,
  execute: async (args: { shell_id: string; filter?: string }) => {
    const text = pollOutput(currentOwner(), args.shell_id, args.filter);
    return { content: [{ type: "text" as const, text }] };
  },
};
