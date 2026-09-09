// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Ledger keys for tests that want to name one.
 *
 * Minted through the real resolver rather than cast, so the branded key stays
 * something exactly one module in the tree can produce.
 */
import type { ExecuteRequest } from "@claw/protocol";
import { resolveRunIdentity, type RunIdentity } from "../../src/tasks/run-identity.js";

export function testRunIdentity(taskId: string): RunIdentity {
  const request = { session_id: "sess-test", task_id: taskId } as ExecuteRequest;
  return resolveRunIdentity(request, "").identity;
}

export const testRunKey = (taskId: string): RunIdentity["key"] => testRunIdentity(taskId).key;
