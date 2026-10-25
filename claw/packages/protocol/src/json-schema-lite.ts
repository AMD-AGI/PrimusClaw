// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A validator for the small JSON Schema subset the protocol documents use.
 *
 * The protocol package carries no schema library, and a hand-written validator
 * beside a schema constant is two things that can drift. This interprets the
 * schema constant itself, so the structural rules are written once: what the
 * schema says is what is enforced. Cross-field rules a schema cannot express
 * stay in the document's own validator.
 *
 * Supported keywords: `$ref` (to `#/$defs/<name>` of the root), `type`
 * (object, array, string, integer, number, boolean), `const`, `enum`,
 * `properties`, `required`, `additionalProperties` (false or a schema),
 * `items`, `minItems`, `uniqueItems`, `minLength`, `pattern`, `minimum`,
 * `maximum`, and `oneOf` for a value that is either a scalar or an array (the
 * branch is chosen by the value's JSON type). Everything else in a schema
 * (`$schema`, `$id`, `description`, `default`, `format`) is an annotation here.
 * An unsupported structural keyword throws, so a schema cannot quietly use one
 * this does not enforce.
 */

export interface SchemaIssue {
  path: string;
  reason: string;
}

export type SchemaNode = { readonly [k: string]: unknown };

const ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "description", "default", "format", "title", "examples", "$defs",
]);
const KEYWORDS = new Set([
  "$ref", "type", "const", "enum", "properties", "required", "additionalProperties", "items",
  "minItems", "uniqueItems", "minLength", "pattern", "minimum", "maximum", "oneOf",
]);

// Own-key checks throughout: `in` also finds Object.prototype members, so a
// field named `constructor` would be taken for a declared property.
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const typeMatches = (want: string, v: unknown): boolean => {
  const have = jsonType(v);
  return want === have || (want === "number" && have === "integer");
};

export const joinPath = (base: string, key: string): string => (base ? `${base}.${key}` : key);

export function validateAgainstSchema(root: SchemaNode, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const defs = (root.$defs ?? {}) as Record<string, SchemaNode>;

  const visit = (schema: SchemaNode, v: unknown, path: string): void => {
    for (const k of Object.keys(schema)) {
      if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`json-schema-lite: unsupported keyword ${k}`);
    }
    const at = path || "(root)";
    if (typeof schema.$ref === "string") {
      const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
      const target = m ? defs[m[1]!] : undefined;
      if (!target) throw new Error(`json-schema-lite: unresolved $ref ${schema.$ref}`);
      visit(target, v, path);
      return;
    }
    if (Array.isArray(schema.oneOf)) {
      const branches = schema.oneOf as SchemaNode[];
      const t = jsonType(v);
      const typeOf = (b: SchemaNode): unknown => {
        const m = typeof b.$ref === "string" ? /^#\/\$defs\/(.+)$/.exec(b.$ref) : null;
        return m ? defs[m[1]!]?.type : b.type;
      };
      const picked = branches.filter((b) => {
        const bt = typeOf(b);
        return typeof bt === "string" && typeMatches(bt, v);
      });
      if (picked.length !== 1) {
        const want = branches.map((b) => String(typeOf(b))).join(" or ");
        issues.push({ path: at, reason: `must be ${want}, got ${t}` });
        return;
      }
      visit(picked[0]!, v, path);
      return;
    }
    if (typeof schema.type === "string" && !typeMatches(schema.type, v)) {
      issues.push({ path: at, reason: `must be ${/^[aeiou]/.test(schema.type) ? "an" : "a"} ${schema.type}, got ${jsonType(v)}` });
      return;
    }
    if ("const" in schema && v !== schema.const) {
      issues.push({ path: at, reason: `must be ${JSON.stringify(schema.const)}` });
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(v as never)) {
      issues.push({ path: at, reason: `must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}` });
    }
    if (typeof v === "string") {
      if (typeof schema.minLength === "number" && v.length < schema.minLength) {
        issues.push({ path: at, reason: schema.minLength === 1 ? "must not be empty" : `must be at least ${schema.minLength} characters` });
      } else if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(v)) {
        issues.push({ path: at, reason: `must match ${schema.pattern}` });
      }
    }
    if (typeof v === "number") {
      if (typeof schema.minimum === "number" && v < schema.minimum) issues.push({ path: at, reason: `must be >= ${schema.minimum}` });
      if (typeof schema.maximum === "number" && v > schema.maximum) issues.push({ path: at, reason: `must be <= ${schema.maximum}` });
    }
    if (Array.isArray(v)) {
      if (typeof schema.minItems === "number" && v.length < schema.minItems) {
        issues.push({ path: at, reason: `must have at least ${schema.minItems} item(s)` });
      }
      if (schema.uniqueItems === true) {
        const seen = new Set<string>();
        v.forEach((x, i) => {
          const key = JSON.stringify(x);
          if (seen.has(key)) issues.push({ path: `${path}[${i}]`, reason: "duplicates an earlier item" });
          seen.add(key);
        });
      }
      if (isObj(schema.items)) v.forEach((x, i) => visit(schema.items as SchemaNode, x, `${path}[${i}]`));
    }
    if (isObj(v)) {
      const props = (schema.properties ?? {}) as Record<string, SchemaNode>;
      for (const k of (schema.required ?? []) as string[]) {
        if (!Object.hasOwn(v, k)) issues.push({ path: joinPath(path, k), reason: "required" });
      }
      for (const [k, val] of Object.entries(v)) {
        if (Object.hasOwn(props, k)) visit(props[k]!, val, joinPath(path, k));
        else if (isObj(schema.additionalProperties)) visit(schema.additionalProperties as SchemaNode, val, joinPath(path, k));
        else if (schema.additionalProperties === false) issues.push({ path: joinPath(path, k), reason: "unknown field" });
      }
    }
  };

  visit(root, value, "");
  return issues;
}
