// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANGE_SUMMARY_RULE, changeHeading, messageContent, ruleHeading, withoutRule } from "../../src/index.js";

/** The headings as the Teams worker has always written them. */
const RULE_HEADING = "## Teams reply style (formatting only, facts unchanged)";
const CHANGE_HEADING = "## Teams change summary (only when files in a git repository changed)";

const RULE = "Write this reply for a Microsoft Teams chat.\n1. Open with a one-line answer in bold.";
const CHANGE = `${CHANGE_HEADING}\n\n${CHANGE_SUMMARY_RULE}`;

describe("withoutRule", () => {
  const sent = {
    "the rule alone": `how are the plans?\n\n${RULE_HEADING}\n\n${RULE}`,
    both: `how are the plans?\n\n${CHANGE}\n\n${RULE_HEADING}\n\n${RULE}`,
    "the summary request alone": `how are the plans?\n\n${CHANGE}`,
    "nothing appended": "how are the plans?",
  };
  for (const [what, text] of Object.entries(sent)) {
    it(`takes back only what the worker appended: ${what}`, () => {
      assert.equal(withoutRule(text), "how are the plans?");
    });
  }

  const mine = {
    "quoting both headings": `why is this appended?\n\n${CHANGE_HEADING}\n\nstuff\n\n${RULE_HEADING}\n\nmore of my words`,
    "quoting the whole section": `I copied this from a message of yours:\n\n${CHANGE}\n\nwhat does it mean?`,
  };
  const appended = {
    both: `\n\n${CHANGE}\n\n${RULE_HEADING}\n\n${RULE}`,
    "the summary request only": `\n\n${CHANGE}`,
  };
  for (const [whose, text] of Object.entries(mine)) {
    for (const [what, tail] of Object.entries(appended)) {
      it(`a user who types the headings keeps every word they wrote: ${whose}, ${what}`, () => {
        assert.equal(withoutRule(text + tail), text);
      });
    }
  }

  it("a message from before the summary request is cut at the rule's heading", () => {
    assert.equal(withoutRule(`first\n\n${RULE_HEADING}\n\n${RULE}`), "first");
  });

  it("keeps the user's own blank lines", () => {
    assert.equal(withoutRule(`first\n\nsecond\n\n${CHANGE}\n\n${RULE_HEADING}\n\n${RULE}`), "first\n\nsecond");
  });
});

describe("messageContent", () => {
  it("puts the summary request first, then the rule", () => {
    assert.equal(messageContent("hi", RULE, true, "Teams"), `hi\n\n${CHANGE}\n\n${RULE_HEADING}\n\n${RULE}`);
    assert.equal(messageContent("hi", "", true, "Teams"), `hi\n\n${CHANGE}`);
    assert.equal(messageContent("hi", "", false, "Teams"), "hi");
  });

  it("the headings carry the chat app's own name, or none", () => {
    assert.equal(ruleHeading("Teams"), RULE_HEADING);
    assert.equal(changeHeading("Teams"), CHANGE_HEADING);
    assert.equal(ruleHeading("ChatApp"), "## ChatApp reply style (formatting only, facts unchanged)");
    assert.equal(ruleHeading(""), "## Reply style (formatting only, facts unchanged)");
    for (const channel of ["ChatApp", ""]) {
      const sent = messageContent("how are the plans?", RULE, true, channel);
      assert.ok(!sent.includes("Teams reply") && !sent.includes("Teams change"));
      assert.equal(withoutRule(sent), "how are the plans?", channel);
      assert.equal(withoutRule(`first\n\n${ruleHeading(channel)}\n\n${RULE}`), "first", channel);
    }
  });

  it("the change summary request asks for git diff stat, read only, and only when something changed", () => {
    assert.ok(
      CHANGE_SUMMARY_RULE.includes("git diff --stat HEAD") && CHANGE_SUMMARY_RULE.includes("git status --short"),
    );
    assert.ok(CHANGE_SUMMARY_RULE.includes("do not stage, commit or push"));
    assert.ok(CHANGE_SUMMARY_RULE.includes("leave the section out"));
    assert.ok(CHANGE_SUMMARY_RULE.includes("15 lines") && CHANGE_SUMMARY_RULE.includes("+N more files"));
  });
});
