// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Compiled, not executed: run-identity-guards.test.ts runs `tsc` over this
 * file and fails if any `@ts-expect-error` below stops being an error. Each one
 * is a proxy that used to reach the ledger, or a call the design forbids
 * defaulting.
 */
import type { ExecuteRequest } from "@claw/protocol";
import { beginRun, endRun, phaseOf, whileWaiting } from "../../src/tasks/run-phase.js";
import { resolveRunIdentity } from "../../src/tasks/run-identity.js";

declare const request: ExecuteRequest;
declare const lockKey: string;

const identity = resolveRunIdentity(request, "m-1").identity;

// The one shape that must compile.
beginRun(identity.key);
phaseOf(identity.key);
endRun(identity.key);
void whileWaiting(identity.key, "approval", "timed", async () => 1);
void whileWaiting(undefined, "approval", "timed+park", async () => 1);

// @ts-expect-error session_id is a proxy for the conversation, not the run
beginRun(request.session_id);
// @ts-expect-error dag_root_task_id is a proxy for the whole DAG
phaseOf(request.dag_root_task_id!);
// @ts-expect-error the gate's lock key is a workspace several sessions share
endRun(lockKey);
// @ts-expect-error a bare string cannot address the ledger
void whileWaiting("run-1", "approval", "timed", async () => 1);
// @ts-expect-error a call site has to decide whether it may lend out its slot
void whileWaiting(identity.key, "approval", async () => 1);
