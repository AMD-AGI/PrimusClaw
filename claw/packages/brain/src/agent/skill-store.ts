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
   * SKILL.md of `name`, or the file `file` (relative to the skill's directory).
   * A SKILL.md comes with a footer that lists the skill's other files and where
   * its scripts run, so the model can load a reference or run a script without
   * guessing a path.
   */
  async load(name: string, file?: string): Promise<SkillLoad> {
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
      return { ok: false, error: `Error: '${rel}' of skill '${name}' is not text; use it from the sandbox at ${this.skillBase}/${name}/${rel}.` };
    }
    return { ok: true, text: rel === "SKILL.md" ? encoded.contents + this.footer(name, base) : encoded.contents };
  }

  private footer(name: string, base: string): string {
    const files = listRegularFiles(base)
      .map((f) => path.relative(base, f).split(path.sep).join("/"))
      .filter((f) => f !== "SKILL.md")
      .sort();
    const dir = `${this.skillBase}/${name}`;
    const shown = files.slice(0, FOOTER_MAX_FILES).map((f) => `- ${f}`);
    if (files.length > shown.length) shown.push(`- (${files.length - shown.length} more)`);
    return `\n\n---\n[skill '${name}': read-only reference loaded by ${LOAD_SKILL_TOOL}; no sandbox was used]\n`
      + (files.length
        ? `Other files (text ones: ${LOAD_SKILL_TOOL} with name and file):\n${shown.join("\n")}\n`
          + `To run a script, use bash on its path under ${dir}/ (the sandbox gets the skill's files when a command first names .skills).`
        : "This skill has no other files.");
  }
}
