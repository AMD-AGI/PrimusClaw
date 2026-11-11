// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** GroupContextRepository on SQLite (table `group_context_off`: one row per chat that turned the context off). */
import type { GroupContextRepository } from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";

export class SqliteGroupContextRepository implements GroupContextRepository {
  constructor(private readonly ctx: StoreContext) {}

  contextOff(conversationId: string): boolean {
    return (
      this.ctx.db.get("SELECT 1 AS off FROM group_context_off WHERE conversation_id = ?", conversationId) !== undefined
    );
  }

  setContextOff(conversationId: string, off: boolean): void {
    if (off) {
      this.ctx.db.run(
        "INSERT INTO group_context_off (conversation_id, updated_at) VALUES (?, ?) " +
          "ON CONFLICT (conversation_id) DO UPDATE SET updated_at = excluded.updated_at",
        conversationId,
        this.ctx.now(),
      );
    } else this.ctx.db.run("DELETE FROM group_context_off WHERE conversation_id = ?", conversationId);
  }
}
