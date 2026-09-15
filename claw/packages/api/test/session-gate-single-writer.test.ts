// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `agent_gate_message_id` has one writer, and this is what keeps it that way.
 *
 * The column is a mutex whose holder is named by a message id. Three review
 * rounds found nine defects in it, every one of them the same shape: a writer
 * that was correct about its own path was wrong about somebody else's. The
 * property that was broken -- every gated session has exactly one live thing
 * that will release it -- is about all the writers at once, so no single writer
 * could enforce it. `applySessionGateTransition` does, and a second writer
 * silently undoes that.
 *
 * The exceptions below are the sites that predate the chokepoint. The list is
 * allowed to get shorter and never longer: a new entry means somebody wrote a
 * statement instead of calling the function, which is exactly the thing this
 * file exists to stop. Each entry says what it is so the next person can judge
 * whether it still needs to be here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Files still writing the column directly, with the reason each is still here.
 *
 * A file-wide exemption is too coarse and was shown to be: exempting
 * `chat-run.ts` because it defines the transition function also exempted
 * `releaseSessionGateIfUnoccupied` in the same file, which was still asking
 * about occupancy in one statement and clearing the gate in another -- exactly
 * the race the chokepoint exists to remove, hidden by the exemption that was
 * supposed to be about something else. Entries that need to cover only part of
 * a file say which part, and `ALLOWED_FUNCTIONS` is checked against the lines
 * that actually write.
 */
const GRANDFATHERED: Record<string, string> = {
  "tasks/chat-run.ts": "defines applySessionGateTransition, plus the functions named below",
  "tasks/sweeper.ts": "the reapers: the backstop that runs when no owner is left",
  "sessions/teardown.ts": "session deletion, which ends the gate along with the session",
  "events/consumer.ts": "releaseSessionGateIfLastRun, the completion-side release",
};

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Where the column is assigned, as a source offset.
 *
 * Not a line search, and not a fixed window either. SQL here lives in template
 * literals and wraps wherever it likes: an assignment can put any number of
 * newlines between the column and its `=`, and a window of N lines is a rule
 * that says "N is enough", which it never is -- five was found by trying six.
 *
 * So the file is searched as one string with whitespace collapsed, and every
 * match is mapped back to where it actually starts. Offsets are what make
 * attribution honest too: a match belongs to the declaration enclosing its own
 * position, not to whichever line a window happened to begin on.
 *
 * `=` only, never `==` or `>=` or `<=`, and never a `WHERE`/`AND`/`OR` in front
 * of it -- with or without a table alias, since `WHERE s.agent_gate_message_id`
 * is the same predicate. Reading the column is what most of this codebase does
 * with it.
 *
 * What this cannot see, stated so nobody relies on it:
 *
 *  - a column name assembled at runtime (`${col}`, or two literals joined), because
 *    the spelling is not in the source;
 *  - an assignment inside a comment, which it reports as a write it is not.
 *
 * The first is the reason this guard is a tripwire rather than a proof: it
 * catches the way somebody would actually write a new direct UPDATE, and a
 * reviewer is still the thing that catches deliberate indirection. The second
 * is a false report and costs a reviewer a minute, which is the safer of the
 * two ways to be wrong.
 */
function writeOffsets(text: string): number[] {
  // Collapse whitespace while remembering where each kept character came from.
  const map: number[] = [];
  let flat = "";
  let prevSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) { flat += " "; map.push(i); prevSpace = true; }
      continue;
    }
    flat += ch; map.push(i); prevSpace = false;
  }
  const out: number[] = [];
  // The quoted spelling is the same column. Anything built at runtime -- a
  // variable holding the name, two literals concatenated -- is outside what a
  // source search can see at all, and is recorded as such above rather than
  // papered over with a wider pattern that would only add false reports.
  // Two optional leads: the keyword, then an alias qualifier. One group cannot
  // do both -- `WHERE s.agent_gate_message_id` would capture only `s.` and the
  // keyword would be lost, which reported the predicate as an assignment.
  // Parens between the keyword and the column are still that keyword's context:
  // a policy writes `USING (agent_gate_message_id = ...)`, and a predicate may
  // be parenthesised anywhere. Without tolerating them the keyword was lost and
  // the read became a reported write.
  const re = /(\w+\s+)?\(*\s*(\w+\.)?"?agent_gate_message_id"?\s*=(?!=)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    const keyword = (m[1] ?? "").trim().toUpperCase();
    // A comparison in a predicate is a read. Assignments follow SET, a comma,
    // an open paren, or start a line of their own.
    // Every keyword that can precede a comparison rather than an assignment.
    // The list was six and let `HAVING`, `RETURNING` and a policy's `USING`
    // through as writes -- all three are valid read contexts, and a guard that
    // rejects documentation or a read is a guard people learn to work around.
    if (READ_CONTEXTS.includes(keyword)) continue;
    out.push(map[m.index]);
  }
  return out;
}

/**
 * Keywords that introduce a comparison, not an assignment.
 *
 * `SET` and `DO UPDATE SET` are the assignment contexts; everything that reads
 * the column arrives after one of these. Extended rather than guessed: each was
 * added because a valid read was being reported as a write.
 */
const READ_CONTEXTS = [
  "WHERE", "AND", "OR", "ON", "BY", "FROM",
  "HAVING", "RETURNING", "USING", "WHEN", "THEN", "ELSE", "CASE",
];

