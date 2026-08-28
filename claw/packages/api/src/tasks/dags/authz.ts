// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { UserInfo } from "../../auth/models.js";
import { isAdmin, isSystemAdmin } from "../../auth/models.js";
import type { TaskDagRow } from "./db.js";

type DagAccessFields = Pick<TaskDagRow, "owner_user_id" | "is_public">;

export function canReadTaskDag(
  dag: DagAccessFields,
  caller: UserInfo | null | undefined,
): boolean {
  if (dag.is_public) return true;
  if (dag.owner_user_id && dag.owner_user_id === caller?.userId) return true;
  return !!caller && isAdmin(caller);
}

export function canExecuteTaskDag(
  dag: DagAccessFields,
  caller: UserInfo | null | undefined,
): boolean {
  if (dag.is_public) return true;
  if (dag.owner_user_id && dag.owner_user_id === caller?.userId) return true;
  return !!caller && isSystemAdmin(caller);
}
