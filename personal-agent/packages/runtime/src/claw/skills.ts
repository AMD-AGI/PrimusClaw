// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  pyStr,
  type ClawCredential,
  type ClawSkill,
  type ClawSkillChange,
  type ClawSkillEntry,
  type ClawSkillsPort,
  type ClawSkillUndone,
} from "@primusclaw/personal-agent";
import { dataOf, objectOf, rowsOf } from "./answers.js";
import { type ClawHttp, segment } from "./http.js";

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function entryOf(row: Record<string, unknown>): ClawSkillEntry {
  const name = pyStr(row["name"]);
  if (!name) throw new ClawAnswerInvalid("a skill without its name");
  return {
    name,
    version: int(row["version"]) ?? 0,
    description: pyStr(row["description"]),
    enabled: row["enabled"] !== false,
    invocation: row["invocation"] === "manual" ? "manual" : "auto",
    imported: row["origin"] === "import",
    lastUsedAt: pyStr(row["last_used_at"]),
    files: int(row["files"]) ?? 0,
  };
}

function changeOf(answer: unknown, what: string): ClawSkillChange {
  const out = objectOf(answer, what);
  return {
    version: int(out["version"]),
    changed: out["changed"] !== false,
    changeId: pyStr(out["change_id"]),
    undoExpiresAt: pyStr(out["undo_expires_at"]),
  };
}

/** `ClawSkillsPort` over Claw's HTTP API: the person's own skills, always as them. */
export class HttpSkills implements ClawSkillsPort {
  constructor(private readonly http: ClawHttp) {}

  async list(key: ClawCredential): Promise<ClawSkillEntry[]> {
    const answer = await this.http.json({ method: "GET", path: "/v1/users/me/skills?view=current", key });
    return rowsOf(answer, "the skills").map(entryOf);
  }

  async show(key: ClawCredential, name: string): Promise<ClawSkill> {
    const answer = await this.http.json({
      method: "GET",
      path: `/v1/users/me/skills/${segment(name)}?view=current`,
      key,
    });
    const data = dataOf(answer, "a skill");
    const files = Array.isArray(data["file_list"]) ? (data["file_list"] as unknown[]) : [];
    return {
      ...entryOf(data),
      content: pyStr(data["content"]),
      fileList: files.flatMap((f) =>
        typeof f === "object" && f !== null && typeof (f as Record<string, unknown>)["path"] === "string"
          ? [
              {
                path: pyStr((f as Record<string, unknown>)["path"]),
                sizeBytes: int((f as Record<string, unknown>)["size_bytes"]) ?? 0,
              },
            ]
          : [],
      ),
    };
  }

  async setEnabled(key: ClawCredential, name: string, enabled: boolean): Promise<ClawSkillChange> {
    const verb = enabled ? "enable" : "disable";
    return changeOf(
      await this.http.json({ method: "POST", path: `/v1/users/me/skills/${segment(name)}/${verb}`, key, body: {} }),
      "a switch",
    );
  }

  async remove(key: ClawCredential, name: string): Promise<ClawSkillChange> {
    return changeOf(
      await this.http.json({ method: "DELETE", path: `/v1/users/me/skills/${segment(name)}`, key }),
      "a delete",
    );
  }

  async update(
    key: ClawCredential,
    name: string,
    skill: { readonly content: string; readonly description: string },
  ): Promise<ClawSkillChange> {
    const body = { content: skill.content, description: skill.description };
    return changeOf(
      await this.http.json({ method: "PUT", path: `/v1/users/me/skills/${segment(name)}`, key, body }),
      "an edit",
    );
  }

  async undo(key: ClawCredential, changeId: string): Promise<ClawSkillUndone> {
    const answer = await this.http.json({
      method: "POST",
      path: `/v1/users/me/skill-changes/${segment(changeId)}/undo`,
      key,
      body: {},
    });
    const data = dataOf(answer, "an undo");
    return { undone: pyStr(data["undone"]), name: pyStr(data["name"]), version: int(data["version"]) };
  }
}
