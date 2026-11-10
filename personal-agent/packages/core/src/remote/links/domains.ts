// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Bare domains (`example.com/path`) in a remote agent's text, the ones a client that links fuzzy domains would link. */

/** Where a code span this scan made opens or closes (a backtick in the end, see `answer.ts`): the scans after it read it as the
 * backtick it will be, and an agent's own backtick left in the prose is told apart from it. */
export const CODE = "\x02";

/** The top-level domains a bare `name.tld` is an address for (a client that links fuzzy domains links these): the generic ones
 * people write, and every two-letter country code (ISO 3166, with ac, eu, su and uk). */
const GENERIC_TLDS = new Set(
  "com net org edu gov mil info biz io ai co me app dev xyz top site online cloud tech shop store blog club".split(" "),
);
const COUNTRY_TLDS = new Set(
  (
    "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo " +
    "bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk " +
    "dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq " +
    "gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki " +
    "km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo " +
    "mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk " +
    "pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss " +
    "st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk um us uy uz va " +
    "vc ve vg vi vn vu wf ws ye yt za zm zw"
  ).split(" "),
);
/** A run of domain labels, a dot possibly escaped (`\.`, which the rich text reads as a dot). */
const DOMAIN_RUN =
  /[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\?\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/gu;
const DOMAIN_MAX = 253;
const ASCII_WORD = /^[A-Za-z0-9]$/u;

/** Whether the run of labels `run`, followed by `after`, is a bare domain: its last label a TLD, not too long, and not a name
 * with an extension (`README.md`, `self.id`: two labels, nothing after, a country code). */
function isDomain(run: string, after: string): boolean {
  const labels = run.replaceAll("\\", "").split(".");
  const tld = (labels.at(-1) ?? "").toLowerCase();
  if (!(GENERIC_TLDS.has(tld) || COUNTRY_TLDS.has(tld)) || labels.join(".").length > DOMAIN_MAX) return false;
  if (ASCII_WORD.test(after)) return false;
  return labels.length > 2 || ":/?#".includes(after || " ") || GENERIC_TLDS.has(tld);
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
    if (startsHere && isDomain(m[0], text.charAt(end))) yield [start, end];
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
