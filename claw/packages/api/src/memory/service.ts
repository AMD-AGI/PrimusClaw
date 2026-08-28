// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { db } from "../infra/db.js";
import { callMemoryLLM } from "../llm/client.js";
import pino from "pino";

const logger = pino({ name: "memory-service" });

const MAX_MEMORY_ENTRIES = 50;

export interface MemoryEntry {
  category: string;
  content: string;
  importance: number;
  sourceSession?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
  // New canonical scope field; persisted as JSONB on the server.
  // Either `scope` or the legacy `scopePath` may be supplied; if both are
  // sent the server prefers `scope`.
  scope?: Record<string, string>;
  // Legacy slash-delimited form, e.g. "org:claw/user:abc". Still accepted.
  scopePath?: string;
}

// ===== CRUD =====

import { StorageMemoryClient } from "./storage-client.js";

// Optional singleton initialized only when needed
let _storageClient: StorageMemoryClient | null = null;
function getStorageClient(): StorageMemoryClient {
  if (!_storageClient) _storageClient = new StorageMemoryClient();
  return _storageClient;
}

const isRemote = process.env.MEMORY_BACKEND === 'remote';

export async function getMemoryEntries(userId: string, limit = 30): Promise<any[]> {
  if (isRemote) return getStorageClient().list(userId, limit);
  return (await db.query(`
    SELECT id, category, content, importance, source_session, source_type, access_count, created_at, last_accessed
    FROM claw_memory_entries
    WHERE user_id = $1 AND deleted_at IS NULL
    ORDER BY importance DESC, last_accessed DESC
    LIMIT $2
  `, [userId, limit])).rows;
}

