// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * AppManifest v1: how Claw hosts an application as a task of mode `app`.
 *
 * A manifest is registered as a plugin (`resource.app.manifest`) and kept by
 * the plugin administrator; the application and the AI it runs cannot change
 * it. It says what to start and what to hand it, in terms of Claw's own
 * facilities. Claw reads values out of the run's input by JSON Pointer and
 * does not know what any field means; the left side of `env_map` is the only
 * vocabulary Claw owns, and the names on the right are the application's.
 *
 * Contract points that are easy to get wrong:
 *
 *  - Every `*_from_input` value, and every `grant_from_input` value, is a JSON
 *    Pointer (RFC 6901) into the run input. An array of pointers means "the
 *    first one that exists".
 *  - `sandbox_templates` and `sandbox_roles` stay in the manifest, but Claw
 *    does not register templates itself: they are handed to Agent Sandbox as
 *    the grant's `templates` and `roles` when the grant is issued.
 *  - `grant_from_input` maps a limit of the grant to a pointer into the input.
 *    `grant_extra` is added after pointer resolution (for example one slot for
 *    a sub-run), and the platform limit then caps the sum; GPU-hours are
 *    multiplied by `limits.gpu_hours_headroom` before that cap. The granted
 *    limits are injected back through
 *    `env_map.grant_limits` so the app can plan within what it actually got.
 *
 * Optional fields are omitted rather than written as empty. The documented
 * defaults are in {@link APP_MANIFEST_DEFAULTS}.
 */
import { validateAgainstSchema, type SchemaNode } from "./json-schema-lite.js";

export const APP_MANIFEST_SCHEMA = "claw.app-manifest/v1" as const;

/** The key roles a hosted app can hold; one sandbox key is issued per role. */
export const APP_SANDBOX_ROLES = ["measurement", "subrun", "dev"] as const;
export type AppSandboxRole = (typeof APP_SANDBOX_ROLES)[number];

/** The limits of a grant that the manifest can set from the input or from a constant. */
export const APP_GRANT_KEYS = [
  "measurement.max_sandboxes",
  "measurement.gpus_per_sandbox",
  "gpu_hours_budget",
  "max_hours",
  "subrun.max_sandboxes",
] as const;
export type AppGrantKey = (typeof APP_GRANT_KEYS)[number];

/** Defaults Claw applies when the manifest omits the field. */
export const APP_MANIFEST_DEFAULTS = {
  stop_grace_sec: 900,
  gpu_hours_headroom: 1.3,
} as const;

/** A JSON Pointer (RFC 6901) into the run input. */
export type JsonPointer = string;

export interface AppContainerResourcesFromInput {
  cpu?: JsonPointer;
  /** Gi of memory; Claw renders it as `<n>Gi`. */
  memory_gi?: JsonPointer;
}

export interface AppContainer {
  /** A fixed image. Exactly one of `image` and `image_from_input` is given. */
  image?: string;
  /** The image is read from the run input at this pointer. */
  image_from_input?: JsonPointer;
  gpus_from_input?: JsonPointer;
  workspace_from_input?: JsonPointer | JsonPointer[];
  /** A value found here overrides the same key in `resources`. */
  resources_from_input?: AppContainerResourcesFromInput;
  /** Hard limits of the app container; the platform enforces them. */
  resources?: Record<string, string>;
}

export interface AppBootstrap {
  /** Path relative to the state directory. */
  file: string;
  content_b64: string;
}

export interface AppEnvMapSandboxKeys {
  measurement?: string;
  subrun?: string;
  dev?: string;
}

/**
 * Claw facility -> the app's variable name. Only the left side is Claw's.
 * `E2B_API_URL`, `E2B_SANDBOX_URL` and `AWS_*` are generic and never mapped.
 */
