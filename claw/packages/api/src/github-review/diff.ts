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

/** The added lines of a patch, without their `+`, for the rules that read what a change introduces. */
export function addedLines(patch: string | undefined | null): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1));
  }
  return out;
}

export function removedLines(patch: string | undefined | null): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("-") && !line.startsWith("---")) out.push(line.slice(1));
  }
  return out;
}
