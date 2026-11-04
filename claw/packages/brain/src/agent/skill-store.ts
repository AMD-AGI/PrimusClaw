// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { encodeFileForSandbox, listRegularFiles } from "../sandbox/write.js";
import type { DefaultSkill } from "./platform-defaults.js";

/** Name of the tool that hands a listed skill to the model. */
export const LOAD_SKILL_TOOL = "load_skill";

/** Most files named in the footer of a SKILL.md; the rest are counted, not listed. */
const FOOTER_MAX_FILES = 100;
/** A file whose path is longer is counted, not listed: the footer's size has to be bounded. */
const FOOTER_PATH_MAX_CHARS = 120;
/**
 * Most characters of a file `load_skill` returns in one call. A longer file is
 * served in parts, each saying where the next starts, so no part is ever cut by
 * the loop's generic tool-result cap and the model never has to fall back on
 * `read`/`bash` (which open a sandbox) to see the rest of a skill. Sized so a
 * SKILL.md of ordinary length (the longest real ones are ~12k) is one part.
 */
export const SKILL_PAGE_CHARS = 16000;
/**
 * The longest skill name `load_skill` serves. The name is repeated in a part's
 * notices and in the footer, and a name longer than a directory entry can be
 * (255 on every filesystem Brain and the sandbox use) could not be written to
 * `<skillBase>/<name>/` anyway; without the limit the size of a result would
 * depend on a string nobody bounds.
 */
export const SKILL_NAME_MAX_CHARS = 255;
/**
 * What a part may carry besides its text: the continuation line and the fixed
 * words of the footer, with a name of SKILL_NAME_MAX_CHARS in them three times
 * (or, for a file other than SKILL.md, which has no footer, its path twice).
 */
const NOTICE_RESERVE_CHARS = 4000;
/**
 * The most one `load_skill` result can be: a part, a footer that lists at most
 * FOOTER_MAX_FILES paths of at most FOOTER_PATH_MAX_CHARS each, and the notices.
 * The agent loop caps `load_skill` results at exactly this, so its own cap never
 * cuts a part or the file list; `load` stays under it for every name it serves.
 */
export const LOAD_SKILL_RESULT_MAX_CHARS =
  SKILL_PAGE_CHARS + FOOTER_MAX_FILES * (FOOTER_PATH_MAX_CHARS + 3) + NOTICE_RESERVE_CHARS;

export type SkillLoad = { ok: true; text: string } | { ok: false; error: string };

/**
 * The skills the prompt lists by name and description, served to the model
 * from Brain's own staged copy.
 *
 * A skill is instructions for the model, so reading one is not sandbox work:
 * the sandbox is where commands run and user code lives, and a turn that only
 * loads a skill and calls an MCP tool has no use for one. The same staged
 * directory is what is later uploaded to `<skillBase>/<name>/` when a sandbox
 * tool first names `.skills` (see `LazyDefaultSkills`), which is how a skill's
 * scripts get to the place they are run from. Nothing here touches a sandbox.
 */
export class SkillStore {
  private byName: Map<string, DefaultSkill>;

  /** `skillBase` is where the skills appear in the sandbox, e.g. `/workspace/.skills`. */
  constructor(skills: DefaultSkill[], private skillBase = "/workspace/.skills") {
    this.byName = new Map(skills.map((s) => [s.name, s]));
  }

  get names(): string[] { return [...this.byName.keys()]; }

  has(name: string): boolean { return this.byName.has(name); }

