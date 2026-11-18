// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which entries an entry cites (E242): `claw_memory_links`, kept by the server from what the entry says, so that a citation
 * written before its target existed ("记在「Wren 许可」那一条里") is joined to that entry the moment it is saved, instead of
 * staying words that say it does not exist yet.
 *
 * An entry cites another by its number (`#12`, a live entry of the same user) or by a name in corner brackets
 * (「Kestrel 发布窗口」, 『…』). A name is joined to the one active entry it names (`resolveCitation`) and keeps the name it was
 * joined by (`name`); a name that names none is kept dangling (`to_kind = 'title'`). Since what a name names changes whenever
 * any entry of the user is saved, changed, undone or deleted, every name citation of the user is resolved again then
 * (`resolveNames`): a citation follows a renamed entry away, falls back to dangling on a tie, and is joined when its entry
 * appears. Nothing here reaches past one user: every row carries the user, and every candidate is that user's.
 *
 * The pure half (what a text cites, which entry a name names) is here; the writes are `relinkEntry` and `resolveNames`,
 * called by the service inside the transaction that changed an entry, under the user's write lock.
 */
import type { Querier } from "../infra/db.js";
import { recallTerms } from "./gates.js";

export type LinkRel = "cites" | "derived_from";

/** At most this many citations are kept per entry: an entry is at most BODY_MAX characters, and a list of names is not a citation. */
export const LINKS_PER_ENTRY_MAX = 10;
/** A name longer than this is not a title (an entry's title is at most TITLE_MAX); it is a quotation. */
const NAME_MAX = 60;

