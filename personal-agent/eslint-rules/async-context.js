// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `layers/async-context-in-runtime-context`: asynchronous context (Node's `async_hooks`, `AsyncLocalStorage`) lives in
 * one place, `packages/runtime/src/context/`, behind core's request-scope port. A second store elsewhere would be a
 * second copy of what Python's contextvars hold (the client locale, the activity id, the chat a log line belongs to)
 * that the first one does not see, and core must stay free of Node.
 *
 * Reported anywhere else: a string `async_hooks` / `node:async_hooks` (an import, an `export ... from`, a dynamic
 * import, `require`, `process.getBuiltinModule`), the same text as a template literal without substitutions, and the
 * name `AsyncLocalStorage` (however it was obtained).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "runtime", "src", "context");
const MODULE = /^(node:)?async_hooks$/;

function allowed(filename) {
  const relative = path.relative(ALLOWED, path.resolve(filename));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export default {
  meta: {
    type: "problem",
    docs: { description: "async_hooks and AsyncLocalStorage only in packages/runtime/src/context/" },
    messages: {
      outside:
        "Asynchronous context (async_hooks / AsyncLocalStorage) belongs in packages/runtime/src/context/ only: " +
        "use core's request-scope port.",
    },
    schema: [],
  },
  create(context) {
    if (allowed(context.filename)) return {};
    const report = (node) => {
      context.report({ node, messageId: "outside" });
    };
    return {
      Literal: (node) => {
        if (typeof node.value === "string" && MODULE.test(node.value)) report(node);
      },
      TemplateLiteral: (node) => {
        if (node.expressions.length === 0 && MODULE.test(node.quasis[0]?.value.cooked ?? "")) report(node);
      },
      Identifier: (node) => {
        if (node.name === "AsyncLocalStorage") report(node);
      },
    };
  },
};
