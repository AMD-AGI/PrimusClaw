// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A table looked up with words a person (or Claw) wrote answers only for its own entries: the names an object inherits
// (`constructor`, `__proto__`, `toString`, ...) are no entry, as a Python dict has none of them.
import assert from "node:assert/strict";
import { test } from "node:test";

import { spokenDuration, spokenNumber } from "../../src/capabilities/spoken.js";
import { menuCommand } from "../../src/commands/parse.js";
import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

const INHERITED = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];

test("a menu word that is a name every object has is no menu word", () => {
  for (const word of INHERITED) {
    assert.equal(menuCommand(word), word, word); // (Python: MENU_COMMANDS.get(word) is None, the text stays)
    assert.equal(menuCommand(word, true), word, word);
    assert.equal(menuCommand(`/${word}`), `/${word}`, word);
  }
});

test("lang with a name every object has is told the usage and changes nothing", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  for (const word of INHERITED) {
    await w.router.handle(message(`/lang ${word}`));
    assert.equal(said(w).at(-1), "Use `/lang zh`, `/lang en` or `/lang auto`.", word);
    assert.equal(w.store.prefs.getPrefs(ALICE.id).langSet, false, word);
  }
});

test("a number or a unit that is a name every object has is none", () => {
  for (const word of INHERITED) {
    assert.equal(spokenNumber(word), null, word);
    assert.equal(spokenNumber(`${word}十`), null, word);
    assert.equal(spokenNumber(`十${word}`), null, word);
    assert.equal(spokenDuration("2", word), null, word);
  }
});

test("a review stop refused with a code that is a name every object has says that code", async () => {
  for (const code of INHERITED) {
    const w = world({ assistant: { understands: () => true } });
    Object.assign(w.deps, { reviewStop: () => [["", 825]] as const });
    Object.assign(w.deps.claw.workItems, {
      list: () => Promise.resolve([{ itemId: "it-1", kind: "review", pull: { owner: "o", repo: "r", number: 825 } }]),
      stop: () => Promise.resolve({ ok: false, error: code }),
    });
    link(w, ALICE.id, "ak");
    const m = message("停 825", { kind: "group", conversation: "g-1" });
    await w.router.group.reviewStopInterceptor().intercept({
      sender: ALICE,
      conversation: w.surface.conversation(m.conversation),
      scope: "g-1",
      lang: () => "zh",
      message: m,
      text: m.text,
    });
    assert.equal(said(w).at(-1), `o/r#825：没能停下（${code}）。`, code);
  }
});

test("memory with a name every object has is told the usage and switches nothing", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  for (const word of INHERITED) {
    await w.router.handle(message(`/memory ${word}`));
    assert.equal(
      said(w).at(-1),
      "Use `/memory on` to turn memory on, `/memory off` to turn it off, or `/memory` alone to see it.",
      word,
    );
  }
  assert.deepEqual(w.claw.memoryWrites, []);
});