/** What a text cites: entry numbers (`#12`, not `repo#12`) and names in corner brackets, in order, each once. */
export function citationsIn(text: string): { ids: number[]; names: string[] } {
  const ids: number[] = [];
  const names: string[] = [];
  // Not `repo#12`, and not a number that names something else: `PR #529`, `issue #3`, `事项 #12` (a work item).
  for (const m of (text || "").matchAll(/(?<![A-Za-z0-9_.\-/#])(?<!(?:\b(?:pr|mr|pull|issue|issues|bug|ticket|item|items|cl|run|job)|事项|工单|任务|问题)\s?)#([1-9]\d{0,9})(?![0-9])/gi)) {
    const id = Number(m[1]);
    if (Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id);
  }
  for (const m of (text || "").matchAll(/「([^「」\n]{1,200})」|『([^『』\n]{1,200})』/g)) {
    const name = (m[1] ?? m[2] ?? "").trim();
    if (name && [...name].length <= NAME_MAX && recallTerms(name).size && !names.includes(name)) names.push(name);
  }
  return { ids: ids.slice(0, LINKS_PER_ENTRY_MAX), names: names.slice(0, LINKS_PER_ENTRY_MAX) };
}

export interface LinkCandidate { id: number; title: string; body: string }

/** A candidate's terms, computed once per resolution pass rather than once per name. */
interface Indexed { id: number; all: Set<string>; title: Set<string> }

function indexed(candidates: readonly LinkCandidate[]): Indexed[] {
  return candidates.map((c) => ({ id: c.id, all: recallTerms(`${c.title}\n${c.body}`), title: recallTerms(c.title) }));
}

/**
 * The one entry a name names, or null. An entry names it when its title and body hold every term of the name (`recallTerms`):
 * 「Wren 许可」 names "Wren-v3 许可：仅限内部评测" whose body begins "Wren 许可：…". Of several, the one whose title alone holds
 * the most of the name's terms; a tie names none, since a citation joined to the wrong entry is worse than one not joined.
 */
export function resolveCitation(name: string, candidates: readonly LinkCandidate[], self: number | null): number | null {
  return resolveIndexed(name, indexed(candidates), self);
}

function resolveIndexed(name: string, candidates: readonly Indexed[], self: number | null): number | null {
  const terms = [...recallTerms(name)];
  if (!terms.length) return null;
  const scored = candidates
    .filter((c) => c.id !== self && terms.every((t) => c.all.has(t)))
    .map((c) => ({ id: c.id, inTitle: terms.filter((x) => c.title.has(x)).length }))
    .sort((a, b) => b.inTitle - a.inTitle);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].inTitle === scored[1].inTitle) return null;
  return scored[0].id;
}

/**
 * The user's entries a citation may name, not the knowledge base's: `active` for a name (an entry waiting for its owner's confirmation
 * does not capture one: it is joined when it is confirmed), and every live one for a number, which says which entry it means.
 */
async function candidatesOf(q: Querier, userId: string): Promise<{ named: LinkCandidate[]; live: Set<number> }> {
  const rows = (await q(
    `SELECT id, COALESCE(title, '') AS title, content, status FROM claw_memory_entries
      WHERE user_id = $1 AND kind IS NULL AND deleted_at IS NULL AND category <> 'user_profile' AND status IN ('active', 'pending')`,
    [userId],
  )).rows as Array<{ id: number; title: string; content: string; status: string }>;
  return {
    named: rows.filter((r) => r.status === "active").map((r) => ({ id: Number(r.id), title: r.title, body: r.content })),
    live: new Set(rows.map((r) => Number(r.id))),
  };
}

/**
 * Derive the entry's citations again from what it says now: its system-made `cites` rows are replaced (a changed body cites what
 * the new body cites), each name joined to the entry it names or kept dangling. `derived_from` rows are left as they are.
 */
export async function relinkEntry(q: Querier, userId: string, id: number): Promise<void> {
  const row = (await q(
    "SELECT COALESCE(title, '') AS title, content FROM claw_memory_entries WHERE user_id = $1 AND id = $2 AND kind IS NULL AND deleted_at IS NULL",
    [userId, id],
  )).rows[0] as { title: string; content: string } | undefined;
  await q("DELETE FROM claw_memory_links WHERE user_id = $1 AND from_id = $2 AND rel = 'cites' AND created_by = 'system'", [userId, id]);
  if (!row) return;
  const { ids, names } = citationsIn(`${row.title}\n${row.content}`);
  if (!ids.length && !names.length) return;
  const { named, live } = await candidatesOf(q, userId);
  const index = indexed(named);
  const targets: Array<{ kind: "memory" | "title"; to: string; name: string }> = [];
  for (const n of ids) if (n !== id && live.has(n)) targets.push({ kind: "memory", to: String(n), name: "" });
  for (const name of names) {
    const found = resolveIndexed(name, index, id);
    targets.push(found === null ? { kind: "title", to: name, name } : { kind: "memory", to: String(found), name });
  }
  for (const t of targets.slice(0, LINKS_PER_ENTRY_MAX)) {
    await q(
      `INSERT INTO claw_memory_links (user_id, from_id, rel, name, to_kind, to_id, created_by) VALUES ($1, $2, 'cites', $3, $4, $5, 'system')
       ON CONFLICT DO NOTHING`,
      [userId, id, t.name, t.kind, t.to],
    );
  }
}

/**
 * Resolve every name citation of the user again, over their active entries as they are now (`except`: the entry just derived by
 * `relinkEntry`, whose own rows are fresh). One that now names another entry, or none (renamed, deleted, or tied with a new one), is
 * moved; a dangling one whose entry now exists is joined. At most CLAW_MEMORY_MAX_ENTRIES x LINKS_PER_ENTRY_MAX names, each over
 * the candidates' terms computed once.
 */
export async function resolveNames(q: Querier, userId: string, except: number | null): Promise<void> {
  const rows = (await q(
    `SELECT from_id, name, to_kind, to_id FROM claw_memory_links
      WHERE user_id = $1 AND rel = 'cites' AND name <> '' AND ($2::int IS NULL OR from_id <> $2::int)`,
    [userId, except],
  )).rows as Array<{ from_id: number; name: string; to_kind: string; to_id: string }>;
  if (!rows.length) return;
  const index = indexed((await candidatesOf(q, userId)).named);
  for (const r of rows) {
    const found = resolveIndexed(r.name, index, Number(r.from_id));
    const next = found === null ? { kind: "title", to: r.name } : { kind: "memory", to: String(found) };
    if (next.kind === r.to_kind && next.to === r.to_id) continue;
    await q(
      "DELETE FROM claw_memory_links WHERE user_id = $1 AND from_id = $2 AND rel = 'cites' AND name = $3 AND to_kind = $4 AND to_id = $5",
      [userId, r.from_id, r.name, r.to_kind, r.to_id],
    );
    await q(
      `INSERT INTO claw_memory_links (user_id, from_id, rel, name, to_kind, to_id, created_by) VALUES ($1, $2, 'cites', $3, $4, $5, 'system')
       ON CONFLICT DO NOTHING`,
      [userId, r.from_id, r.name, next.kind, next.to],
    );
  }
}

/** A new entry made in place of a close one (`force_new`): it is derived from that one. */
export async function linkDerived(q: Querier, userId: string, id: number, from: number, by: "model" | "api"): Promise<void> {
  await q(
    `INSERT INTO claw_memory_links (user_id, from_id, rel, name, to_kind, to_id, created_by) VALUES ($1, $2, 'derived_from', '', 'memory', $3, $4)
     ON CONFLICT DO NOTHING`,
    [userId, id, String(from), by],
  );
}

/**
 * Before entries are erased: what cites them by number, or is derived from them, goes with them. What cites them by name is
 * resolved again once they are gone (`resolveNames`: to another entry, or back to dangling). Their own rows go with their rows
 * (`ON DELETE CASCADE`).
 */
export async function unlinkErased(q: Querier, userId: string, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  await q(
    "DELETE FROM claw_memory_links WHERE user_id = $1 AND to_kind = 'memory' AND to_id = ANY($2::text[]) AND name = ''",
    [userId, ids.map(String)],
  );
}

/** The active entries each of `ids` cites, by number and title, of this user only, at most LINKS_PER_ENTRY_MAX each. */
export async function citedBy(q: Querier, userId: string, ids: readonly number[]): Promise<Map<number, Array<{ id: number; title: string }>>> {
  const out = new Map<number, Array<{ id: number; title: string }>>();
  if (!ids.length) return out;
  const rows = (await q(
    `SELECT DISTINCT l.from_id, e.id, COALESCE(e.title, '') AS title FROM claw_memory_links l
       JOIN claw_memory_entries e ON e.user_id = l.user_id AND e.id::text = l.to_id
      WHERE l.user_id = $1 AND l.from_id = ANY($2::int[]) AND l.rel = 'cites' AND l.to_kind = 'memory'
        AND e.kind IS NULL AND e.deleted_at IS NULL AND e.category <> 'user_profile' AND e.status = 'active'
        AND (e.expires_at IS NULL OR e.expires_at > NOW())
      ORDER BY l.from_id, e.id`,
    [userId, ids],
  )).rows as Array<{ from_id: number; id: number; title: string }>;
  for (const r of rows) {
    const list = out.get(Number(r.from_id)) ?? [];
    if (list.length < LINKS_PER_ENTRY_MAX) list.push({ id: Number(r.id), title: r.title });
    out.set(Number(r.from_id), list);
  }
  return out;
}
