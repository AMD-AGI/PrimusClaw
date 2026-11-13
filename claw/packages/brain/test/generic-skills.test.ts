// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The generic skills in claw/skills/: each one a directory holding a SKILL.md whose
 * frontmatter names it and says when to use it, short enough for the skill list, and
 * free of any product, site or company name (Claw ships them to every deployment).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DESCRIPTION_MAX, SKILL_NAME_RE, skillDescription } from "../src/agent/platform-defaults.js";

const SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");
// The chat client's former default name is built from pieces, so that this file does not contain it (`assistant-name-neutral.test.ts`).
const PRODUCT_NAMES = new RegExp(`\\b(amd|primus|safe|dispatron|hyperloom|${["cla", "wy"].join("")}|teams|claw|autopilot|spur|crusoe|harbor)\\b`, "i");

test("every generic skill is a named, described, product-neutral SKILL.md", () => {
  const names = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(names, ["charts", "documents", "pdf", "spreadsheets", "web-research"]);
  for (const name of names) {
    const text = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(fm, `${name}: frontmatter`);
    const meta = YAML.parse(fm[1]) as { name?: string; description?: string };
    assert.equal(meta.name, name, `${name}: the frontmatter name is the directory's`);
    assert.ok(SKILL_NAME_RE.test(name));
    assert.ok(meta.description && meta.description.length <= DESCRIPTION_MAX, `${name}: a description the list shows whole`);
    assert.equal(skillDescription(text, name), meta.description, `${name}: the list shows the frontmatter description`);
    const hit = PRODUCT_NAMES.exec(text);
    assert.equal(hit, null, `${name}: names '${hit?.[0]}'`);
  }
});
