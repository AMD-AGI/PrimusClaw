// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Skills a bound repository carries in `.claude/skills/<name>/SKILL.md` or
 * `.agents/skills/<name>/SKILL.md`, the layout Claude Code, Codex and Cursor read.
 *
 * Found while the repository is bound (the sandbox is open for that anyway; nothing
 * opens one to look for skills), listed by name and description like every other
 * skill, and served by `load_skill` from a copy Brain stages on first use. The model
 * never reads them with `read` or `bash` to load them, and nothing in them is run:
 * no hooks, no dynamic commands. They are the repository's text, not the user's, and
 * the prompt says so.
 */
import fs from "node:fs";
import path from "node:path";
import { createPrivateStagingRoot } from "../tasks/plugin-from-message.js";
import { SKILL_NAME_RE, skillDescription, type DefaultSkill } from "../agent/platform-defaults.js";
import type { RepoHands } from "./repo-binding.js";

/** Where a repository keeps its skills, relative to its root; the first one holding a name wins. */
export const REPO_SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;
/** Most skills taken from one repository. */
export const REPO_SKILLS_MAX = 20;
/** What is read of each SKILL.md to describe it: its frontmatter, in practice. */
export const REPO_SKILL_HEAD_BYTES = 4096;
/** Bounds of the copy staged when a skill is loaded. */
export const REPO_SKILL_FILES_MAX = 100;
export const REPO_SKILL_FILE_MAX_BYTES = 256 * 1024;
export const REPO_SKILL_TOTAL_MAX_BYTES = 1024 * 1024;
const STAGE_TIMEOUT_SEC = 60;

export interface RepoSkill {
  name: string;
  description: string;
  /** The skill's directory in the sandbox, `<repo>/<.claude|.agents>/skills/<name>`. */
  dir: string;
}

const SKILL_LINE = "@@CLAW-REPO-SKILL ";
const FILE_LINE = "@@CLAW-REPO-SKILL-FILE ";
const hex = (expr: string) => `$(printf %s ${expr} | od -An -v -tx1 | tr -d ' \\n')`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Lists the skills of the repository at `$D` (real path `$RD`), both set by the
 * caller. A skill directory or SKILL.md that is a link, or whose real path leaves the
 * repository, is skipped: a link to a file of the sandbox's own would put it in the
 * prompt. Path and head are sent as hex, so no text in them can pass for a line.
 */
export function repoSkillsCommand(): string {
  return [
    `n=0; for root in ${REPO_SKILL_DIRS.map(shq).join(" ")}; do for s in "$D/$root"/*/; do`,
    `[ "$n" -ge ${REPO_SKILLS_MAX} ] && break 2; s="\${s%/}"; f="$s/SKILL.md";`,
    `{ [ -L "$s" ] || [ -L "$D/$root" ] || [ ! -f "$f" ] || [ -L "$f" ]; } && continue;`,
    `rp=$(realpath -e -- "$f" 2>/dev/null); case "$rp" in "$RD"/*) ;; *) continue;; esac;`,
    `n=$((n+1)); echo "${SKILL_LINE}${hex(`"\${s#"$D"/}"`)}@@$(head -c ${REPO_SKILL_HEAD_BYTES} -- "$f" | od -An -v -tx1 | tr -d ' \\n')";`,
    `done; done`,
  ].join(" ");
}

const fromHex = (h: string) => Buffer.from(h, "hex").toString("utf8");

