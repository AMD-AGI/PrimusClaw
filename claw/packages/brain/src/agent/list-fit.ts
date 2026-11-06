// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A JSON tool result too long to read whole, made into one a model can count from.
 *
 * The generic cap keeps a result's head and tail. On a list that leaves a hole in the middle with nothing to say what was in it:
 * "how many nodes does Autopilot have" was answered from a pool list cut in two, "how many SaFE workloads" from a page, and the
 * model then counted what it saw, or said the count was uncertain. Here the counts are taken over the whole result before anything
 * is cut: each list's length (`in_result`), and per list how its items fall by the fields that group them (`by`: a pool, a
 * repository, a status), and then each list keeps only its first items, as many as fit, side by side (`shown`). A page that says
 * how many there are in all (SaFE's `totalCount`) keeps that number, and the note says the counts are of the page. The note says which
 * numbers are whole and how to read the rest. A result that is not JSON, or holds no list, is left to the generic cap.
 */

/** The size a fitted result is cut to, counts and note included. */
export const LIST_FIT_MAX_CHARS = 12_000;

/** At most this many fields are counted per list, each with at most this many values. */
const BY_MAX_FIELDS = 6;
const BY_MAX_VALUES = 20;
/** Words in a field's name that say what an item belongs to or how it stands: such fields are counted first. */
const GROUPING_WORDS = new Set([
  "pool", "repo", "repository", "status", "state", "phase", "cluster", "workspace", "namespace", "kind", "type", "owner", "author", "qos",
  "partition", "node", "host", "health", "ready", "user",
]);
/** Fields that are never a grouping: when, and what links, describes or authenticates one item. */
const NOT_GROUPING = /(_at$|time|date|url|title|description|message|body|summary|token|secret|password|api_?key)/i;

/** A field's name in words: `pool_id` and `poolId` are pool and id. */
const words = (k: string): string[] => k.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const isGrouping = (k: string): boolean => words(k).some((w) => GROUPING_WORDS.has(w));

type Obj = Record<string, unknown>;

interface ListAt {
  /** Where the list is: "" for the result itself, else a key or "key.key". */
  path: string;
  items: unknown[];
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The lists of a result: the result itself, or the lists among its fields and their fields' fields. */
function listsOf(value: unknown): ListAt[] {
  if (Array.isArray(value)) return [{ path: "", items: value }];
  if (!isObj(value)) return [];
  const out: ListAt[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) out.push({ path: k, items: v });
    else if (isObj(v)) for (const [k2, v2] of Object.entries(v)) if (Array.isArray(v2)) out.push({ path: `${k}.${k2}`, items: v2 });
  }
  return out;
}

/** The result with each list replaced by the items it keeps. */
function withLists(value: unknown, kept: Map<string, unknown[]>): unknown {
  if (Array.isArray(value)) return kept.get("") ?? value;
  const out: Obj = { ...(value as Obj) };
  for (const [path, items] of kept) {
    const [a, b] = path.split(".");
    if (b === undefined) out[a] = items;
    else out[a] = { ...(out[a] as Obj), [b]: items };
  }
  return out;
}

/** How the items of a list fall by the fields that group them: { field: { value: count } }, most frequent value first. */
export function countBy(items: readonly unknown[]): Record<string, Record<string, number>> {
  const objs = items.filter(isObj);
  if (objs.length < 2) return {};
  const values = new Map<string, Map<string, number>>();
  const present = new Map<string, number>();
  /** Fields some item holds a list or an object in: not a grouping, whatever the others hold. */
  const structured = new Set<string>();
  for (const o of objs) {
    for (const [k, v] of Object.entries(o)) {
      if (NOT_GROUPING.test(k)) continue;
      if (typeof v === "object" && v !== null) { structured.add(k); continue; }
      if (!(typeof v === "string" || typeof v === "boolean" || v === null)) continue;
      const key = v === null ? "(none)" : String(v);
      if (key.length > 120) continue;
      let m = values.get(k);
      if (!m) values.set(k, (m = new Map()));
      m.set(key, (m.get(key) ?? 0) + 1);
      present.set(k, (present.get(k) ?? 0) + 1);
    }
  }
  // A field each item has its own value of is an id, not a grouping; the result is fitted only when it is long, so its items are many.
  const candidates = [...values.entries()].filter(([k, m]) => !structured.has(k) && !(m.size === 1 && m.has("(none)"))
    && (present.get(k) ?? 0) * 2 >= objs.length && m.size <= BY_MAX_VALUES && m.size < objs.length);
  candidates.sort(([ka, ma], [kb, mb]) => Number(isGrouping(kb)) - Number(isGrouping(ka)) || ma.size - mb.size);
  const out: Record<string, Record<string, number>> = {};
  for (const [k, m] of candidates.slice(0, BY_MAX_FIELDS)) {
    out[k] = Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  }
  return out;
}

/** The count of every match a paged answer gives beside its page (SaFE's totalCount), if it gives one. */
function ownTotal(value: unknown): { key: string; value: number } | null {
  if (!isObj(value)) return null;
  for (const key of ["totalCount", "total_count", "total", "count"]) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v)) return { key, value: v };
  }
  return null;
}

