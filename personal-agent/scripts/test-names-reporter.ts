// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A node:test reporter that writes one JSON line per finished test: its file (relative to the workspace), its full
 * name (suite names and its own, joined with " > ") and its status ("pass", "fail", "skip", "todo"). Suites are not
 * listed. scripts/check-ported-tests.ts reads this to check the ported-tests ledgers against what really ran.
 *
 *   node --import tsx --test --test-reporter=./scripts/test-names-reporter.ts --test-reporter-destination=names.jsonl ...
 */
import path from "node:path";
import type { TestEvent } from "node:test/reporters";

export interface TestName {
  readonly file: string;
  readonly name: string;
  readonly status: "pass" | "fail" | "skip" | "todo";
}

const workspace = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

interface Finished {
  readonly name: string;
  readonly nesting: number;
  readonly file?: string | undefined;
  readonly skip?: string | boolean | undefined;
  readonly todo?: string | boolean | undefined;
  readonly details: { readonly type?: string | undefined };
}

/** The status a finished test is listed with. */
export function statusOf(event: "test:pass" | "test:fail", data: Finished): TestName["status"] {
  if (data.skip !== undefined && data.skip !== false) return "skip";
  if (data.todo !== undefined && data.todo !== false) return "todo";
  return event === "test:pass" ? "pass" : "fail";
}

export default async function* namesReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const stacks = new Map<string, string[]>();
  for await (const event of source) {
    if (event.type === "test:start") {
      const file = event.data.file ?? "";
      const stack = stacks.get(file) ?? [];
      stack.length = event.data.nesting;
      stack.push(event.data.name);
      stacks.set(file, stack);
    } else if (event.type === "test:pass" || event.type === "test:fail") {
      const data = event.data as Finished;
      if (data.details.type === "suite" || data.file === undefined) continue;
      const parents = (stacks.get(data.file) ?? []).slice(0, data.nesting);
      const line: TestName = {
        file: path.relative(workspace, data.file),
        name: [...parents, data.name].join(" > "),
        status: statusOf(event.type, data),
      };
      yield `${JSON.stringify(line)}\n`;
    }
  }
}
