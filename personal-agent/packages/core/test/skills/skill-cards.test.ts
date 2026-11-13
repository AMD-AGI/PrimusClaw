// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The person's personal skills in the chat: a skill's card (`skill_card` of an `assistant.say`), its buttons through the real router,
 * and `/skills`, against a fake of Claw's skill routes that answers as Claw does.
 *
 *   SK1 a saved skill's card: recorded first (its Undo names the change), holds all the words, Undo and Edit
 *   SK1b a deleted or turned off one has Undo only; a draft's card is its held write (Save and Discard); one Claw sent badly is no
 *        card, the words still go
 *   SK2 Undo: the change is taken back in Claw as the presser, once (a second press, or two at once, sends nothing again), and the
 *       card says what it is now; a change that can no longer be undone (changed since, lapsed, undone) says why
 *   SK3 a card that is not the presser's, unknown, or not a skill's, does nothing; a held write's button on a skill card's record does
 *       nothing either
 *   SK4 Edit: the skill's text and description to change, from Claw as it is now; Save changes saves them as the next version and
 *       shows its card, whose Undo takes that back; a refusal (a secret) gives the form back with why, nothing saved; a skill too long
 *       to edit on a card says so
 *   SK5 Save and Discard on a draft: answered as a held write, as the person with their exchanged token, and said plainly
 *   SK6 /skills: lists (off and only-when-named marked), shows one, turns one off, on or deletes it with its card and Undo; a name it
 *       does not have, a Claw without the routes, and a wrong form are each said; never in a group chat
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantWorld } from "../../../../test-support/assistant/assistant-world.js";
import { ClawError } from "../../src/claw/errors.js";
import { skillCardOf } from "../../src/assistant/events.js";
import { confirmOutcome } from "../../src/assistant/confirm-outcome.js";
import { SayPlanner } from "../../src/assistant/say.js";
import { SkillCardClicks } from "../../src/skills/clicks.js";
import { SkillsCommand } from "../../src/skills/command.js";
import { SKILL_UNDO_KIND } from "../../src/skills/views.js";
import type {
  ClawSkill,
  ClawSkillChange,
  ClawSkillEntry,
  ClawSkillsPort,
  ClawSkillUndone,
} from "../../src/ports/claw/skills.js";
import { silentLogger } from "../../src/ports/logger.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { ALICE, BOB } from "../routing/fixtures.js";
import { clickOf, link, message, said, world } from "../routing/world.js";

const VERB = "assistant_skill";
const STANDUP = "## 何时用\n写站会纪要时。\n## 步骤\n1. 昨天完成\n2. 今天计划\n3. 阻塞";

function viewOf(message: OutMessage | undefined) {
  const body = message?.body;
  assert.ok(body?.type === "view", `a view, not ${JSON.stringify(body)}`);
  return body.view;
}

/** Claw's skill routes, as they answer: one person's skills, the changes it made, each undone at most once. */
class FakeSkills implements ClawSkillsPort {
  readonly calls: string[] = [];
  readonly skills = new Map<string, ClawSkill>();
  readonly undone = new Set<string>();
  /** The next call fails with this. */
  fail: Error | null = null;
  private n = 0;

  constructor() {
    this.skills.set("standup-notes", {
      name: "standup-notes",
      version: 1,
      description: "写站会纪要时使用",
      enabled: true,
      invocation: "auto",
      imported: false,
      lastUsedAt: "",
      files: 1,
      content: STANDUP,
      fileList: [{ path: "templates/notes.md", sizeBytes: 12 }],
    });
    this.skills.set("deploy-prod", {
      name: "deploy-prod",
      version: 3,
      description: "Deploy to production",
      enabled: false,
      invocation: "manual",
      imported: false,
      lastUsedAt: "",
      files: 0,
      content: "## Steps\n1. deploy",
      fileList: [],
    });
  }

  private next(key: string, call: string): void {
    this.calls.push(`${key} ${call}`);
    const fail = this.fail;
    this.fail = null;
    if (fail) throw fail;
  }

  private change(version: number | null): ClawSkillChange {
    this.n += 1;
    return { version, changed: true, changeId: `chg-${String(this.n)}`, undoExpiresAt: "2026-11-14T00:00:00Z" };
  }

