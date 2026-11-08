// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which entries an entry cites (E242): `claw_memory_links`, kept by the server from what the entry says, so that a citation
 * written before its target existed ("记在「Wren 许可」那一条里") is joined to that entry the moment it is saved, instead of
 * staying words that say it does not exist yet.
 *
 * An entry cites another by its number (`#12`, an active entry of the same user) or by a name in corner brackets
 * (「Kestrel 发布窗口」, 『…』). A name is joined to the one entry it names (`resolveCitation`); a name that names none yet is
 * kept as a dangling citation (`to_kind = 'title'`) and joined when an entry it names is saved or changed. Nothing here
 * reaches past one user: every row carries the user, and every candidate is that user's.
 *
 * The pure half (what a text cites, which entry a name names) is here; the writes are `relinkEntry` and `joinDangling`,
 * called by the service inside the transaction that changed the entry.
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
  for (const m of (text || "").matchAll(/(?<![A-Za-z0-9_.\-/#])#([1-9]\d{0,9})(?![0-9])/g)) {
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

/**
 * The one entry a name names, or null. An entry names it when its title and body hold every term of the name (`recallTerms`):
 * 「Wren 许可」 names "Wren-v3 许可：仅限内部评测" whose body begins "Wren 许可：…". Of several, the one whose title alone holds
 * the most of the name's terms; a tie names none, since a citation joined to the wrong entry is worse than one not joined.
 */
export function resolveCitation(name: string, candidates: readonly LinkCandidate[], self: number | null): number | null {
  const terms = [...recallTerms(name)];
  if (!terms.length) return null;
  const scored = candidates
    .filter((c) => c.id !== self)
    .filter((c) => { const all = recallTerms(`${c.title}\n${c.body}`); return terms.every((t) => all.has(t)); })
    .map((c) => { const t = recallTerms(c.title); return { id: c.id, inTitle: terms.filter((x) => t.has(x)).length }; })
    .sort((a, b) => b.inTitle - a.inTitle);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].inTitle === scored[1].inTitle) return null;
  return scored[0].id;
}

/** The user's entries a citation may name: theirs, live (active or waiting for confirmation), not the knowledge base's. */
async function candidatesOf(q: Querier, userId: string): Promise<LinkCandidate[]> {
  return ((await q(
    `SELECT id, COALESCE(title, '') AS title, content FROM claw_memory_entries
      WHERE user_id = $1 AND kind IS NULL AND deleted_at IS NULL AND category <> 'user_profile' AND status IN ('active', 'pending')`,
    [userId],
  )).rows as Array<{ id: number; title: string; content: string }>).map((r) => ({ id: Number(r.id), title: r.title, body: r.content }));
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
  const candidates = await candidatesOf(q, userId);
  const live = new Set(candidates.map((c) => c.id));
  const targets: Array<{ kind: "memory" | "title"; to: string }> = [];
  for (const n of ids) if (n !== id && live.has(n)) targets.push({ kind: "memory", to: String(n) });
  for (const name of names) {
    const found = resolveCitation(name, candidates, id);
    targets.push(found === null ? { kind: "title", to: name } : { kind: "memory", to: String(found) });
  }
  for (const t of targets.slice(0, LINKS_PER_ENTRY_MAX)) {
    await q(
      `INSERT INTO claw_memory_links (user_id, from_id, rel, to_kind, to_id, created_by) VALUES ($1, $2, 'cites', $3, $4, 'system')
       ON CONFLICT DO NOTHING`,
      [userId, id, t.kind, t.to],
    );
  }
}

/** Join the user's dangling citations that the entry `id` now answers (it was saved, or its title or body changed). */
export async function joinDangling(q: Querier, userId: string, id: number): Promise<void> {
  const dangling = (await q(
    "SELECT from_id, to_id FROM claw_memory_links WHERE user_id = $1 AND to_kind = 'title' AND from_id <> $2", [userId, id],
  )).rows as Array<{ from_id: number; to_id: string }>;
  if (!dangling.length) return;
  const candidates = await candidatesOf(q, userId);
  for (const d of dangling) {
    if (resolveCitation(d.to_id, candidates, Number(d.from_id)) !== id) continue;
    await q(
      `DELETE FROM claw_memory_links WHERE user_id = $1 AND from_id = $2 AND rel = 'cites' AND to_kind = 'title' AND to_id = $3`,
      [userId, d.from_id, d.to_id],
    );
    await q(
      `INSERT INTO claw_memory_links (user_id, from_id, rel, to_kind, to_id, created_by) VALUES ($1, $2, 'cites', 'memory', $3, 'system')
       ON CONFLICT DO NOTHING`,
      [userId, d.from_id, String(id)],
    );
  }
}

/** A new entry made in place of a close one (`force_new`): it is derived from that one. */
export async function linkDerived(q: Querier, userId: string, id: number, from: number, by: "model" | "api"): Promise<void> {
  await q(
    `INSERT INTO claw_memory_links (user_id, from_id, rel, to_kind, to_id, created_by) VALUES ($1, $2, 'derived_from', 'memory', $3, $4)
     ON CONFLICT DO NOTHING`,
    [userId, id, String(from), by],
  );
}

/**
 * Before entries are erased: every citation of them by another entry goes with them, and each entry that cited them derives its
 * citations again, so its words name a dangling citation once more rather than a number that no longer exists. Their own
 * citations go with their rows (`ON DELETE CASCADE`).
 */
export async function unlinkErased(q: Querier, userId: string, ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  const citing = (await q(
    `DELETE FROM claw_memory_links WHERE user_id = $1 AND to_kind = 'memory' AND to_id = ANY($2::text[]) RETURNING from_id`,
    [userId, ids.map(String)],
  )).rows.map((r) => Number(r.from_id));
  return [...new Set(citing)].filter((f) => !ids.includes(f));
}

/** The active entries each of `ids` cites, by number and title, of this user only, at most LINKS_PER_ENTRY_MAX each. */
export async function citedBy(q: Querier, userId: string, ids: readonly number[]): Promise<Map<number, Array<{ id: number; title: string }>>> {
  const out = new Map<number, Array<{ id: number; title: string }>>();
  if (!ids.length) return out;
  const rows = (await q(
    `SELECT l.from_id, e.id, COALESCE(e.title, '') AS title FROM claw_memory_links l
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
