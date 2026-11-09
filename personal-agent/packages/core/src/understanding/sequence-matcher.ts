// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `difflib.SequenceMatcher(None, a, b).ratio()` over the code points of two strings: twice the characters of the
 * matching blocks over the total length, the blocks found exactly as Python finds them (the longest match first,
 * earliest in `a`, then in `b`, then left and right of it; with `b` of 200 or more characters, its popular characters
 * left out of the search and the matches then extended over them, Python's automatic junk heuristic).
 */
export function similarity(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const total = x.length + y.length;
  return total === 0 ? 1 : (2 * matchedSize(x, y)) / total;
}

/** Where `y`'s characters are, for the longest-match search (`b2j`), without the popular ones. */
function positions(y: readonly string[]): Map<string, number[]> {
  const at = new Map<string, number[]>();
  y.forEach((ch, j) => {
    const list = at.get(ch) ?? [];
    list.push(j);
    at.set(ch, list);
  });
  if (y.length >= 200) {
    const popular = Math.floor(y.length / 100) + 1;
    for (const [ch, list] of [...at]) if (list.length > popular) at.delete(ch);
  }
  return at;
}

interface Match {
  readonly i: number;
  readonly j: number;
  readonly size: number;
}

interface Span {
  readonly alo: number;
  readonly ahi: number;
  readonly blo: number;
  readonly bhi: number;
}

/** `find_longest_match` with no junk function: the longest run through the indexed characters, then extended. */
function longest(x: readonly string[], y: readonly string[], at: Map<string, number[]>, s: Span): Match {
  let { i, j, size } = { i: s.alo, j: s.blo, size: 0 };
  let lengths = new Map<number, number>();
  for (let ai = s.alo; ai < s.ahi; ai++) {
    const next = new Map<number, number>();
    for (const bj of at.get(x[ai] ?? "") ?? []) {
      if (bj < s.blo) continue;
      if (bj >= s.bhi) break;
      const k = (lengths.get(bj - 1) ?? 0) + 1;
      next.set(bj, k);
      if (k > size) [i, j, size] = [ai - k + 1, bj - k + 1, k];
    }
    lengths = next;
  }
  while (i > s.alo && j > s.blo && x[i - 1] === y[j - 1]) [i, j, size] = [i - 1, j - 1, size + 1];
  while (i + size < s.ahi && j + size < s.bhi && x[i + size] === y[j + size]) size += 1;
  return { i, j, size };
}

function matchedSize(x: readonly string[], y: readonly string[]): number {
  const at = positions(y);
  let total = 0;
  const queue: Span[] = [{ alo: 0, ahi: x.length, blo: 0, bhi: y.length }];
  for (let s = queue.pop(); s !== undefined; s = queue.pop()) {
    const m = longest(x, y, at, s);
    if (m.size === 0) continue;
    total += m.size;
    if (s.alo < m.i && s.blo < m.j) queue.push({ alo: s.alo, ahi: m.i, blo: s.blo, bhi: m.j });
    if (m.i + m.size < s.ahi && m.j + m.size < s.bhi) {
      queue.push({ alo: m.i + m.size, ahi: s.ahi, blo: m.j + m.size, bhi: s.bhi });
    }
  }
  return total;
}
