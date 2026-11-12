// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * GroupLanguageRepository on SQLite (table `group_language`: one row per group chat that was asked which language to use, or set
 * one; `lang` "" while it was asked and nobody chose).
 */
import type { GroupLanguage, GroupLanguageRepository } from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";

const LANGS: ReadonlySet<string> = new Set(["zh", "en", "auto"]);

export class SqliteGroupLanguageRepository implements GroupLanguageRepository {
  constructor(private readonly ctx: StoreContext) {}

  groupLanguage(conversationId: string): GroupLanguage | "" | null {
    const row = this.ctx.db.get("SELECT lang FROM group_language WHERE conversation_id = ?", conversationId);
    if (row === undefined) return null;
    const lang = row["lang"];
    return typeof lang === "string" && LANGS.has(lang) ? (lang as GroupLanguage) : "";
  }

  setGroupLanguage(conversationId: string, lang: GroupLanguage): void {
    this.ctx.db.run(
      "INSERT INTO group_language (conversation_id, lang, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (conversation_id) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at",
      conversationId,
      lang,
      this.ctx.now(),
    );
  }

  markGroupLanguageAsked(conversationId: string): boolean {
    const changes = this.ctx.db.run(
      "INSERT INTO group_language (conversation_id, lang, updated_at) VALUES (?, '', ?) ON CONFLICT (conversation_id) DO NOTHING",
      conversationId,
      this.ctx.now(),
    );
    return changes > 0;
  }

  unmarkGroupLanguageAsked(conversationId: string): void {
    this.ctx.db.run("DELETE FROM group_language WHERE conversation_id = ? AND lang = ''", conversationId);
  }
}
