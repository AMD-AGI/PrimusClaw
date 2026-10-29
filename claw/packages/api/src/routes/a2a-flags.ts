// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// The switches behind the A2A server's context/task model.
//
// Read on each use, as auth/identity-token.ts does, so what a request is
// judged by is what the environment says now and a suite can flip them per
// file. Both are off by default: with them off the server is the one it was.
//
//   CLAW_A2A_CONTEXT_TASKS        contextId names a session, taskId names one
//                                 run of it (INPUT_REQUIRED, CANCELED, the
//                                 caller owns the session, truthful card)
// ---------------------------------------------------------------------------

import { envBool } from "../config.js";

export function a2aContextTasksEnabled(): boolean {
  return envBool("CLAW_A2A_CONTEXT_TASKS", false);
}