/** The skills out of `repoSkillsCommand`'s output, for the repository at `repoDir`. One per name, first one wins. */
export function parseRepoSkills(out: string, repoDir: string): RepoSkill[] {
  const re = new RegExp(`^${SKILL_LINE}((?:[0-9a-f]{2})+)@@((?:[0-9a-f]{2})*)$`, "gm");
  const skills: RepoSkill[] = [];
  const seen = new Set<string>();
  for (let m = re.exec(out); m && skills.length < REPO_SKILLS_MAX; m = re.exec(out)) {
    const rel = fromHex(m[1]);
    const name = rel.split("/").pop() ?? "";
    if (!REPO_SKILL_DIRS.some((d) => rel === `${d}/${name}`) || !SKILL_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    skills.push({ name, description: skillDescription(fromHex(m[2]), name), dir: `${repoDir}/${rel}` });
  }
  return skills;
}

/**
 * Copies a repository skill's regular files out of the sandbox into a fresh private
 * directory under `stagingRoot` on Brain and returns it, for `load_skill` to serve. The
 * caller owns `stagingRoot` and removes it when the run ends. Links are neither
 * followed nor copied; the copy is bounded in files and bytes, and a skill whose
 * directory has left the repository since it was listed is refused.
 */
export async function stageRepoSkill(
  hands: RepoHands, repoDir: string, skill: RepoSkill, stagingRoot: string, signal?: AbortSignal,
): Promise<string> {
  const command = [
    `RD=$(realpath -e -- ${shq(repoDir)} 2>/dev/null) || exit 3; S=${shq(skill.dir)};`,
    `[ -L "$S" ] && exit 3; rs=$(realpath -e -- "$S" 2>/dev/null); case "$rs" in "$RD"/*) ;; *) exit 3;; esac;`,
    `t=0; n=0; while IFS= read -r -d '' f; do`,
    `[ "$n" -ge ${REPO_SKILL_FILES_MAX} ] && break; sz=$(stat -c %s -- "$f"); [ $((t+sz)) -gt ${REPO_SKILL_TOTAL_MAX_BYTES} ] && continue;`,
    `t=$((t+sz)); n=$((n+1)); echo "${FILE_LINE}${hex(`"\${f#"$S"/}"`)}@@$(base64 -w0 -- "$f")";`,
    `done < <(find -P "$S" -type f -size -${REPO_SKILL_FILE_MAX_BYTES + 1}c -print0 2>/dev/null)`,
  ].join(" ");
  const r = await hands.callToolFull("bash", { command, timeout: STAGE_TIMEOUT_SEC }, signal);
  if (r.isError) throw new Error(`the skill's files could not be read from ${skill.dir}`);
  const files: Array<{ rel: string; data: Buffer }> = [];
  const re = new RegExp(`^${FILE_LINE}((?:[0-9a-f]{2})+)@@([A-Za-z0-9+/=]*)$`, "gm");
  for (let m = re.exec(r.text); m; m = re.exec(r.text)) {
    const rel = fromHex(m[1]);
    const parts = rel.split("/");
    if (rel.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) continue;
    files.push({ rel, data: Buffer.from(m[2], "base64") });
  }
  if (!files.some((f) => f.rel === "SKILL.md")) throw new Error(`${skill.dir}/SKILL.md could not be read`);
  const root = createPrivateStagingRoot(stagingRoot);
  const dir = fs.mkdtempSync(path.join(root, `${skill.name}-`));
  for (const f of files) {
    const dest = path.join(dir, ...f.rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, f.data, { mode: 0o600, flag: "wx" });
  }
  return dir;
}

/**
 * The repository's skills as listed skills. `taken` are names a platform default, a
 * plugin or the request already uses; those win, and the repository's skill of the
 * same name is left out. Staged on first `load_skill`, from whatever sandbox the run
 * holds at that moment.
 */
export function repoSkillsToList(
  skills: RepoSkill[], repoDir: string, taken: Set<string>,
  sandbox: () => Promise<RepoHands>, stagingRoot: string, signal?: AbortSignal,
): DefaultSkill[] {
  return skills.filter((s) => !taken.has(s.name)).map((s) => ({
    name: s.name,
    description: `[repository] ${s.description}`,
    toolId: 0,
    // Nothing is staged until the skill is loaded: SkillStore stages a skill whose directory does not exist.
    localDir: "",
    restage: async () => stageRepoSkill(await sandbox(), repoDir, s, stagingRoot, signal),
    source: "repo" as const,
    sandboxDir: s.dir,
  }));
}
