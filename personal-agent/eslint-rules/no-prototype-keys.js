// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `own-keys/no-prototype-keys`: a plain object read or written with a key that comes from outside the type system
 * reaches Object.prototype. `VERBS[word] ?? "usage"` answers `VERBS.constructor` for the word "constructor" (a
 * function, so the fallback never applies), and `table[key] = value` with the key "__proto__" replaces the table's
 * prototype. A Python dict has none of these keys, so the port must not either.
 *
 * Reported: `obj[key]` (read, write, delete) and `key in obj` where `obj` is not an array, a tuple or a string, and the
 * key's type -- read before any `as` cast, since `word as keyof typeof VERBS` is how the bug hides -- admits an
 * arbitrary string: `string`, a template type with a `${string}` hole, `any`, `unknown`, or a type parameter that may
 * be one of these. A key typed as a union of string literals is trusted (it was narrowed or validated); a number or a
 * symbol key cannot name a prototype string property.
 *
 * Allowed, because the lookup cannot reach a prototype:
 *  - a `Map` (`.get` / `.has`);
 *  - the access under an `Object.hasOwn(obj, key)` check of the same object and key: in the true branch of an `if`,
 *    a `? :` or an `&&`, or after an `if (!Object.hasOwn(obj, key)) return|throw|continue|break;` earlier in the
 *    same block;
 *  - an object made by `Object.create(null)` (the variable's own initialiser), or typed as core's `Dict<V>`;
 *  - core's `own(table, key)`, which does the check.
 */
import ts from "typescript";

/** Undo `as`, `<T>`, `!` and `satisfies`: the key's real type is the one before the cast. */
function unwrap(node) {
  let n = node;
  while (["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TSSatisfiesExpression"].includes(n.type)) {
    n = n.expression;
  }
  return n;
}

function isStaticKey(node) {
  return node.type === "Literal" || (node.type === "TemplateLiteral" && node.expressions.length === 0);
}

function parts(type) {
  return type.isUnion() ? type.types.flatMap(parts) : [type];
}

const ARBITRARY = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral;
const GENERIC = ts.TypeFlags.TypeParameter | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess;

/** Whether a key of this type can be an arbitrary string. */
function arbitraryString(checker, type, depth = 0) {
  return parts(type).some((t) => {
    const flags = t.getFlags();
    if (flags & ARBITRARY) return true;
    if (flags & GENERIC) {
      const constraint = checker.getBaseConstraintOfType(t);
      return !constraint || constraint === t || depth > 5 || arbitraryString(checker, constraint, depth + 1);
    }
    return t.isIntersection() && t.types.every((x) => arbitraryString(checker, x, depth + 1));
  });
}

/** An array, a tuple or a string: indexed by number, not a dictionary. */
function arrayOrString(checker, type) {
  return parts(type).every(
    (t) => t.getFlags() & ts.TypeFlags.StringLike || checker.isArrayType(t) || checker.isTupleType(t),
  );
}

/** Typed as core's `Dict<V>`: its phantom `nullPrototype` brand says it was made without a prototype. */
function nullPrototypeType(type) {
  return parts(type).every((t) => t.getProperties().some((p) => String(p.escapedName).startsWith("__@nullPrototype")));
}

function isNullPrototypeCall(source, init) {
  const call = init && unwrap(init);
  return (
    call?.type === "CallExpression" &&
    source.getText(call.callee) === "Object.create" &&
    call.arguments.length === 1 &&
    call.arguments[0].type === "Literal" &&
    call.arguments[0].value === null
  );
}

/** The object is a variable whose own initialiser is `Object.create(null)`. */
function madeWithNullPrototype(source, object) {
  const target = unwrap(object);
  if (target.type !== "Identifier") return false;
  for (let scope = source.getScope(target); scope; scope = scope.upper) {
    const variable = scope.set.get(target.name);
    if (variable) return variable.defs.some((def) => isNullPrototypeCall(source, def.node?.init));
  }
  return false;
}

/** `test` is true only when `Object.hasOwn(object, key)` is. */
function proves(source, test, guard) {
  if (!test) return false;
  if (test.type === "LogicalExpression" && test.operator === "&&") {
    return proves(source, test.left, guard) || proves(source, test.right, guard);
  }
  return (
    test.type === "CallExpression" &&
    source.getText(test.callee) === "Object.hasOwn" &&
    test.arguments.length === 2 &&
    source.getText(unwrap(test.arguments[0])) === guard.object &&
    source.getText(unwrap(test.arguments[1])) === guard.key
  );
}

/** `test` is false only when `Object.hasOwn(object, key)` is (so its else branch, or the code after it, has it). */
function refutes(source, test, guard) {
  if (test?.type === "UnaryExpression" && test.operator === "!") return proves(source, test.argument, guard);
  if (test?.type === "LogicalExpression" && test.operator === "||") {
    return refutes(source, test.left, guard) || refutes(source, test.right, guard);
  }
  return false;
}

function within(child, container) {
  return Boolean(container) && child.range[0] >= container.range[0] && child.range[1] <= container.range[1];
}

function exits(statement) {
  const s = statement.type === "BlockStatement" && statement.body.length === 1 ? statement.body[0] : statement;
  return ["ReturnStatement", "ThrowStatement", "ContinueStatement", "BreakStatement"].includes(s.type);
}

/** One step up: does `parent` guarantee the check for `child`? */
function parentGuards(source, parent, child, guard) {
  if (parent.type === "IfStatement" || parent.type === "ConditionalExpression") {
    return (
      (within(child, parent.consequent) && proves(source, parent.test, guard)) ||
      (within(child, parent.alternate) && refutes(source, parent.test, guard))
    );
  }
  if (parent.type === "LogicalExpression" && within(child, parent.right)) {
    return parent.operator === "&&" ? proves(source, parent.left, guard) : refutes(source, parent.left, guard);
  }
  const body = parent.type === "SwitchCase" ? parent.consequent : parent.body;
  if (!Array.isArray(body)) return false;
  return body
    .slice(0, Math.max(body.indexOf(child), 0))
    .some((s) => s.type === "IfStatement" && !s.alternate && exits(s.consequent) && refutes(source, s.test, guard));
}

function guarded(source, node, guard) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parentGuards(source, parent, child, guard)) return true;
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "A plain-object lookup by an arbitrary string key reaches Object.prototype" },
    messages: {
      lookup:
        "A plain-object lookup by an arbitrary string key reaches Object.prototype ('constructor', '__proto__', ...). " +
        "Use a Map, own(table, key), an Object.hasOwn check first, or an Object.create(null) / Dict<V> table.",
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode;
    const services = source.parserServices;
    if (!services?.program) throw new Error("own-keys/no-prototype-keys needs type information (projectService)");
    const checker = services.program.getTypeChecker();
    const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
    const check = (node, object, key) => {
      if (isStaticKey(key) || !arbitraryString(checker, typeOf(unwrap(key)))) return;
      const objectType = typeOf(object);
      if (arrayOrString(checker, objectType) || nullPrototypeType(objectType)) return;
      if (madeWithNullPrototype(source, object)) return;
      const guard = { object: source.getText(unwrap(object)), key: source.getText(unwrap(key)) };
      if (guarded(source, node, guard)) return;
      context.report({ node, messageId: "lookup" });
    };
    return {
      MemberExpression: (node) => {
        if (node.computed) check(node, node.object, node.property);
      },
      BinaryExpression: (node) => {
        if (node.operator === "in" && node.left.type !== "PrivateIdentifier") check(node, node.right, node.left);
      },
    };
  },
};