export interface AppEnvMap {
  run_id?: string;
  run_created_at?: string;
  state_dir?: string;
  input_file?: string;
  events_dir?: string;
  /** The `mcp_*` facilities need `mcp` to be declared. */
  mcp_port?: string;
  mcp_token?: string;
  mcp_public_url?: string;
  sandbox_templates?: string;
  sandbox_keys?: AppEnvMapSandboxKeys;
  result_archive?: string;
  /** The limits actually granted, as JSON, so the app plans within them. */
  grant_limits?: string;
}

export interface AppEvents {
  /** Relative to the state directory. */
  dir: string;
  format: "cloudevents/v1";
}

export interface AppMcp {
  port: number;
  path: string;
  token_header: string;
  /** Also reachable from sub-run sandboxes. */
  public?: boolean;
}

export interface AppSandboxTemplateStart {
  script_b64?: string;
  env_from_input?: Record<string, JsonPointer>;
}

export interface AppSandboxTemplateDataPlane {
  mode: "sealed" | "open";
  inputs?: string[];
  outputs?: string[];
}

/**
 * A sandbox template, passed to Agent Sandbox as part of the grant. Its fields
 * are owned by the Agent Sandbox design, not by Claw: Claw reads `name`
 * (roles refer to it) and `per_gpu_count`, and hands every other field through
 * unvalidated and unchanged (Agent Sandbox stores them whole as the template's
 * `spec`).
 */
export interface AppSandboxTemplate {
  name: string;
  /** Allowed GPU counts per sandbox; Agent Sandbox's `perGpuCount`. */
  per_gpu_count?: number[];
  [field: string]: unknown;
}

export type AppSandboxRoles = { [R in AppSandboxRole]?: string[] };

export interface AppRestart {
  /**
   * Whether the app ran to its end is read from `exit.json` `final` and
   * nothing else: `final: true` ends the run (failed when the return code is
   * non-zero) and is never restarted; a missing `final` is a restart.
   * Restart n waits `backoff_sec[min(n, length - 1)]`.
   */
  max_restarts: number;
  backoff_sec: number[];
}

export interface AppLimits {
  /** Defaults for the per-role sandbox ceiling; `grant_from_input` and `grant_extra` apply first, then the platform limit caps the result. */
  max_sandboxes?: { [R in AppSandboxRole]?: number };
  max_runtime_sec?: number;
  input_max_bytes?: number;
  /**
   * Multiplier from the planned GPU-hours to the granted budget (default 1.3),
   * applied before the platform limit caps the budget.
   * Measurement sandboxes are per test; headroom covers cold start, PRELUDE
   * and withdrawn tests.
   */
  gpu_hours_headroom?: number;
}

