// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The person's personal skills over Claw's HTTP API (`HttpSkills`): the routes it calls as them, and what it reads of the answers. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawAnswerInvalid, ClawError } from "@primusclaw/personal-agent";
import { json, Wire, type Sent } from "./wire.js";

/** Where a request went: its path and query. */
const where = (sent: Sent | undefined): string => (sent ? `${sent.rawPath}${sent.url.search}` : "");

describe("a person's skills", () => {
  it("list and show: the current version of each, off and manual marked; one whole with its files", async () => {
    const wire = new Wire((sent: Sent) =>
      sent.rawPath.endsWith("/skills")
        ? json(200, {
            data: [
              {
                name: "standup-notes",
                version: 2,
                description: "站会",
                enabled: true,
                invocation: "auto",
                origin: "chat",
                last_used_at: null,
                files: 1,
              },
              {
                name: "deploy-prod",
                version: 1,
                description: "deploy",
                enabled: false,
                invocation: "manual",
                origin: "import",
                files: 0,
              },
            ],
          })
        : json(200, {
            data: {
              name: "standup-notes",
              version: 2,
              description: "站会",
              enabled: true,
              content: "## steps",
              file_list: [{ path: "templates/a.md", size_bytes: 3 }, { nope: 1 }],
            },
          }),
    );
    const listed = await wire.client().skills.list("ak-a");
    assert.equal(where(wire.sent[0]), "/v1/users/me/skills?view=current");
    assert.deepEqual(
      listed.map((s) => [s.name, s.version, s.enabled, s.invocation, s.imported, s.lastUsedAt]),
      [
        ["standup-notes", 2, true, "auto", false, ""],
        ["deploy-prod", 1, false, "manual", true, ""],
      ],
    );
    const one = await wire.client().skills.show("ak-a", "standup-notes");
    assert.equal(where(wire.sent.at(-1)), "/v1/users/me/skills/standup-notes?view=current");
    assert.deepEqual([one.content, one.fileList], ["## steps", [{ path: "templates/a.md", sizeBytes: 3 }]]);
    wire.answer = () => json(200, { data: [{ version: 1 }] });
    await assert.rejects(wire.client().skills.list("ak-a"), ClawAnswerInvalid);
  });
});

describe("changing a person's skills", () => {
  it("turn off, on, delete, edit and undo: the change to undo, as Claw answers it; a refusal is ClawError with Claw's words", async () => {
    const wire = new Wire(() =>
      json(200, {
        ok: true,
        enabled: false,
        changed: true,
        version: 2,
        change_id: "chg-1",
        undo_expires_at: "2026-11-14T00:00:00Z",
      }),
    );
    const c = wire.client().skills;
    assert.deepEqual(await c.setEnabled("ak-a", "standup-notes", false), {
      version: 2,
      changed: true,
      changeId: "chg-1",
      undoExpiresAt: "2026-11-14T00:00:00Z",
    });
    assert.deepEqual(
      [wire.sent.at(-1)?.method, where(wire.sent.at(-1))],
      ["POST", "/v1/users/me/skills/standup-notes/disable"],
    );
    await c.setEnabled("ak-a", "standup-notes", true);
    assert.equal(where(wire.sent.at(-1)), "/v1/users/me/skills/standup-notes/enable");
    await c.remove("ak-a", "standup-notes");
    assert.deepEqual(
      [wire.sent.at(-1)?.method, where(wire.sent.at(-1))],
      ["DELETE", "/v1/users/me/skills/standup-notes"],
    );
    await c.update("ak-a", "standup-notes", { content: "## new", description: "站会纪要" });
    assert.deepEqual(
      [wire.sent.at(-1)?.method, wire.sent.at(-1)?.body],
      ["PUT", { content: "## new", description: "站会纪要" }],
    );
    wire.answer = () =>
      json(200, { ok: true, data: { ok: true, op: "create", name: "standup-notes", version: 1, undone: "deleted" } });
    assert.deepEqual(await c.undo("ak-a", "chg-1"), { undone: "deleted", name: "standup-notes", version: 1 });
    assert.deepEqual(
      [wire.sent.at(-1)?.method, where(wire.sent.at(-1))],
      ["POST", "/v1/users/me/skill-changes/chg-1/undo"],
    );
    wire.answer = () => json(409, { ok: false, error: "the skill changed", reason: "changed" });
    await assert.rejects(
      c.undo("ak-a", "chg-1"),
      (e: unknown) => e instanceof ClawError && e.status === 409 && e.detail.includes('"reason":"changed"'),
    );
  });
});
