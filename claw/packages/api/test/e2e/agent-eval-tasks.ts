// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The agent evaluation's tasks: 40 in six categories, each a prompt sent as a user would send it and a grader that
 * reads only what the session left (its events and the files it wrote). Facts the graders check are stable public
 * ones (published RFCs, the octocat demo repositories, git's first commit); a fact that moves does not belong here.
 *
 *   research  answers that need the network, with the source cited
 *   code      a small program against tests given in the prompt; passes when the model's own last run of those
 *             unchanged tests passed
 *   docs      a document of a given shape, checked by reading the file
 *   github    read-only questions about public repositories
 *   mcp       read-only questions answered through the session's MCP servers; skipped when the run has no plugin.
 *             The prompts name no system: whatever servers the plugin brings are the ones asked
 *   long      work longer than one foreground command may take
 */
import {
  all, citesUrl, isMcp, lastTestRunPassed, reachedNetwork, sameText, text, zipEntry, zipNames, type Trace, type Verdict,
} from "./agent-eval-lib.js";

export type Category = "research" | "code" | "docs" | "github" | "mcp" | "long";

/** What the runner knows about the identity it runs as, for the graders that check an answer against it. */
export interface EvalContext { userName: string; workspaces: Array<{ id: string; name: string }> }

export interface EvalTask {
  id: string;
  category: Category;
  prompt: string;
  /** Paths under /workspace the grader reads. */
  files?: string[];
  /** Needs the session's MCP servers. */
  needsPlugin?: boolean;
  /** Longer than the default per-task limit. */
  timeoutSec?: number;
  grade(t: Trace, ctx: EvalContext): Verdict;
}

const research = (id: string, prompt: string, ...facts: RegExp[]): EvalTask => ({
  id, category: "research", prompt,
  grade: (t) => all({
    fact: facts.every((f) => f.test(t.final)), cited: citesUrl(t.final), "looked it up": reachedNetwork(t),
  }),
});

/** A code task: the files the prompt hands over, the test among them, and the module the model writes. */
const code = (id: string, dir: string, task: string, given: Record<string, string>, testFile: string): EvalTask => ({
  id, category: "code",
  prompt: [
    task,
    `Work in /workspace/${dir}. Create these files there with exactly this content first:`,
    ...Object.entries(given).map(([name, body]) => `\n${name}:\n\`\`\`\n${body}\`\`\``),
    `\nDo not change ${testFile}. When you are done, run the tests with \`cd /workspace/${dir} && python3 -m unittest -v\` and report the result.`,
  ].join("\n"),
  files: Object.keys(given).map((name) => `${dir}/${name}`),
  grade: (t) => all({
    "tests unchanged": sameText(text(t, `${dir}/${testFile}`), given[testFile]!),
    "last test run passed": lastTestRunPassed(t, testFile),
  }),
});

const unittestMain = `\nif __name__ == "__main__":\n    unittest.main()\n`;

const mcp = (id: string, prompt: string, answered: (t: Trace, ctx: EvalContext) => boolean): EvalTask => ({
  id, category: "mcp", needsPlugin: true,
  prompt: `${prompt} Only read; do not change anything.`,
  grade: (t, ctx) => all({
    "used an MCP tool": t.calls.some((c) => isMcp(c) && c.ok === true),
    answered: answered(t, ctx),
    "asked for no write": t.approvals.length === 0,
  }),
});

const github = (id: string, prompt: string, ...facts: RegExp[]): EvalTask => ({
  id, category: "github", prompt,
  grade: (t) => all({ fact: facts.every((f) => f.test(t.final)), "looked it up": reachedNetwork(t) }),
});

export const TASKS: readonly EvalTask[] = [
  // --- research ---------------------------------------------------------------------------------------------
  research("r1", "Look up RFC 9110 (HTTP Semantics): what is the status code defined in section 15.5.19, and what is its name? Cite the URL you read.", /\b418\b/, /unused/i),
  research("r2", "What is the exact title of RFC 8259? Look it up and cite the URL.", /JavaScript Object Notation \(JSON\) Data Interchange Format/i),
  research("r3", "Fetch PEP 20 (The Zen of Python) from peps.python.org and quote its third aphorism exactly. Include the URL.", /Simple is better than complex/i),
  research("r4", "Node.js 的 fs.rm() 是从哪个版本开始加入的？请查官方文档，并给出链接。", /14\.14\.0/, /[一-鿿]/),
  research("r5", "Which HTTP status code does RFC 8470 define, and what is it called? Look it up and give the link.", /\b425\b/, /too early/i),
  research("r6", "According to the IANA HTTP Status Code Registry, which code is registered as \"Content Too Large\"? Cite the registry URL.", /\b413\b/),
  research("r7", "In RFC 9110, which status code is named \"Misdirected Request\"? Read the RFC and cite it.", /\b421\b/),

  // --- code -------------------------------------------------------------------------------------------------
  code("c1", "c1", "Write fizz.py with a function fizzbuzz(n) that returns the FizzBuzz strings for 1..n as a list.", {
    "test_fizz.py": `import unittest\nfrom fizz import fizzbuzz\n\n\nclass T(unittest.TestCase):\n    def test_five(self):\n        self.assertEqual(fizzbuzz(5), ["1", "2", "Fizz", "4", "Buzz"])\n\n    def test_fifteen(self):\n        self.assertEqual(fizzbuzz(15)[-1], "FizzBuzz")\n\n    def test_zero(self):\n        self.assertEqual(fizzbuzz(0), [])\n${unittestMain}`,
  }, "test_fizz.py"),
  code("c2", "c2", "median.py has a bug: fix it so the tests pass.", {
    "median.py": `def median(xs):\n    s = sorted(xs)\n    n = len(s)\n    return s[n // 2]\n`,
    "test_median.py": `import unittest\nfrom median import median\n\n\nclass T(unittest.TestCase):\n    def test_odd(self):\n        self.assertEqual(median([3, 1, 2]), 2)\n\n    def test_even(self):\n        self.assertEqual(median([4, 1, 3, 2]), 2.5)\n\n    def test_empty(self):\n        with self.assertRaises(ValueError):\n            median([])\n${unittestMain}`,
  }, "test_median.py"),
  code("c3", "c3", "Write words.py with top_words(text, k): the k most frequent words (lowercased, a word is a run of letters or apostrophes) as (word, count) pairs, most frequent first, ties in alphabetical order.", {
    "test_words.py": `import unittest\nfrom words import top_words\n\n\nclass T(unittest.TestCase):\n    def test_basic(self):\n        self.assertEqual(top_words("b a B c a b", 2), [("b", 3), ("a", 2)])\n\n    def test_ties(self):\n        self.assertEqual(top_words("z y x", 2), [("x", 1), ("y", 1)])\n\n    def test_apostrophe(self):\n        self.assertEqual(top_words("Don't stop, don't!", 1), [("don't", 2)])\n${unittestMain}`,
  }, "test_words.py"),
  code("c4", "c4", "Write ipv4.py with is_ipv4(s) that says whether s is a dotted-quad IPv4 address (four decimal parts 0-255, no leading zeros, nothing else).", {
    "test_ipv4.py": `import unittest\nfrom ipv4 import is_ipv4\n\n\nclass T(unittest.TestCase):\n    def test_valid(self):\n        for s in ["0.0.0.0", "192.168.1.1", "255.255.255.255"]:\n            self.assertTrue(is_ipv4(s), s)\n\n    def test_invalid(self):\n        for s in ["256.1.1.1", "1.1.1", "01.1.1.1", "1.1.1.1 ", "a.b.c.d", "1..1.1", ""]:\n            self.assertFalse(is_ipv4(s), s)\n${unittestMain}`,
  }, "test_ipv4.py"),
  code("c5", "c5", "Write roman.py with to_roman(n) for 1 <= n <= 3999, raising ValueError outside that range.", {
    "test_roman.py": `import unittest\nfrom roman import to_roman\n\n\nclass T(unittest.TestCase):\n    def test_values(self):\n        for n, r in [(1, "I"), (4, "IV"), (9, "IX"), (14, "XIV"), (40, "XL"), (90, "XC"), (400, "CD"), (1994, "MCMXCIV"), (3999, "MMMCMXCIX")]:\n            self.assertEqual(to_roman(n), r)\n\n    def test_range(self):\n        for n in [0, 4000]:\n            with self.assertRaises(ValueError):\n                to_roman(n)\n${unittestMain}`,
  }, "test_roman.py"),
  code("c6", "c6", "Add type annotations to every parameter and return value in shapes.py, without changing what the functions do.", {
    "shapes.py": `import math\n\n\ndef circle_area(r):\n    return math.pi * r * r\n\n\ndef rect_area(w, h):\n    return w * h\n\n\ndef total_area(shapes):\n    return sum(rect_area(*s) if len(s) == 2 else circle_area(*s) for s in shapes)\n`,
    "test_shapes.py": `import inspect\nimport math\nimport unittest\n\nimport shapes\n\n\nclass T(unittest.TestCase):\n    def test_behaviour(self):\n        self.assertAlmostEqual(shapes.circle_area(1), math.pi)\n        self.assertEqual(shapes.rect_area(2, 3), 6)\n        self.assertAlmostEqual(shapes.total_area([(2, 3), (1,)]), 6 + math.pi)\n\n    def test_annotated(self):\n        for f in (shapes.circle_area, shapes.rect_area, shapes.total_area):\n            sig = inspect.signature(f)\n            self.assertIsNot(sig.return_annotation, inspect.Signature.empty, f.__name__)\n            for p in sig.parameters.values():\n                self.assertIsNot(p.annotation, inspect.Parameter.empty, f.__name__ + "." + p.name)\n${unittestMain}`,
  }, "test_shapes.py"),
  code("c7", "c7", "Write report.py with total_by_region(path) that reads the CSV at path and returns a dict of region to the sum of amount (as a float).", {
    "sales.csv": `region,amount\nnorth,10.5\nsouth,4\nnorth,2.5\neast,7\nsouth,1\n`,
    "test_report.py": `import unittest\nfrom report import total_by_region\n\n\nclass T(unittest.TestCase):\n    def test_totals(self):\n        self.assertEqual(total_by_region("sales.csv"), {"north": 13.0, "south": 5.0, "east": 7.0})\n${unittestMain}`,
  }, "test_report.py"),
  code("c8", "c8", "Write slug.py with slugify(s): lowercase, runs of anything that is not a letter or digit become one hyphen, no hyphen at either end.", {
    "test_slug.py": `import unittest\nfrom slug import slugify\n\n\nclass T(unittest.TestCase):\n    def test_slugs(self):\n        self.assertEqual(slugify("Hello, World!"), "hello-world")\n        self.assertEqual(slugify("  Many   spaces  "), "many-spaces")\n        self.assertEqual(slugify("a--b__c"), "a-b-c")\n        self.assertEqual(slugify("2024 Q1 Report"), "2024-q1-report")\n${unittestMain}`,
  }, "test_slug.py"),

  // --- docs -------------------------------------------------------------------------------------------------
  {
    id: "d1", category: "docs", files: ["d1/report.md"],
    prompt: "Write /workspace/d1/report.md: a heading \"Team Report\" and a Markdown table with the columns Name, Role, Start and these rows: Ana, Engineer, 2024-01-15; Bo, Designer, 2023-07-01; Chen, Manager, 2022-03-20.",
    grade: (t) => {
      const md = text(t, "d1/report.md") ?? "";
      return all({
        heading: /^#{1,6}\s*Team Report\s*$/m.test(md),
        header: /^\|\s*Name\s*\|\s*Role\s*\|\s*Start\s*\|\s*$/m.test(md),
        rows: [/\|\s*Ana\s*\|\s*Engineer\s*\|\s*2024-01-15\s*\|/, /\|\s*Bo\s*\|\s*Designer\s*\|\s*2023-07-01\s*\|/, /\|\s*Chen\s*\|\s*Manager\s*\|\s*2022-03-20\s*\|/].every((r) => r.test(md)),
      });
    },
  },
  {
    id: "d2", category: "docs", files: ["d2/scores.csv"],
    prompt: "Turn this JSON into /workspace/d2/scores.csv with the header id,name,score and the rows sorted by score, highest first: [{\"id\":1,\"name\":\"ana\",\"score\":71},{\"id\":2,\"name\":\"bo\",\"score\":93},{\"id\":3,\"name\":\"chen\",\"score\":85}]",
    grade: (t) => all({ csv: sameText(text(t, "d2/scores.csv"), "id,name,score\n2,bo,93\n3,chen,85\n1,ana,71\n") }),
  },
  {
    id: "d3", category: "docs", files: ["d3/sales.xlsx"],
    prompt: "Create the Excel workbook /workspace/d3/sales.xlsx with one sheet named Q1: A1 \"Month\", B1 \"Revenue\", then Jan 100, Feb 200, Mar 300 in rows 2 to 4.",
    grade: (t) => {
      const buf = t.files["d3/sales.xlsx"];
      const book = zipEntry(buf, "xl/workbook.xml") ?? "";
      const cells = zipNames(buf).filter((n) => n.startsWith("xl/")).map((n) => zipEntry(buf, n) ?? "").join("\n");
      return all({ xlsx: !!book, "sheet Q1": /name="Q1"/.test(book), cells: /Revenue/.test(cells) && /Mar/.test(cells) && /<v>300<\/v>/.test(cells) });
    },
  },
  {
    id: "d4", category: "docs", files: ["d4/memo.docx"],
    prompt: "Create the Word document /workspace/d4/memo.docx with the title \"Quarterly Memo\" and one paragraph: \"Revenue grew 12% this quarter.\"",
    grade: (t) => {
      const doc = zipEntry(t.files["d4/memo.docx"], "word/document.xml") ?? "";
      const plain = doc.replace(/<[^>]+>/g, "");
      return all({ docx: !!doc, title: plain.includes("Quarterly Memo"), paragraph: plain.includes("Revenue grew 12% this quarter.") });
    },
  },
  {
    id: "d5", category: "docs", files: ["d5/hello.pdf"],
    prompt: "Create a one-page PDF /workspace/d5/hello.pdf that says \"Hello PDF\".",
    grade: (t) => {
      const buf = t.files["d5/hello.pdf"];
      return all({ pdf: !!buf && buf.subarray(0, 5).toString("latin1") === "%PDF-" && buf.length > 200 });
    },
  },
  {
    id: "d6", category: "docs", files: ["d6/deck.pptx"],
    prompt: "Create the PowerPoint deck /workspace/d6/deck.pptx with two slides, titled \"Plan\" and \"Risks\".",
    grade: (t) => {
      const buf = t.files["d6/deck.pptx"];
      const slides = zipNames(buf).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      const words = slides.map((n) => (zipEntry(buf, n) ?? "").replace(/<[^>]+>/g, " ")).join(" ");
      return all({ pptx: slides.length === 2, titles: /\bPlan\b/.test(words) && /\bRisks\b/.test(words) });
    },
  },
  {
    id: "d7", category: "docs", files: ["d7/summary.md"],
    prompt: [
      "Summarise this note in at most 60 words into /workspace/d7/summary.md:",
      "",
      "We moved the session store from a single database table to a two-level cache. Reads now hit an in-process LRU first and a shared cache second; only misses reach the database. During the two-week trial the p95 read latency fell from 180 ms to 35 ms and database load dropped by about two thirds. Writes still go to the database first, so a crash loses nothing. The cost is memory: each API pod now holds up to 512 MB of cached sessions, and a cache that is wrong for a few seconds after a write on another pod. We judged that acceptable because sessions are rarely written from two pods at once. Next we will add metrics for the hit rate per level and decide whether the shared cache is worth keeping.",
    ].join("\n"),
    grade: (t) => {
      const md = text(t, "d7/summary.md") ?? "";
      const words = md.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
      return all({ written: words > 0, short: words <= 60, latency: /latency/i.test(md), cache: /cache/i.test(md) });
    },
  },

  // --- github -----------------------------------------------------------------------------------------------
  github("g1", "In the public GitHub repository octocat/Hello-World, what is the full SHA of the latest commit on the default branch, and who authored it?", /7fd1a60b01f91b314f59955a4e4d4e80d8edf11d/, /octocat/i),
  github("g2", "List the files at the root of the public GitHub repository octocat/Spoon-Knife.", /README\.md/, /index\.html/, /styles\.css/),
  github("g3", "Who opened pull request #1 in octocat/Hello-World on GitHub, and what is its title?", /unoju/i, /Edited README via GitHub/i),
  github("g4", "In the git/git repository on GitHub, commit e83c5163316f89bfbde7d9ab23ca2e25604af290 is the first one. On what date was it authored, and what is its message?", /2005-04-07|April 7,? 2005|7 April 2005/i, /information manager from hell/i),
  {
    id: "g5", category: "github", files: ["spoon-lines.txt"],
    prompt: "Clone https://github.com/octocat/Spoon-Knife into /workspace/spoon, count the lines of styles.css with wc -l, and write just that number into /workspace/spoon-lines.txt.",
    grade: (t) => all({ count: sameText(text(t, "spoon-lines.txt"), "17"), "looked it up": reachedNetwork(t) }),
  },
  github("g6", "Which branches does the public GitHub repository octocat/Hello-World have?", /\bmaster\b/, /octocat-patch-1/, /\btest\b/),

  // --- mcp --------------------------------------------------------------------------------------------------
  {
    id: "p1", category: "mcp", needsPlugin: true,
    prompt: "Which MCP servers are connected in this session? Name each one and say roughly what it is for.",
    grade: (t) => all({ named: t.mcpServers.length > 0 && t.mcpServers.some((s) => t.final.toLowerCase().includes(s.toLowerCase())) }),
  },
  mcp("p2", "Using your MCP tools, find out who I am on the platform and answer with my display name.",
    (t, ctx) => ctx.userName.split(/[\s,]+/).filter((w) => w.length >= 3).some((w) => t.final.includes(w))),
  mcp("p3", "Using your MCP tools, list the workspaces I can use: how many are there, and what are they called?",
    (t, ctx) => ctx.workspaces.filter((w) => t.final.includes(w.id) || t.final.includes(w.name)).length * 2 >= ctx.workspaces.length),
  mcp("p4", "Using your MCP tools, show my three most recent workloads or jobs and the status of each.",
    (t) => /\b(running|succeeded|failed|pending|stopped|completed|stopping|queued)\b/i.test(t.final)),
  mcp("p5", "Which of your MCP tools read logs? Name them, then use one to read the most recent log lines of any one of my recent jobs.",
    (t) => /log/i.test(t.final)),
  mcp("p6", "Using your MCP tools, how many nodes can I see, and how many of them are ready?",
    (t) => /\d/.test(t.final)),

  // --- long -------------------------------------------------------------------------------------------------
  {
    id: "l1", category: "long", files: ["l1/out.txt"], timeoutSec: 900,
    prompt: "Run `mkdir -p /workspace/l1 && sleep 130 && echo finished-l1 > /workspace/l1/out.txt`, then tell me what out.txt contains.",
    grade: (t) => all({ file: sameText(text(t, "l1/out.txt"), "finished-l1"), reported: t.final.includes("finished-l1") }),
  },
  {
    id: "l2", category: "long", files: ["l2/times.txt"], timeoutSec: 900,
    prompt: "In /workspace/l2, record `date +%s` into times.txt, then run `sleep 45` three times one after another, then append `date +%s` again, so times.txt holds two lines. Tell me how many seconds apart they are.",
    grade: (t) => {
      const lines = (text(t, "l2/times.txt") ?? "").trim().split(/\s+/).map(Number);
      return all({ "two stamps": lines.length === 2 && lines.every(Number.isFinite), "135s apart": lines.length === 2 && lines[1]! - lines[0]! >= 135 });
    },
  },
  {
    id: "l3", category: "long", files: ["l3/c.txt"],
    prompt: "Do this in three steps and keep track of them: (1) create /workspace/l3/a.txt containing alpha, (2) create /workspace/l3/b.txt containing beta, (3) write /workspace/l3/c.txt containing the two contents joined with no separator. Then check c.txt.",
    grade: (t) => all({ joined: sameText(text(t, "l3/c.txt"), "alphabeta") }),
  },
  {
    id: "l4", category: "long", timeoutSec: 900,
    prompt: "Create /workspace/l4/index.html containing l4-ok, serve /workspace/l4 with `python3 -m http.server 8765` in the background, fetch http://127.0.0.1:8765/index.html with curl, tell me what came back, and stop the server.",
    grade: (t) => all({ fetched: t.calls.some((c) => c.name === "bash" && c.ok === true && /l4-ok/.test(c.result)), reported: t.final.includes("l4-ok") }),
  },
  {
    id: "l5", category: "long", files: ["l5/log.txt"], timeoutSec: 900,
    prompt: "Run `mkdir -p /workspace/l5 && for i in $(seq 1 8); do echo step $i; sleep 20; done > /workspace/l5/log.txt` and tell me the last line of the log.",
    grade: (t) => {
      const last = (text(t, "l5/log.txt") ?? "").trim().split("\n").at(-1);
      return all({ log: last === "step 8", reported: /step 8/.test(t.final) });
    },
  },
  {
    id: "l6", category: "long", files: ["l6/table.txt"], timeoutSec: 900,
    prompt: "Install the Python package tabulate, and use it to write /workspace/l6/table.txt: a table with the headers name and score and the rows ana 71, bo 93.",
    grade: (t) => {
      const table = text(t, "l6/table.txt") ?? "";
      return all({ table: /name/.test(table) && /score/.test(table) && /ana\s+71/.test(table) && /bo\s+93/.test(table) && /-{3,}/.test(table) });
    },
  },
];

export const CATEGORIES: readonly Category[] = ["research", "code", "docs", "github", "mcp", "long"];