export interface AppManifestV1 {
  schema: typeof APP_MANIFEST_SCHEMA;
  name: string;
  version: string;
  container: AppContainer;
  /** May reference `${USER_DATA_PATH}` and `${run_id}`; expanded inside the sandbox. */
  state_dir: string;
  command: string[];
  bootstrap?: AppBootstrap;
  env?: Record<string, string>;
  /** A value found overrides the same key in `env`. */
  env_from_input?: Record<string, JsonPointer>;
  env_map?: AppEnvMap;
  events?: AppEvents;
  mcp?: AppMcp;
  sandbox_templates?: AppSandboxTemplate[];
  sandbox_roles?: AppSandboxRoles;
  grant_from_input?: { [K in AppGrantKey]?: JsonPointer };
  /** Constants added to the granted limits after pointer resolution. */
  grant_extra?: { [K in AppGrantKey]?: number };
  restart?: AppRestart;
  /** Seconds to wait after SIGTERM on cancel. Default 900. */
  stop_grace_sec?: number;
  limits?: AppLimits;
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

const POINTER_PATTERN = "^(?:/(?:[^~/]|~[01])*)+$";
const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const B64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const posInt = { type: "integer", minimum: 1 } as const;
const nonNegInt = { type: "integer", minimum: 0 } as const;
const nonEmptyStr = { type: "string", minLength: 1 } as const;

/** An object with one optional property per name of a closed set. */
const closedSet = (names: readonly string[], valueSchema: object) => ({
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(names.map((n) => [n, valueSchema])),
});

/** JSON Schema (draft 2020-12) for {@link AppManifestV1}. */
export const APP_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: APP_MANIFEST_SCHEMA,
  type: "object",
  additionalProperties: false,
  required: ["schema", "name", "version", "container", "state_dir", "command"],
  $defs: {
    pointer: { type: "string", format: "json-pointer", pattern: POINTER_PATTERN },
    pointerOrList: {
      oneOf: [ref("pointer"), { type: "array", minItems: 1, items: ref("pointer") }],
    },
    pointerMap: { type: "object", additionalProperties: ref("pointer") },
    envName: { type: "string", pattern: ENV_NAME_PATTERN },
    stringMap: { type: "object", additionalProperties: nonEmptyStr },
    base64: { type: "string", minLength: 1, pattern: B64_PATTERN },
    // Only what Claw reads (name, per_gpu_count) is checked; the rest of a template is Agent
    // Sandbox's and passes through (no additionalProperties restriction).
    template: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,62}$" },
        per_gpu_count: { type: "array", minItems: 1, uniqueItems: true, items: posInt },
      },
    },
  },
  properties: {
    schema: { const: APP_MANIFEST_SCHEMA },
    name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$" },
    container: {
      type: "object",
      additionalProperties: false,
      properties: {
        image: nonEmptyStr,
        image_from_input: ref("pointer"),
        gpus_from_input: ref("pointer"),
        workspace_from_input: ref("pointerOrList"),
        resources_from_input: {
          type: "object",
          additionalProperties: false,
          properties: { cpu: ref("pointer"), memory_gi: ref("pointer") },
        },
        resources: ref("stringMap"),
      },
    },
    state_dir: nonEmptyStr,
    command: { type: "array", minItems: 1, items: nonEmptyStr },
    bootstrap: {
      type: "object",
      additionalProperties: false,
      required: ["file", "content_b64"],
      properties: { file: nonEmptyStr, content_b64: ref("base64") },
    },
    env: ref("stringMap"),
    env_from_input: ref("pointerMap"),
    env_map: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: ref("envName"),
        run_created_at: ref("envName"),
        state_dir: ref("envName"),
        input_file: ref("envName"),
        events_dir: ref("envName"),
        mcp_port: ref("envName"),
        mcp_token: ref("envName"),
        mcp_public_url: ref("envName"),
        sandbox_templates: ref("envName"),
        sandbox_keys: closedSet(APP_SANDBOX_ROLES, ref("envName")),
        result_archive: ref("envName"),
        grant_limits: ref("envName"),
      },
    },
    events: {
      type: "object",
      additionalProperties: false,
      required: ["dir", "format"],
      properties: { dir: nonEmptyStr, format: { const: "cloudevents/v1" } },
    },
    mcp: {
      type: "object",
      additionalProperties: false,
      required: ["port", "path", "token_header"],
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535 },
        path: nonEmptyStr,
        token_header: nonEmptyStr,
        public: { type: "boolean" },
      },
    },
    sandbox_templates: { type: "array", minItems: 1, items: ref("template") },
    sandbox_roles: closedSet(APP_SANDBOX_ROLES, { type: "array", minItems: 1, items: nonEmptyStr }),
    grant_from_input: closedSet(APP_GRANT_KEYS, ref("pointer")),
    grant_extra: closedSet(APP_GRANT_KEYS, { type: "number", minimum: 0 }),
    restart: {
      type: "object",
      additionalProperties: false,
      required: ["max_restarts", "backoff_sec"],
      properties: {
        max_restarts: nonNegInt,
        backoff_sec: { type: "array", items: posInt },
      },
    },
    stop_grace_sec: { ...nonNegInt, default: APP_MANIFEST_DEFAULTS.stop_grace_sec },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_sandboxes: closedSet(APP_SANDBOX_ROLES, posInt),
        max_runtime_sec: posInt,
        input_max_bytes: posInt,
        gpu_hours_headroom: { type: "number", minimum: 1, default: APP_MANIFEST_DEFAULTS.gpu_hours_headroom },
      },
    },
  },
} as const satisfies SchemaNode;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface AppManifestIssue {
  /** Dotted path with `[i]` for array items; `(root)` for the document. */
  path: string;
  reason: string;
}