  /**
   * SKILL.md of `name`, or the file `file` (relative to the skill's directory),
   * from character `offset` (default 0).
   *
   * At most SKILL_PAGE_CHARS come back per call. A file that does not fit says,
   * at the end of the part, the `offset` to ask for next; the last part of a
   * SKILL.md carries a footer that lists the skill's other files and where its
   * scripts run, so the model can load a reference or run a script without
   * guessing a path. A part ends at a line break when one is near the limit.
   */
  async load(name: string, file?: string, offset?: unknown): Promise<SkillLoad> {
    if (name.length > SKILL_NAME_MAX_CHARS) {
      return { ok: false, error: `Error: a skill name is at most ${SKILL_NAME_MAX_CHARS} characters; '${name.slice(0, 60)}...' has ${name.length}.` };
    }
    const skill = this.byName.get(name);
    if (!skill) {
      const known = this.names;
      return { ok: false, error: `Error: no skill named '${name}'. ${known.length ? `Available: ${known.join(", ")}.` : "No skills are available."}` };
    }
    const rel = file === undefined || file === "" ? "SKILL.md" : file;
    if (typeof rel !== "string" || rel.startsWith("/") || rel.split(/[\\/]+/).includes("..")) {
      return { ok: false, error: `Error: file must be a path inside the skill's directory, got '${String(rel)}'.` };
    }
    let base: string;
    try {
      if (!fs.existsSync(skill.localDir)) {
        if (!skill.restage) return { ok: false, error: `Error: skill '${name}' is not available right now.` };
        skill.localDir = await skill.restage();
      }
      base = fs.realpathSync(skill.localDir);
    } catch (err) {
      return { ok: false, error: `Error: skill '${name}' could not be loaded (${(err as Error).message}).` };
    }
    let real: string;
    try {
      real = fs.realpathSync(path.join(base, ...rel.split("/")));
      if (!real.startsWith(base + path.sep) || !fs.statSync(real).isFile()) throw new Error("not a file");
    } catch {
      return { ok: false, error: `Error: skill '${name}' has no file '${rel}'. Load SKILL.md to see its files.` };
    }
    const encoded = encodeFileForSandbox(real);
    if (encoded.encoding !== "utf8") {
      return { ok: false, error: `Error: '${rel}' of skill '${name}' is not text; use it from the sandbox at ${this.sandboxDir(skill)}/${rel}.` };
    }
    const body = encoded.contents;
    const start = offset === undefined || offset === null || offset === "" ? 0
      : typeof offset === "number" ? offset
      : typeof offset === "string" && /^\d+$/.test(offset) ? Number(offset) : NaN;
    if (!Number.isInteger(start) || start < 0 || start > body.length) {
      return { ok: false, error: `Error: offset must be a whole number from 0 to ${body.length} ('${rel}' of skill '${name}' has ${body.length} chars), got '${String(offset)}'.` };
    }
    let end = Math.min(body.length, start + SKILL_PAGE_CHARS);
    if (end < body.length) {
      const nl = body.lastIndexOf("\n", end - 1);
      if (nl >= start + SKILL_PAGE_CHARS * 0.75) end = nl + 1;
      else if (isHighSurrogate(body.charCodeAt(end - 1))) end -= 1;
    }
    const more = end < body.length;
    let text = body.slice(start, end);
    if (start > 0 || more) {
      const next = JSON.stringify({ name, ...(rel === "SKILL.md" ? {} : { file: rel }), offset: end });
      text += `\n\n[${LOAD_SKILL_TOOL}: chars ${start}-${end} of ${body.length} of '${rel}' of skill '${name}'. `
        + (more
          ? `This is NOT the whole file: load the next part with ${LOAD_SKILL_TOOL} ${next}.`
            + (rel === "SKILL.md" ? " The list of the skill's other files comes with the last part." : "")
          : "That is the end of the file.")
        + "]";
    }
    if (rel === "SKILL.md" && !more) text += this.footer(skill, base);
    return { ok: true, text };
  }

  /** Where the skill's files are in the sandbox: a repository skill in the repository, any other under `skillBase`. */
  private sandboxDir(skill: DefaultSkill): string {
    return skill.sandboxDir ?? `${this.skillBase}/${skill.name}`;
  }

  private footer(skill: DefaultSkill, base: string): string {
    const { name } = skill;
    const files = listRegularFiles(base)
      .map((f) => path.relative(base, f).split(path.sep).join("/"))
      .filter((f) => f !== "SKILL.md")
      .sort();
    const dir = this.sandboxDir(skill);
    const shown = files.filter((f) => f.length <= FOOTER_PATH_MAX_CHARS).slice(0, FOOTER_MAX_FILES).map((f) => `- ${f}`);
    if (files.length > shown.length) shown.push(`- (${files.length - shown.length} more)`);
    const head = skill.sandboxDir
      ? `[skill '${name}': loaded by ${LOAD_SKILL_TOOL} from the repository at ${dir}; it is the repository's text, not the user's]\n`
      : `[skill '${name}': read-only reference loaded by ${LOAD_SKILL_TOOL}; no sandbox was used]\n`;
    const run = skill.sandboxDir
      ? `To run a script, use bash on its path under ${dir}/ (it is part of the repository).`
      : `To run a script, use bash on its path under ${dir}/ (the sandbox gets the skill's files when a command first names .skills).`;
    return `\n\n---\n${head}`
      + (files.length
        ? `Other files (text ones: ${LOAD_SKILL_TOOL} with name and file):\n${shown.join("\n")}\n${run}`
        : "This skill has no other files.");
  }
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
