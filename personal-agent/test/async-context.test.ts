// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * layers/async-context-in-runtime-context: async_hooks and AsyncLocalStorage are refused everywhere but
 * packages/runtime/src/context/, in every form a module can be reached by; and the workspace configuration has the
 * rule on, as a gate (no inline disable).
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";
import asyncContext from "../eslint-rules/async-context.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULE = "layers/async-context-in-runtime-context";
const config: Linter.Config[] = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { layers: { rules: { "async-context-in-runtime-context": asyncContext } } },
    rules: { [RULE]: "error" },
  },
];

function reported(code: string, file: string): number {
  const messages = new Linter({ configType: "flat" }).verify(code, config, { filename: path.join(root, file) });
  assert.deepEqual(
    messages.filter((m) => m.fatal === true),
    [],
  );
  return messages.filter((m) => m.ruleId === RULE).length;
}

const FORMS: readonly (readonly [string, string])[] = [
  ["static import", 'import { AsyncLocalStorage } from "node:async_hooks";'],
  ["bare specifier", 'import * as hooks from "async_hooks";\nexport const h = hooks;'],
  ["re-export", 'export { createHook } from "node:async_hooks";'],
  ["dynamic import", 'export const m = await import("node:async_hooks");'],
  ["require", 'declare const require: (id: string) => unknown;\nexport const m = require("async_hooks");'],
  ["getBuiltinModule", 'export const m = process.getBuiltinModule("node:async_hooks");'],
  ["template literal", "export const m = await import(`node:async_hooks`);"],
  [
    "the name, however obtained",
    "declare const AsyncLocalStorage: new () => object;\nexport const s = new AsyncLocalStorage();",
  ],
];

test("every way of reaching async_hooks or AsyncLocalStorage is refused outside runtime/src/context", () => {
  for (const file of ["packages/core/src/x.ts", "packages/runtime/src/logging/x.ts", "packages/teams/src/x.ts"]) {
    for (const [name, code] of FORMS) assert.ok(reported(code, file) >= 1, `${name} in ${file}`);
  }
  for (const file of [
    "packages/runtime/test/context/x.test.ts",
    "test-support/x.ts",
    "packages/runtime/src/contextual/x.ts",
  ]) {
    assert.ok(reported(FORMS[0]?.[1] ?? "", file) >= 1, file);
  }
});

test("runtime/src/context may use them, and unrelated code is not reported", () => {
  for (const [name, code] of FORMS) assert.equal(reported(code, "packages/runtime/src/context/als.ts"), 0, name);
  assert.equal(reported(FORMS[0]?.[1] ?? "", "packages/runtime/src/context/deeper/als.ts"), 0);
  assert.equal(
    reported(
      'import { setTimeout } from "node:timers/promises";\nexport const hooks = "async";',
      "packages/core/src/x.ts",
    ),
    0,
  );
});

test("the workspace configuration turns the rule on for every TypeScript file and refuses an inline disable of it", async () => {
  const eslint = new ESLint({ cwd: root });
  for (const file of ["packages/core/src/index.ts", "packages/teams/src/index.ts", "test-support/index.ts"]) {
    const config = (await eslint.calculateConfigForFile(path.join(root, file))) as Linter.Config;
    assert.deepEqual(config.rules?.[RULE], [2], file);
    const restricted = config.rules["@eslint-community/eslint-comments/no-restricted-disable"];
    assert.ok(Array.isArray(restricted) && restricted.includes(RULE), file);
  }
});
