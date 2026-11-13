// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ClawCredential } from "../../claw/credential.js";

/** One of the person's personal skills as `/skills` lists it: the current version of each name, turned off ones included. */
export interface ClawSkillEntry {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly enabled: boolean;
  /** `manual`: used only when the person names it. */
  readonly invocation: "auto" | "manual";
  /** Imported from someone else. */
  readonly imported: boolean;
  /** When a turn last read it (ISO), or "" never. */
  readonly lastUsedAt: string;
  readonly files: number;
}

/** One skill whole: SKILL.md and its files. */
export interface ClawSkill extends ClawSkillEntry {
  readonly content: string;
  readonly fileList: readonly { readonly path: string; readonly sizeBytes: number }[];
}

/** A change Claw made that the person can take back (`change_id`), and until when (ISO, "" not said). */
export interface ClawSkillChange {
  readonly version: number | null;
  readonly changed: boolean;
  readonly changeId: string;
  readonly undoExpiresAt: string;
}

/** What an undo did: `deleted`, `restored_version`, `restored`, `enabled` or `disabled`. */
export interface ClawSkillUndone {
  readonly undone: string;
  readonly name: string;
  readonly version: number | null;
}

/**
 * The person's personal skills (`/v1/users/me/skills`, `/v1/users/me/skill-changes`), always as that person. ClawError(404): no such
 * skill, change or route (a Claw without them); ClawError(409/410): the change cannot be undone (`reason`, in the error's text).
 */
export interface ClawSkillsPort {
  list(key: ClawCredential): Promise<ClawSkillEntry[]>;
  show(key: ClawCredential, name: string): Promise<ClawSkill>;
  setEnabled(key: ClawCredential, name: string, enabled: boolean): Promise<ClawSkillChange>;
  remove(key: ClawCredential, name: string): Promise<ClawSkillChange>;
  /** Saves new text (and description) for one of the person's skills as its next version. */
  update(
    key: ClawCredential,
    name: string,
    skill: { readonly content: string; readonly description: string },
  ): Promise<ClawSkillChange>;
  undo(key: ClawCredential, changeId: string): Promise<ClawSkillUndone>;
}