/** Whether `text` assigns the column anywhere. */
const writesIn = (text: string): boolean => writeOffsets(text).length > 0;


test("nothing outside the one writer assigns the session gate marker", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (rel in GRANDFATHERED) continue;
    const text = readFileSync(file, "utf8");
    // Comparisons inside a predicate are reads; only assignments count, and
    // `IS NOT DISTINCT FROM` never spells one.
    const at = writeOffsets(text);
    if (at.length) {
      const line = text.slice(0, at[0]).split("\n").length;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    "call applySessionGateTransition instead of writing the column; if a new site "
    + "genuinely cannot, add it to GRANDFATHERED with the reason",
  );
});

/**
 * The writes inside `chat-run.ts` that are allowed to be direct, by the name of
 * the function each belongs to. Anything else there is a new writer.
 */
const ALLOWED_FUNCTIONS = [
  "applySessionGateTransition",
  // Conditional on no turn occupying the session -- a shape the three intents
  // do not express -- and fused into one statement so it holds no window.
  "releaseSessionGateIfUnoccupied",
  "forceIdleAfterInterrupt",
];

test("and inside that file, only the functions named may write it", () => {
  const text = readFileSync(join(SRC, "tasks/chat-run.ts"), "utf8");
  const lines = text.split("\n");

  // Every top-level declaration with the offset it starts at, so a write is
  // credited to the declaration that encloses its own position. Attributing by
  // the start of a window instead made a formatting change -- a signature
  // collapsed onto one line -- hand an allowed function's own SQL to file
  // scope, and rejected the file for it.
  const starts: Array<{ at: number; name: string }> = [];
  let offset = 0;
  for (const line of lines) {
    const declared =
      /^(?:export (?:default )?)?(?:async )?function (\w+)/.exec(line)
      ?? /^(?:export (?:default )?)?(?:const|let|class) (\w+)/.exec(line);
    if (declared) starts.push({ at: offset, name: declared[1] });
    // A statement at column zero that is not a declaration ends the previous
    // one; so does a closing brace, unless it closes a parameter object type
    // and reopens the body on the same line (`}): Promise<boolean> {`).
    else if (
      (/^\}/.test(line) && !/^\}\s*[):,]/.test(line))
      || (/^\S/.test(line) && !/^[)\]}`]/.test(line) && !/^(?:import|\/|\*)/.test(line))
    ) {
      starts.push({ at: offset, name: "<file scope>" });
    }
    offset += line.length + 1;
  }

  const owners = new Set<string>();
  for (const at of writeOffsets(text)) {
    let owner = "<file scope>";
    for (const d of starts) {
      if (d.at > at) break;
      owner = d.name;
    }
    owners.add(owner);
  }

  const unexpected = [...owners].filter((f) => !ALLOWED_FUNCTIONS.includes(f));
  assert.deepEqual(
    unexpected, [],
    "a new direct writer appeared in chat-run.ts; route it through "
    + "applySessionGateTransition, or name it in ALLOWED_FUNCTIONS with its reason",
  );
});

test("and no function is exempt that has stopped writing it", () => {
  // A stale exemption says a rule is relaxed somewhere it no longer needs to
  // be, and the next reader trusts it. `closeUnnamedChatRun` was listed while
  // containing no assignment at all.
  const text = readFileSync(join(SRC, "tasks/chat-run.ts"), "utf8");
  for (const fn of ALLOWED_FUNCTIONS) {
    const at = text.indexOf(`function ${fn}`);
    assert.ok(at >= 0, `${fn} is exempt but no longer exists`);
    const after = text.slice(at);
    const body = after.slice(0, after.indexOf("\n}\n") + 3);
    assert.ok(
      writesIn(body),
      `${fn} is exempt but no longer writes the marker -- remove it`,
    );
  }
});

test("and the grandfathered list only names files that still write it", () => {
  // A stale exemption is worse than none: it says a rule is relaxed somewhere
  // it no longer needs to be, and the next reader trusts it.
  for (const [rel, why] of Object.entries(GRANDFATHERED)) {
    const text = readFileSync(join(SRC, rel), "utf8");
    assert.ok(
      writesIn(text),
      `${rel} no longer writes the marker (${why}) -- remove it from GRANDFATHERED`,
    );
  }
});

test("the releases that undo a dispatch are scoped to the turn that dispatched", () => {
  // Not every release may open whichever gate it finds. A compensation runs
  // after its own request is over, so the gate it sees may belong to a turn
  // that started since -- the managed-agent rollback cleared exactly that way,
  // and the next message then dispatched alongside a live run.
  //
  // Asserted on the call's shape because this route has no test of its own; a
  // behavioural case would need the whole dispatch path stood up. What is
  // pinned is the property: this release names an owner.
  const src = readFileSync(join(SRC, "routes/anthropic-managed-agents.ts"), "utf8");
  const call = src.slice(src.indexOf("intent: \"release\""));
  const block = call.slice(0, call.indexOf("});"));
  assert.ok(call.length > 0, "the rollback releases through the one writer");
  assert.match(block, /owner: input\.messageId/, "scoped to this request's own turn");
  assert.ok(
    !/force: true/.test(block),
    "and without the backstop escape, which would put the unconditional clear back",
  );
});