export async function insertMemoryEntry(userId: string, entry: MemoryEntry): Promise<void> {
  if (isRemote) return getStorageClient().insert(userId, entry);
  const count = (await db.query(
    "SELECT COUNT(*) as cnt FROM claw_memory_entries WHERE user_id = $1 AND deleted_at IS NULL", [userId]
  )).rows[0].cnt;

  if (parseInt(count) >= MAX_MEMORY_ENTRIES) {
    await db.query(`
      UPDATE claw_memory_entries SET deleted_at = NOW()
      WHERE id = (
        SELECT id FROM claw_memory_entries
        WHERE user_id = $1 AND category != 'user_profile' AND deleted_at IS NULL
        ORDER BY importance ASC, last_accessed ASC LIMIT 1
      )
    `, [userId]);
  }

  await db.query(`
    INSERT INTO claw_memory_entries (user_id, category, content, importance, source_session, source_type)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId, entry.category, entry.content, entry.importance,
      entry.sourceSession || null, entry.sourceType || "auto"]);
}

export async function deleteMemoryEntry(userId: string, entryId: number | string): Promise<boolean> {
  if (isRemote) {
    await getStorageClient().delete(userId, entryId.toString());
    return true;
  }
  const result = await db.query(
    "UPDATE claw_memory_entries SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [entryId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateMemoryEntry(
  userId: string, entryId: string,
  updates: { content?: string; category?: string; importance?: number },
): Promise<boolean> {
  if (isRemote) {
    await getStorageClient().update(userId, entryId, updates);
    return true;
  }
  const sets: string[] = [];
  const params: any[] = [entryId, userId];
  if (updates.content !== undefined) { params.push(updates.content); sets.push(`content = $${params.length}`); }
  if (updates.category !== undefined) { params.push(updates.category); sets.push(`category = $${params.length}`); }
  if (updates.importance !== undefined) { params.push(updates.importance); sets.push(`importance = $${params.length}`); }
  if (!sets.length) return true;
  const result = await db.query(
    `UPDATE claw_memory_entries SET ${sets.join(", ")}, last_accessed = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, params);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteAllMemories(userId: string): Promise<number> {
  if (isRemote) {
    const res = await getStorageClient().deleteAll(userId);
    return res?.deleted || 0;
  }
  const result = await db.query(
    "UPDATE claw_memory_entries SET deleted_at = NOW() WHERE user_id = $1 AND deleted_at IS NULL",
    [userId]
  );
  return result.rowCount ?? 0;
}

export async function getProfileEntry(userId: string): Promise<string> {
  if (isRemote) {
    const entry = await getStorageClient().getProfile(userId);
    return entry?.content || "";
  }
  const row = (await db.query(
    "SELECT content FROM claw_memory_entries WHERE user_id = $1 AND category = 'user_profile' AND deleted_at IS NULL LIMIT 1",
    [userId],
  )).rows[0];
  return row?.content || "";
}

async function upsertProfile(userId: string, content: string): Promise<void> {
  if (isRemote) {
    await getStorageClient().upsertProfile(userId, content);
    return;
  }
  await db.query(`
    INSERT INTO claw_memory_entries (user_id, category, content, importance, source_type)
    VALUES ($1, 'user_profile', $2, 1.0, 'auto')
    ON CONFLICT (user_id) WHERE category = 'user_profile'
    DO UPDATE SET content = $2, last_accessed = NOW(), deleted_at = NULL
  `, [userId, content]);
}

// ===== Memory Extraction (Background LLM) =====

const EXTRACT_MEMORY_PROMPT = `You are a memory extractor. Analyze the following conversation and extract durable facts worth remembering long-term.

Only extract the following types:
- preference: User's explicit preferences and habits
- correction: User's corrections to the agent
- env_fact: Persistent environment/project facts
- tool_quirk: Tool tips, tricks, or gotchas
- pattern: Successful operational patterns

Existing memories (avoid duplicates):
{existing_memory}

Conversation:
{conversation}

Rules:
1. Only extract persistent facts useful for future sessions, not task progress or temporary state
2. Each entry should be one concise declarative sentence
3. Return empty array if nothing worth remembering
4. Do not duplicate existing memories
5. importance: explicit preference/correction -> 0.8+, environment fact -> 0.6, pattern -> 0.5

Return JSON: { "entries": [{ "category": "...", "content": "...", "importance": 0.8 }] }`;

export async function maybeExtractMemory(sessionId: string, userId: string): Promise<void> {
  const turnCount = (await db.query(
    "SELECT COUNT(*) as cnt FROM claw_conversation_turns WHERE session_id = $1", [sessionId]
  )).rows[0].cnt;

  if (parseInt(turnCount) < 3) return;

  const recentTurns = (await db.query(
    "SELECT role, content FROM claw_conversation_turns WHERE session_id = $1 ORDER BY turn_index DESC LIMIT 10",
    [sessionId]
  )).rows.reverse();

  const existingMemory = await getMemoryEntries(userId, 30);

  const conversation = recentTurns
    .map((t: any) => `${t.role}: ${(t.content || "").slice(0, 500)}`)
    .join("\n");
  const existingText = existingMemory
    .map((m: any) => `- [${m.category}] ${m.content}`)
    .join("\n") || "(none)";

  try {
    const result = await callMemoryLLM<{ entries: Array<{ category: string; content: string; importance: number }> }>(
      userId,
      EXTRACT_MEMORY_PROMPT,
      { conversation, existing_memory: existingText },
    );

    for (const entry of result.entries || []) {
      const blocked = scanMemoryContent(entry.content);
      if (blocked) { logger.warn({ reason: blocked }, "memory.extract_blocked"); continue; }
      await insertMemoryEntry(userId, {
        ...entry,
        sourceSession: sessionId,
        sourceType: "auto",
      });
    }

    if (result.entries?.length) {
      logger.info({ sessionId, userId, count: result.entries.length }, "memory.extracted");
      await maybeUpdateUserProfile(userId);
    }
  } catch (err) {
    logger.error({ err, sessionId, userId }, "memory.extraction_failed");
  }
}

// ===== User Profile =====

const USER_PROFILE_PROMPT = `You are a user profile generator. Based on the following memory entries, generate or update a user profile.

Current profile:
{current_profile}

Memory entries:
{memory_entries}

Generate a user profile (max 1000 words) covering: technical preferences, work habits, commonly used tools, areas of focus, communication style, etc.
Cover as much information from existing memories as possible, but only include high-confidence facts. Avoid speculation.

Return JSON: { "profile": "user profile text" }`;

export async function maybeUpdateUserProfile(userId: string): Promise<void> {
  const allEntries = await getMemoryEntries(userId, 30);
  const entries = allEntries.filter(
    (m: any) => m.category === "preference" || m.category === "correction",
  );
  if (!entries.length) return;

  const current = await getProfileEntry(userId);

  try {
    const result = await callMemoryLLM<{ profile: string }>(
      userId,
      USER_PROFILE_PROMPT,
      {
        current_profile: current || "(none)",
        memory_entries: JSON.stringify(entries.map((r: any) => r.content)),
      },
    );

    if (result.profile) {
      await upsertProfile(userId, result.profile.slice(0, 2000));
      logger.info({ userId }, "memory.profile_updated");
    }
  } catch (err) {
    logger.error({ err, userId }, "memory.profile_update_failed");
  }
}

// ===== Memory Decay (daily cron) =====

export async function decayMemory(): Promise<void> {
  // KB rows (``kind IS NOT NULL``) are excluded: their lifecycle is driven
  // by the KB contradiction / supersession workflow, not the
  // user-memory style time-based forgetting curve. Legacy memory rows
  // (``kind IS NULL``) keep the same decay behaviour they always had.
  await db.query(`
    UPDATE claw_memory_entries
    SET importance = GREATEST(0.04, importance * 0.967)
    WHERE category != 'user_profile'
      AND deleted_at IS NULL
      AND kind IS NULL
      AND last_accessed < NOW() - INTERVAL '7 days'
  `);

  const cleaned = await db.query(`
    UPDATE claw_memory_entries SET deleted_at = NOW()
    WHERE importance < 0.05 AND access_count = 0
      AND category != 'user_profile'
      AND deleted_at IS NULL
      AND kind IS NULL
      AND created_at < NOW() - INTERVAL '30 days'
    RETURNING id
  `);

  if (cleaned.rowCount) {
    logger.info({ deletedCount: cleaned.rowCount }, "memory.decay_cleanup");
  }
}

// ===== Security Scan =====

const THREAT_PATTERNS = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules)/i, id: "disregard" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)/i, id: "exfil" },
];

export function scanMemoryContent(content: string, maxLength = 2000): string | null {
  for (const { pattern, id } of THREAT_PATTERNS) {
    if (pattern.test(content)) return `Blocked: threat pattern '${id}'`;
  }
  if (content.length > maxLength) return `Blocked: content too long (max ${maxLength} chars)`;
  return null;
}
