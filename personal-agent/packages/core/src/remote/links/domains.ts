// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Bare domains (`example.com/path`) in a remote agent's text, the ones a client that links fuzzy domains would link. */

/** Where a code span this scan made opens or closes (a backtick in the end, see `answer.ts`): the scans after it read it as the
 * backtick it will be, and an agent's own backtick left in the prose is told apart from it. */
export const CODE = "\x02";

/** The top-level domains a bare `name.tld` (two labels, nothing after) is an address for: the generic ones people write. With
 * three labels or more, or a port, a path, a query or a fragment after it, any last label of two letters or more is one. */
const GENERIC_TLDS = new Set(
  "com net org edu gov mil info biz io ai co me app dev xyz top site online cloud tech shop store blog club".split(" "),
);
/** A run of domain labels, a dot or a hyphen possibly escaped (`\.`, `\-`: the rich text drops the backslash). */
const DOMAIN_RUN =
  /[A-Za-z0-9](?:(?:[A-Za-z0-9-]|\\-){0,61}[A-Za-z0-9])?(?:\\?\.[A-Za-z0-9](?:(?:[A-Za-z0-9-]|\\-){0,61}[A-Za-z0-9])?)+/gu;
const DOMAIN_MAX = 253;
const ASCII_WORD = /^[A-Za-z0-9]$/u;

/** Whether the run of labels `run`, followed by `after`, is a bare domain: not too long, and its last label a top-level domain
 * (any of two letters or more when it has three labels or more or a tail, a generic one when it is `name.tld` alone, so
 * `README.md` and `self.id` stay words). */
function isDomain(run: string, after: string, tail: boolean): boolean {
  const labels = run.replaceAll("\\", "").split(".");
  const tld = (labels.at(-1) ?? "").toLowerCase();
  // (followed by `@` it is a mail address's name, the mail rule's: `john.doe.jr@example.com`)
  if (labels.join(".").length > DOMAIN_MAX || ASCII_WORD.test(after) || after === "@") return false;
  if (labels.length > 2 || tail) return /^[a-z]{2,63}$/u.test(tld);
  return GENERIC_TLDS.has(tld);
}

/** Whether a port, a path, a query or a fragment starts at `at` (`:`, `/`, `?`, `#`), escaped too (`\/`: the client shows `/`). */
export function tailAt(text: string, at: number): boolean {
  const ch = text.charAt(at) === "\\" ? text.charAt(at + 1) : text.charAt(at);
  return ch !== "" && ":/?#".includes(ch);
}

/** The bare domains of one text, found left to right: [start, end of its run of labels] each. */
export function* domains(text: string, from = 0): Generator<[number, number]> {
  const runs = new RegExp(DOMAIN_RUN.source, "gu");
  runs.lastIndex = from;
  for (let m = runs.exec(text); m; m = runs.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? text.charAt(start - 1) : "";
    const startsHere = !before || !(ASCII_WORD.test(before) || ".-@/\x00".includes(before) || before === CODE);
    if (startsHere && isDomain(m[0], text.charAt(end), tailAt(text, end))) yield [start, end];
  }
}

/** Where the next bare domain of one text starts at or after `from`, for a `from` that never goes back (one pass in all). */
export class DomainFinder {
  private readonly found: Generator<[number, number]>;
  private next: [number, number] | undefined;
  private started = false;

  constructor(text: string) {
    this.found = domains(text);
  }

  at(from: number): number {
    if (!this.started) {
      this.next = this.step();
      this.started = true;
    }
    while (this.next && this.next[0] < from) this.next = this.step();
    return this.next ? this.next[0] : -1;
  }

  private step(): [number, number] | undefined {
    const found = this.found.next();
    return found.done ? undefined : found.value;
  }

  /** Where the run of labels of the domain that starts at `start` ends, -1 when no domain starts there. */
  runEnd(start: number): number {
    return this.next?.[0] === start ? this.next[1] : -1;
  }
}
