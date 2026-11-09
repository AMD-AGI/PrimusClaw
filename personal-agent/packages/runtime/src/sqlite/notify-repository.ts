// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** NotifySubscriptionRepository on SQLite (tables `notify_subs`, `notify_sub_attempts`). */
import type { NotifyRoute, NotifySubscription, NotifySubscriptionRepository } from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { col } from "./database.js";
import { forgetNotifySub } from "./forget.js";

export class SqliteNotifySubscriptionRepository implements NotifySubscriptionRepository {
  constructor(private readonly ctx: StoreContext) {}

  saveNotifySub(userId: string, sub: NotifySubscription & { readonly secret: string; readonly typesVersion?: number }): void {
    this.ctx.db.run(
      "INSERT OR REPLACE INTO notify_subs (aad_id, route, subscription_id, secret_enc, created_at, types_version) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      userId,
      sub.route,
      sub.subscriptionId,
      this.ctx.secrets.encrypt(sub.secret),
      this.ctx.now(),
      sub.typesVersion ?? 0,
    );
  }

  notifyTypesVersion(userId: string): number | null {
    const row = this.ctx.db.get("SELECT types_version FROM notify_subs WHERE aad_id = ?", userId);
    return row ? col.num(row, "types_version") : null;
  }

  setNotifyTypesVersion(userId: string, typesVersion: number): void {
    this.ctx.db.run("UPDATE notify_subs SET types_version = ? WHERE aad_id = ?", typesVersion, userId);
  }

  getNotifySub(userId: string): NotifySubscription | null {
    const row = this.ctx.db.get("SELECT route, subscription_id FROM notify_subs WHERE aad_id = ?", userId);
    return row ? { route: col.str(row, "route"), subscriptionId: col.str(row, "subscription_id") } : null;
  }

  notifySubByRoute(route: string): NotifyRoute | null {
    const row = this.ctx.db.get("SELECT aad_id, secret_enc FROM notify_subs WHERE route = ?", route);
    if (!row) return null;
    const secret = this.ctx.secrets.decrypt(col.bytes(row, "secret_enc"));
    return secret === null ? null : { userId: col.str(row, "aad_id"), secret };
  }

  forgetNotifySub(userId: string): void {
    forgetNotifySub(this.ctx.db, userId);
  }

  claimNotifyAttempt(userId: string, minInterval: number): boolean {
    const now = this.ctx.now();
    const row = this.ctx.db.get("SELECT at FROM notify_sub_attempts WHERE aad_id = ?", userId);
    if (row && now - col.num(row, "at") < minInterval) return false;
    this.ctx.db.run("INSERT OR REPLACE INTO notify_sub_attempts (aad_id, at) VALUES (?, ?)", userId, now);
    return true;
  }
}
