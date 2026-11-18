// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SkillCardEvent } from "../assistant/events.js";
import type { ClawSkill, ClawSkillEntry } from "../ports/claw/skills.js";

/** The lines of SKILL.md a card shows. */
const PREVIEW_LINES = 30;
const PREVIEW_CHARS = 1500;

function preview(content: string): string {
  const lines = content.split(/\r?\n/u).slice(0, PREVIEW_LINES).join("\n");
  const all = Array.from(lines);
  return all.length > PREVIEW_CHARS ? `${all.slice(0, PREVIEW_CHARS - 1).join("")}…` : lines;
}

/** A skill Claw answered, as a card shows it (`kind`, and the change its Undo takes back, "" none). */
export function skillCardOfSkill(
  skill: ClawSkillEntry & Partial<Pick<ClawSkill, "content" | "fileList">>,
  kind: SkillCardEvent["kind"],
  changeId: string,
): SkillCardEvent {
  return {
    kind,
    name: skill.name,
    version: skill.version,
    created: false,
    description: skill.description,
    manual: skill.invocation === "manual",
    files: (skill.fileList ?? []).map((f) => f.path),
    preview: kind === "deleted" || skill.content === undefined ? "" : preview(skill.content),
    changeId,
  };
}