/**
 * The result fitted to `max`, or null when it is not JSON with a list in it (the generic cap applies), or when even its counts do
 * not fit. A result that fits once its JSON is written compactly is returned whole, compact. `savedAt` is where the whole result
 * was kept, when it was.
 */
export function fitJsonResult(text: string, max: number = LIST_FIT_MAX_CHARS, savedAt?: string): string | null {
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const lists = listsOf(value).filter((l) => l.items.length > 0);
  if (!lists.length) return null;
  const compact = JSON.stringify(value);
  if (compact.length <= max) return compact;

  const label = (l: ListAt) => l.path || "items";
  const total: Record<string, number> = {};
  const by: Record<string, Record<string, Record<string, number>>> = {};
  for (const l of lists) {
    total[label(l)] = l.items.length;
    const counted = countBy(l.items);
    if (Object.keys(counted).length) by[label(l)] = counted;
  }
  const own = ownTotal(value);
  const pageTotal = own !== null && own.value > Math.max(...lists.map((l) => l.items.length)) ? own : null;
  const note = `This result (${text.length} characters) is longer than a turn reads whole. in_result is how many items each list of it holds, `
    + "and by how those items fall by a field, both counted over all of them; each list in result keeps only its first items (shown). "
    + "Answer how many from in_result and by, never by counting the items shown"
    + (pageTotal !== null
      ? `; result.${pageTotal.key} (${pageTotal.value}) is the server's count of every match, of which these ${Math.max(...lists.map((l) => l.items.length))} are one page, so by covers this page only: for a count of one kind across every page, call the tool with that filter (a phase, a user) and read its ${pageTotal.key}`
      : "")
    + ". For the items not shown, call the tool again narrowed (a pool, a repository, a status) or with its own paging (offset and limit, or page) "
    + `where it has one${savedAt ? `; the whole result is saved at ${savedAt}` : ""}.`;
  const kept = new Map<string, unknown[]>(lists.map((l) => [l.path, []]));
  const envelope = (shown: Record<string, number>) => ({ note, complete: false, in_result: total, shown, by, result: withLists(value, kept) });
  const shownOf = () => Object.fromEntries(lists.map((l) => [label(l), kept.get(l.path)!.length]));
  // Room for the shown counts to grow by a digit or two.
  let size = JSON.stringify(envelope(shownOf())).length + 8 * lists.length;
  if (size > max) return null;
  // Side by side: the next item of each list in turn, while it fits, so no list is left empty for another's sake.
  const open = new Set(lists.map((l) => l.path));
  for (let i = 0; open.size > 0; i++) {
    for (const l of lists) {
      if (!open.has(l.path)) continue;
      if (i >= l.items.length) { open.delete(l.path); continue; }
      const n = JSON.stringify(l.items[i]).length + 1;
      if (size + n > max) { open.delete(l.path); continue; }
      kept.get(l.path)!.push(l.items[i]);
      size += n;
    }
  }
  return JSON.stringify(envelope(shownOf()));
}
