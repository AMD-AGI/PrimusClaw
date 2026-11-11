// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The code rules of the personal agent, enforced in CI (`npm run lint`, zero warnings). They are the floor every line
// of the TypeScript port is held to; lowering one, or disabling it in a file, is a change to this file that review sees.
import eslint from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";
import asyncContext from "./eslint-rules/async-context.js";
import noPrototypeKeys from "./eslint-rules/no-prototype-keys.js";

/** Rules that are gates: no inline disable of these is accepted, with or without a reason. */
const GATES = [
  "complexity",
  "max-lines",
  "max-lines-per-function",
  "import-x/no-cycle",
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-misused-promises",
  "own-keys/no-prototype-keys",
  "layers/async-context-in-runtime-context",
];

export default tseslint.config(
  {
    // test/fixtures holds code written to break a rule; test/no-prototype-keys.test.ts lints it on purpose.
    ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", ".c8-tmp/**", "test/fixtures/**"],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" },
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  comments.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.js", "*.cjs", "eslint-rules/*.js", "examples/*/*.mjs"] },
      },
    },
    settings: {
      "import-x/resolver-next": [createTypeScriptImportResolver({ project: "./tsconfig.json" })],
    },
    rules: {
      complexity: ["error", 15],
      "max-lines": ["error", { max: 600, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "import-x/no-cycle": ["error", { ignoreExternal: true }],
      "@typescript-eslint/no-explicit-any": "error",
      // node:test's test() and describe() return promises the runner itself awaits.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "describe", "it", "suite", "before", "after"] },
          ],
        },
      ],
      // A disable needs a reason after "--", and never covers a gate or the whole file.
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/no-restricted-disable": ["error", ...GATES],
      "@eslint-community/eslint-comments/disable-enable-pair": ["error", { allowWholeFile: false }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: false }],
      "import-x/no-default-export": "off",
      "import-x/no-named-as-default-member": "off",
    },
  },
  {
    // A plain-object lookup by an arbitrary string key reaches Object.prototype ("constructor", "__proto__"), which a
    // Python dict never does (eslint-rules/no-prototype-keys.js says what is allowed instead).
    files: ["**/*.ts"],
    plugins: { "own-keys": { rules: { "no-prototype-keys": noPrototypeKeys } } },
    rules: { "own-keys/no-prototype-keys": "error" },
  },
  {
    // Asynchronous context only in packages/runtime/src/context/ (eslint-rules/async-context.js).
    files: ["**/*.ts"],
    plugins: { layers: { rules: { "async-context-in-runtime-context": asyncContext } } },
    rules: { "layers/async-context-in-runtime-context": "error" },
  },
  {
    // Config files, the local lint rules, scripts and the examples' helpers are plain JavaScript run by Node.
    files: ["*.js", "*.cjs", "eslint-rules/*.js", "examples/*/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        module: "writable",
        require: "readonly",
        Buffer: "readonly",
      },
    },
  },
);