/** Variable names a manifest may not set: the platform owns them. */
const RESERVED_ENV = /^(?:E2B_.*|AWS_.*|CLAW_.*|NODE_NAME|USER_DATA_PATH)$/;
const STATE_DIR_VARS = new Set(["USER_DATA_PATH", "run_id"]);
const COUNT_GRANT_KEYS = new Set<string>([
  "measurement.max_sandboxes", "measurement.gpus_per_sandbox", "subrun.max_sandboxes",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True when the path stays inside its base: relative, no `..` segment. */
const isContainedRelative = (p: string): boolean =>
  !p.startsWith("/") && !p.split("/").includes("..");

/**
 * Check a manifest. Returns every problem found, each with its path; an empty
 * list means the manifest is valid. Structure comes from
 * {@link APP_MANIFEST_JSON_SCHEMA} itself. On top of it, the rules a schema
 * cannot say and the app runner relies on: every template a role names is
 * defined, every key a section names has its role, no two things write the
 * same variable, and a path stays inside its directory.
 */
export function validateAppManifest(value: unknown): AppManifestIssue[] {
  const issues: AppManifestIssue[] = validateAgainstSchema(APP_MANIFEST_JSON_SCHEMA, value);
  if (!isObj(value)) return issues;
  const bad = (path: string, reason: string): void => void issues.push({ path, reason });
  const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

  // The image: exactly one of a fixed string or a pointer into the input.
  const container = obj(value.container);
  if (Object.hasOwn(container, "image") && Object.hasOwn(container, "image_from_input")) {
    bad("container.image", "cannot be combined with container.image_from_input; give exactly one");
  } else if (isObj(value.container) && !Object.hasOwn(container, "image") && !Object.hasOwn(container, "image_from_input")) {
    bad("container", "needs exactly one of image or image_from_input; neither is given");
  }

  // Templates: unique names (the only thing Claw reads besides the roles).
  const defined = new Set<string>();
  if (Array.isArray(value.sandbox_templates)) {
    value.sandbox_templates.forEach((t, i) => {
      if (!isObj(t)) return;
      const at = `sandbox_templates[${i}]`;
      if (typeof t.name === "string") {
        if (defined.has(t.name)) bad(`${at}.name`, `template ${JSON.stringify(t.name)} is defined twice`);
        defined.add(t.name);
      }
    });
  }

  // Roles: every template a role names is defined.
  const roles = obj(value.sandbox_roles);
  for (const [role, names] of Object.entries(roles)) {
    if (!Array.isArray(names)) continue;
    names.forEach((n, i) => {
      if (typeof n === "string" && !defined.has(n)) {
        bad(`sandbox_roles.${role}[${i}]`, `template ${JSON.stringify(n)} is not defined in sandbox_templates`);
      }
    });
  }
  const hasRole = (r: string): boolean => Array.isArray(roles[r]);

  // Anything keyed by role needs that role to exist.
  const needRole = (section: string, key: string, role: string): void => {
    if (!hasRole(role)) bad(`${section}.${key}`, `role ${JSON.stringify(role)} is not declared in sandbox_roles`);
  };
  for (const role of Object.keys(obj(obj(value.env_map).sandbox_keys))) needRole("env_map.sandbox_keys", role, role);
  for (const role of Object.keys(obj(obj(value.limits).max_sandboxes))) needRole("limits.max_sandboxes", role, role);
  for (const section of ["grant_from_input", "grant_extra"] as const) {
    for (const [key, v] of Object.entries(obj(value[section]))) {
      const role = key.includes(".") ? key.split(".")[0]! : null;
      if (role) needRole(section, key, role);
      if (section === "grant_extra" && typeof v === "number" && COUNT_GRANT_KEYS.has(key) && !Number.isInteger(v)) {
        bad(`grant_extra.${key}`, "must be an integer");
      }
    }
  }

  // Variables: no collisions, nothing the platform owns.
  const envMap = obj(value.env_map);
  const targets = new Map<string, string>();
  const mapTarget = (path: string, name: unknown): void => {
    if (typeof name !== "string") return;
    if (RESERVED_ENV.test(name)) bad(path, `${name} is reserved for the platform and cannot be mapped`);
    const prior = targets.get(name);
    if (prior) bad(path, `${name} is already the target of ${prior}`);
    else targets.set(name, path);
  };
  for (const [facility, name] of Object.entries(envMap)) {
    if (facility === "sandbox_keys") {
      for (const [role, n] of Object.entries(obj(name))) mapTarget(`env_map.sandbox_keys.${role}`, n);
    } else {
      mapTarget(`env_map.${facility}`, name);
    }
  }
  for (const section of ["env", "env_from_input"] as const) {
    for (const k of Object.keys(obj(value[section]))) {
      const p = `${section}.${k}`;
      if (RESERVED_ENV.test(k)) bad(p, `${k} is reserved for the platform and cannot be set`);
      else if (targets.has(k)) bad(p, `${k} is also the target of ${targets.get(k)}`);
    }
  }
  if (!isObj(value.mcp)) {
    for (const f of ["mcp_port", "mcp_token", "mcp_public_url"]) {
      if (Object.hasOwn(envMap, f)) bad(`env_map.${f}`, "needs mcp to be declared");
    }
  } else if (Object.hasOwn(envMap, "mcp_public_url") && value.mcp.public !== true) {
    bad("env_map.mcp_public_url", "needs mcp.public to be true");
  }
  if (Object.hasOwn(envMap, "sandbox_templates") && !Array.isArray(value.sandbox_templates)) {
    bad("env_map.sandbox_templates", "needs sandbox_templates to be declared");
  }

  // Paths and placeholders stay where they are meant to.
  if (typeof value.state_dir === "string") {
    // A scan, not a regex: each step moves past what it consumed, so the cost
    // is linear however many `${` the string repeats.
    const dir = value.state_dir;
    for (let at = dir.indexOf("${"); at !== -1; at = dir.indexOf("${", at)) {
      const close = dir.indexOf("}", at + 2);
      if (close === -1) break;
      const name = dir.slice(at + 2, close);
      if (!STATE_DIR_VARS.has(name)) bad("state_dir", `unknown placeholder \${${name}}; only \${USER_DATA_PATH} and \${run_id} are expanded`);
      at = close + 1;
    }
  }
  const bootstrap = obj(value.bootstrap);
  if (typeof bootstrap.file === "string" && !isContainedRelative(bootstrap.file)) {
    bad("bootstrap.file", "must be relative to the state directory and not contain ..");
  }
  const events = obj(value.events);
  if (typeof events.dir === "string" && !isContainedRelative(events.dir)) {
    bad("events.dir", "must be relative to the state directory and not contain ..");
  }
  const mcp = obj(value.mcp);
  if (typeof mcp.path === "string" && !mcp.path.startsWith("/")) bad("mcp.path", 'must start with "/"');

  // Restart needs a backoff to apply.
  const restart = obj(value.restart);
  if (typeof restart.max_restarts === "number" && restart.max_restarts > 0 &&
      Array.isArray(restart.backoff_sec) && restart.backoff_sec.length === 0) {
    bad("restart.backoff_sec", "must have at least 1 item when max_restarts > 0");
  }

  return issues;
}

