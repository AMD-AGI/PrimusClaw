// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a unified diff of one file allows an inline comment on.
 *
 * GitHub refuses a review comment on a line that is not in the diff, and refuses
 * the whole review with it. Checking here, before anything is written, turns that
 * into a message naming the bad comments so the model can fix them and the
 * review goes out once.
 */
export interface CommentableLines {
  /** Line numbers in the new file that the diff shows (added and context lines). */
  right: Set<number>;
  /** Line numbers in the old file that the diff shows (removed and context lines). */
  left: Set<number>;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function commentableLines(patch: string | undefined | null): CommentableLines {
  const out: CommentableLines = { right: new Set(), left: new Set() };
  if (!patch) return out;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const c = line[0];
    if (c === "+") {
      out.right.add(newLine++);
    } else if (c === "-") {
      out.left.add(oldLine++);
    } else if (c === " " || line === "") {
      // An empty line inside a hunk is a context line whose single space was trimmed.
      if (line === "" && newLine === 0) continue;
      out.right.add(newLine++);
      out.left.add(oldLine++);
    } else if (c === "\\") {
      // "\ No newline at end of file": belongs to the line before it.
    }
  }
  return out;
}

/**
 * The lines of a patch's hunks that start with `mark`, without it. Only what follows
 * the first hunk header is read: GitHub's per-file patch has no `---`/`+++` header
 * lines, so inside a hunk every line is content, and an added line that itself
 * begins with `+` (`++x`) or a removed one that begins with `-` is still seen.
 */
function hunkLines(patch: string | undefined | null, mark: "+" | "-"): string[] {
  if (!patch) return [];
  const out: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (HUNK_RE.test(line)) { inHunk = true; continue; }
    if (inHunk && line.startsWith(mark)) out.push(line.slice(1));
  }
  return out;
}

/**
 * The added and removed lines of a patch in order, one pass, each handed to `visit` (the mark, and the line without it) until it
 * returns false. Nothing is collected: a caller that has read enough stops the scan, so what a very large patch costs is bounded by the
 * caller's budget and not by the patch. The same lines {@link addedLines} and {@link removedLines} return.
 */
export function eachChangedLine(patch: string | undefined | null, visit: (mark: "+" | "-", text: string) => boolean): void {
  if (!patch) return;
  let inHunk = false;
  let pos = 0;
  while (pos <= patch.length) {
    let end = patch.indexOf("\n", pos);
    if (end < 0) end = patch.length;
    const first = patch[pos];
    if (first === "@") {
      if (HUNK_RE.test(patch.slice(pos, Math.min(end, pos + 80)))) inHunk = true;
    } else if (inHunk && (first === "+" || first === "-")) {
      if (!visit(first, patch.slice(pos + 1, end))) return;
    }
    pos = end + 1;
  }
}

/** The added lines of a patch, without their `+`, for the rules that read what a change introduces. */
export function addedLines(patch: string | undefined | null): string[] {
  return hunkLines(patch, "+");
}

export function removedLines(patch: string | undefined | null): string[] {
  return hunkLines(patch, "-");
}