  list(key: string): Promise<ClawSkillEntry[]> {
    this.next(key, "list");
    return Promise.resolve([...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  show(key: string, name: string): Promise<ClawSkill> {
    this.next(key, `show ${name}`);
    const s = this.skills.get(name);
    return s ? Promise.resolve(s) : Promise.reject(new ClawError(404, '{"ok":false,"error":"skill not found"}'));
  }

  setEnabled(key: string, name: string, enabled: boolean): Promise<ClawSkillChange> {
    this.next(key, `${enabled ? "enable" : "disable"} ${name}`);
    const s = this.skills.get(name);
    if (!s) return Promise.reject(new ClawError(404, "{}"));
    if (s.enabled === enabled)
      return Promise.resolve({ version: s.version, changed: false, changeId: "", undoExpiresAt: "" });
    this.skills.set(name, { ...s, enabled });
    return Promise.resolve(this.change(s.version));
  }

  remove(key: string, name: string): Promise<ClawSkillChange> {
    this.next(key, `delete ${name}`);
    const s = this.skills.get(name);
    if (!s) return Promise.reject(new ClawError(404, "{}"));
    this.skills.delete(name);
    return Promise.resolve(this.change(s.version));
  }

  update(
    key: string,
    name: string,
    skill: { readonly content: string; readonly description: string },
  ): Promise<ClawSkillChange> {
    this.next(key, `update ${name}`);
    if (skill.content.includes("ghp_")) {
      return Promise.reject(
        new ClawError(
          400,
          '{"ok":false,"error":"not saved: SKILL.md line 2 looks like a credential (github_token)","reason":"secret"}',
        ),
      );
    }
    const s = this.skills.get(name);
    if (!s) return Promise.reject(new ClawError(404, "{}"));
    this.skills.set(name, { ...s, content: skill.content, description: skill.description, version: s.version + 1 });
    return Promise.resolve(this.change(s.version + 1));
  }

  undo(key: string, changeId: string): Promise<ClawSkillUndone> {
    this.next(key, `undo ${changeId}`);
    if (this.undone.has(changeId))
      return Promise.reject(new ClawError(409, '{"ok":false,"error":"undone","reason":"undone"}'));
    this.undone.add(changeId);
    return Promise.resolve({ undone: "deleted", name: "standup-notes", version: 1 });
  }
}

async function skillWorld() {
  const aw = await AssistantWorld.start();
  const skills = new FakeSkills();
  const clicks = new SkillCardClicks({ store: aw.store, skills, logger: silentLogger });
  const command = new SkillsCommand({ store: aw.store, skills, logger: silentLogger });
  const w = world({
    testStore: { store: aw.store, clock: aw.clock, encryptionKeys: [] },
    assistantChat: aw.chat,
    ...(aw.subs ? { subscriptions: aw.subs } : {}),
    handlers: { clicks: [clicks], commands: [command] },
  });
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  const planner = new SayPlanner({
    store: aw.store,
    exactCommand: () => false,
    style: () => ({ citations: true, suggestedReplies: true }),
  });
  return { aw, w, skills, planner };
}

const SAVED = {
  kind: "saved",
  name: "standup-notes",
  version: 1,
  created: true,
  description: "写站会纪要时使用",
  invocation: "auto",
  files: [{ path: "templates/notes.md", size_bytes: 12 }],
  preview: STANDUP,
  change_id: "c0ffee00-0000-4000-8000-000000000001",
  undo_expires_at: "2026-11-14T00:00:00Z",
};
const TEXT = "已存为你的个人技能「standup-notes」v1。";

test("SK1 a skill's card: recorded first, holding its words; Undo and Edit; a draft is its held write; a bad one is words", async () => {
  const { aw, planner } = await skillWorld();
  const out = planner.messages(ALICE.id, { type: "assistant.say", text: TEXT, skill_card: SAVED });
  assert.equal(out.length, 1, "the card holds all the words");
  const view = viewOf(out[0]);
  assert.ok(view.name === "skillCard");
  assert.deepEqual(
    [view.model.skill.kind, view.model.skill.name, view.model.skill.created, view.model.skill.files, view.model.lang],
    ["saved", "standup-notes", true, ["templates/notes.md"], "zh"],
  );
  const record = aw.store.assistantButtons.getConfirmCard(view.model.cardId);
  assert.deepEqual(
    [record?.userId, record?.kind, record?.confirmationId, record?.label, record?.state],
    [ALICE.id, SKILL_UNDO_KIND, SAVED.change_id, "standup-notes", "open"],
  );
  assert.equal(
    out[0]?.body.type === "view" ? out[0].body.fallbackText : "",
    TEXT,
    "a channel without cards says the words",
  );
});

test("SK1b a deleted skill's card has Undo, a draft's is its held write, and one Claw sent badly is no card", async () => {
  const { aw, planner } = await skillWorld();
  const deleted = viewOf(
    planner.messages(ALICE.id, {
      type: "assistant.say",
      text: "已删除",
      skill_card: { ...SAVED, kind: "deleted", preview: "" },
    })[0],
  );
  assert.ok(deleted.name === "skillCard" && deleted.model.skill.kind === "deleted" && deleted.model.cardId);

  const draft = planner.messages(ALICE.id, {
    type: "assistant.say",
    text: "我起草了一个个人技能",
    skill_card: { ...SAVED, kind: "draft", change_id: undefined, confirmation_id: "conf-1" },
    confirm_write: {
      confirmation_id: "conf-1",
      ref: "abc123",
      kind: "skill_save",
      allow_label: "保存",
      expires_at: "2026-11-14T00:00:00Z",
    },
  });
  const d = viewOf(draft[0]);
  assert.ok(d.name === "skillCard" && d.model.skill.kind === "draft" && d.model.allowLabel === "保存");
  const held = aw.store.assistantButtons.getConfirmCard(d.model.cardId);
  assert.deepEqual(
    [held?.kind, held?.confirmationId],
    ["skill_save", "conf-1"],
    "Save and Discard answer the held write",
  );

  for (const bad of [{ ...SAVED, name: "../x" }, { ...SAVED, kind: "exploded" }, "standup-notes", null]) {
    const plain = planner.messages(ALICE.id, { type: "assistant.say", text: TEXT, skill_card: bad });
    assert.deepEqual(
      plain.map((m) => m.body.type),
      ["rich"],
      `no card for ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(skillCardOf({ type: "work_item.needs_you", skill_card: SAVED }), undefined, "a say's only");
  assert.equal(
    skillCardOf({ type: "assistant.say", skill_card: { ...SAVED, change_id: "x y" } })?.changeId,
    "",
    "an id a button cannot carry is none",
  );
});

test("SK2 Undo takes the change back in Claw as the presser, once, and says what it is now; one that cannot be undone says why", async () => {
  const { w, skills, planner } = await skillWorld();
  const card = viewOf(planner.messages(ALICE.id, { type: "assistant.say", text: TEXT, skill_card: SAVED })[0]);
  assert.ok(card.name === "skillCard");
  const press = () => w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "undo", card: card.model.cardId }));
  await Promise.all([press(), press()]);
  await press();
  await w.router.settled();
  assert.deepEqual(skills.calls, [`ak-alice undo ${SAVED.change_id}`], "sent once, as the presser");
  assert.ok(said(w).includes("Undone: standup-notes is deleted again."), said(w).join("|"));

  const second = viewOf(
    planner.messages(ALICE.id, {
      type: "assistant.say",
      text: TEXT,
      skill_card: { ...SAVED, change_id: "c0ffee00-0000-4000-8000-000000000002" },
    })[0],
  );
  assert.ok(second.name === "skillCard");
  skills.fail = new ClawError(409, '{"ok":false,"error":"the skill changed","reason":"changed"}');
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "undo", card: second.model.cardId }));
  await w.router.settled();
  assert.ok(
    said(w).some((l) => l.startsWith("Not undone: standup-notes has changed since")),
    said(w).join("|"),
  );
});

test("SK3 a card that is not the presser's, unknown or not a skill's does nothing; a held write's button on its record neither", async () => {
  const { aw, w, skills, planner } = await skillWorld();
  const card = viewOf(planner.messages(ALICE.id, { type: "assistant.say", text: TEXT, skill_card: SAVED })[0]);
  assert.ok(card.name === "skillCard");
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "undo", card: card.model.cardId }, { user: BOB }));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "undo", card: "nope" }));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "explode", card: card.model.cardId }));
  const held = aw.store.assistantButtons.addConfirmCard(ALICE.id, "conf-9", "trigger_create", "Create");
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "undo", card: held }));
  await w.router.settled();
  assert.deepEqual(skills.calls, [], "nothing reached Claw");
  assert.equal(
    aw.store.assistantButtons.getConfirmCard(card.model.cardId)?.state,
    "open",
    "the card is still the person's to press",
  );
});

test("SK4 Edit shows the skill as it is now; Save changes saves the next version with its own Undo; a refusal gives the form back", async () => {
  const { aw, w, skills, planner } = await skillWorld();
  const card = viewOf(planner.messages(ALICE.id, { type: "assistant.say", text: TEXT, skill_card: SAVED })[0]);
  assert.ok(card.name === "skillCard");
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "edit", card: card.model.cardId }));
  await w.router.settled();
  const form = viewOf(w.surface.outbox.filter((r) => r.op === "update").at(-1)?.message);
  assert.ok(form.name === "skillEdit");
  assert.deepEqual(
    [form.model.name, form.model.content, form.model.description],
    ["standup-notes", STANDUP, "写站会纪要时使用"],
  );

  await w.router.handle(
    clickOf(VERB, {
      primusclaw: VERB,
      op: "save_edit",
      card: card.model.cardId,
      skill_content: "## 步骤\nghp_xxx",
      skill_description: "站会",
    }),
  );
  await w.router.settled();
  const again = viewOf(w.surface.outbox.filter((r) => r.op === "update").at(-1)?.message);
  assert.ok(again.name === "skillEdit" && again.model.note.includes("looks like a credential"), "why, on the form");
  assert.equal(skills.skills.get("standup-notes")?.version, 1, "nothing saved");

  await w.router.handle(
    clickOf(VERB, {
      primusclaw: VERB,
      op: "save_edit",
      card: card.model.cardId,
      skill_content: `${STANDUP}\n4. 风险`,
      skill_description: "站会纪要",
    }),
  );
  await w.router.settled();
  const saved = viewOf(w.surface.outbox.filter((r) => r.op === "update").at(-1)?.message);
  assert.ok(saved.name === "skillCard");
  assert.deepEqual(
    [saved.model.skill.kind, saved.model.skill.version, saved.model.skill.description],
    ["saved", 2, "站会纪要"],
  );
  const next = aw.store.assistantButtons.getConfirmCard(saved.model.cardId);
  assert.deepEqual([next?.kind, next?.confirmationId], [SKILL_UNDO_KIND, "chg-1"], "its Undo takes the edit back");
  assert.equal(aw.store.assistantButtons.getConfirmCard(card.model.cardId)?.state, "done", "the old card is used up");

  const now = skills.skills.get("standup-notes");
  assert.ok(now);
  skills.skills.set("standup-notes", { ...now, content: "x".repeat(7000) });
  const big = aw.store.assistantButtons.addConfirmCard(ALICE.id, "chg-7", SKILL_UNDO_KIND, "standup-notes");
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, op: "edit", card: big }));
  await w.router.settled();
  assert.ok(
    said(w).some((l) => l.includes("too long to edit on a card")),
    "too long for a card",
  );
});

test("SK5 Save and Discard on a draft are said plainly", () => {
  assert.equal(
    confirmOutcome(
      "skill_save",
      { status: "done", answered_now: true, result: { ok: true, name: "deploy-check", version: 1 } },
      "zh",
    ),
    "已存为你的技能：deploy-check v1。",
  );
  assert.equal(confirmOutcome("skill_save", { status: "denied" }, "en"), "Discarded: nothing was saved.");
  assert.match(
    confirmOutcome(
      "skill_save",
      { status: "failed", result: { ok: false, error: "secret", message: "SKILL.md line 3 looks like a credential" } },
      "en",
    ),
    /^Not saved: SKILL\.md line 3/,
  );
});

test("SK6 /skills lists, shows, turns off, on and deletes, with Undo; says what it cannot do; never in a group", async () => {
  const { aw, w, skills } = await skillWorld();
  await w.router.handle(message("/skills"));
  await w.router.handle(message("/skills show standup-notes"));
  await w.router.handle(message("/skills disable standup-notes"));
  await w.router.handle(message("/skills enable deploy-prod"));
  await w.router.handle(message("/skills delete nope"));
  await w.router.handle(message("/skills frobnicate"));
  await w.router.settled();
  const lines = said(w);
  const list = lines.find((l) => l.includes("Your skills (2)")) ?? "";
  assert.ok(list.includes("**deploy-prod** v3 (off) (only when named): Deploy to production"), list);
  assert.ok(list.includes("**standup-notes** v1: 写站会纪要时使用"));
  assert.ok(
    lines.some((l) => l.includes("1. 昨天完成") && l.includes("templates/notes.md")),
    "show: its text and files",
  );
  assert.equal(
    lines.filter((l) => l === "<view:skillCard>").length,
    2,
    "disable and enable answer with the skill's card",
  );
  assert.equal(skills.skills.get("standup-notes")?.enabled, false);
  assert.equal(skills.skills.get("deploy-prod")?.enabled, true);
  assert.ok(lines.some((l) => l.startsWith("You have no skill named nope")));
  assert.ok(lines.some((l) => l.startsWith("Use /skills, /skills show")));
  const cards = w.surface.outbox.flatMap((r) =>
    r.op === "send" && r.message.body.type === "view" ? [viewOf(r.message)] : [],
  );
  const off = cards.find((c) => c.name === "skillCard" && c.model.skill.kind === "disabled");
  assert.ok(
    off?.name === "skillCard" && aw.store.assistantButtons.getConfirmCard(off.model.cardId)?.kind === SKILL_UNDO_KIND,
  );

  skills.fail = new ClawError(404, "Not Found");
  await w.router.handle(message("/skills"));
  await w.router.handle(message("/skills", { kind: "group" }));
  await w.router.settled();
  assert.ok(said(w).some((l) => l === "Personal skills are not available on this Claw."));
  assert.equal(skills.calls.filter((c) => c === "ak-alice list").length, 5, "the group chat's /skills reached nothing");
});
