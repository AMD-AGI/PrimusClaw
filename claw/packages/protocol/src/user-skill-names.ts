// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which of the user's personal skills a message names, one rule for both sides: the API's router turn and Brain's worker turn put a
 * named skill's whole text into the turn, so the model does not have to decide to read it (as Claude Code's `/skill-name` does).
 *
 * A name with a hyphen (`weekly-report`, the usual shape) is named wherever it stands as a word of its own. A one-word name (`report`)
 * is too common a word for that: it is named only when it is marked as a skill's name, `/report`, `` `report` ``, `「report」`,
 * `"report"`, or written next to the word skill or 技能 (`report skill`, `技能 report`).
 */

/** The most named skills one turn is given whole: the rest are read the usual way. */
export const NAMED_USER_SKILLS_MAX = 2;

const WORD = "A-Za-z0-9_\\-";

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where in `text` the name is named, or -1. Case-insensitive; `text` is NFKC-normalised by the caller. */
function namedAt(text: string, name: string): number {
  const n = escape(name);
  if (name.includes("-")) {
    const m = new RegExp(`(?<![${WORD}])${n}(?![${WORD}])`, "i").exec(text);
    return m ? m.index : -1;
  }
  const marked = new RegExp(
    `(?:\\/${n}(?![${WORD}])|\`${n}\`|「${n}」|“${n}”|"${n}"|(?<![${WORD}])${n}\\s*(?:skill|技能)|(?:skill|技能)\\s*[:：]?\\s*${n}(?![${WORD}]))`,
    "i",
  );
  const m = marked.exec(text);
  return m ? m.index : -1;
}

/**
 * The names among `names` that `text` names, in the order the text names them, each once, at most `max`. A name that is not a
 * plain skill name (empty, longer than 64 characters, with a space) is never matched.
 */
export function namedUserSkills(text: string, names: readonly string[], max = NAMED_USER_SKILLS_MAX): string[] {
  const said = (text || "").normalize("NFKC");
  if (!said.trim() || max <= 0) return [];
  const hits: Array<{ name: string; at: number }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || name.length > 64 || /\s/.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const at = namedAt(said, name);
    if (at >= 0) hits.push({ name, at });
  }
  hits.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  return hits.slice(0, max).map((h) => h.name);
}
