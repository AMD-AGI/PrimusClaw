// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * AppManifest v1: how Claw hosts an application as a task of mode `app`.
 *
 * A manifest is registered as a plugin (`resource.app.manifest`) and kept by
 * the plugin administrator; the application and the AI it runs cannot change
 * it. It says what to start and what to hand it, in terms of Claw's own
 * facilities. It does not say where the app's resources come from: the image,
 * GPU count, workspace and grant limits are requested explicitly by whoever
 * creates the run (see app-resources.ts), the way a Kubernetes Pod spells out
 * its resources apart from the container's arguments. Claw never reads the
 * run's `input`; it only hands it to the app. The left side of `env_map` is the
 * only vocabulary Claw owns, and the names on the right are the application's.
 *
 * Contract points that are easy to get wrong:
 *
 *  - `container.image` is only a default; `resources.image` in the request
 *    wins. A run with neither is refused.
 *  - `sandbox_templates` and `sandbox_roles` stay in the manifest, but Claw
 *    does not register templates itself: they are handed to Agent Sandbox as
 *    the grant's `templates` and `roles` when the grant is issued. A template
 *    that sets no `image` or `workspace` inherits the run's. The names Agent
 *    Sandbox stored them under come back in the grant response and are injected
 *    through `env_map.sandbox_templates` as `{ role: { cards: name } }` (see
 *    app-sandbox-templates.ts); a manifest with no `sandbox_roles` gets none.
 *  - `limits` are defaults and maxima for the request's `resources.grant`; the
 *    platform cap (`APP_SANDBOX_CAPS`) then caps each item. The limits actually
 *    granted are injected back through `env_map.grant_limits` so the app can
 *    plan within what it got.
 *
 * Optional fields are omitted rather than written as empty. The documented
 * defaults are in {@link APP_MANIFEST_DEFAULTS}.
 */
import { validateAgainstSchema, type SchemaNode } from "./json-schema-lite.js";
import { parseQuantity } from "./app-resources.js";
import { isBashFuncInjection, isClawInternalEnv, isHandsInternalEnv, USER_ENV_DENY_LIST } from "./user-env.js";

export const APP_MANIFEST_SCHEMA = "claw.app-manifest/v1" as const;

/** The key roles a hosted app can hold; one sandbox key is issued per role. */
export const APP_SANDBOX_ROLES = ["measurement", "subrun", "dev"] as const;
export type AppSandboxRole = (typeof APP_SANDBOX_ROLES)[number];

/** Defaults Claw applies when the manifest omits the field. */
export const APP_MANIFEST_DEFAULTS = {
  stop_grace_sec: 900,
} as const;

export interface AppContainer {
  /** The default image; `resources.image` in the request wins. Optional. */
  image?: string;
  /**
   * Default container resources, and the most a request may ask for in each key
   * the manifest declares (`cpu`, `memory`): a larger `resources.cpu` /
   * `memory_gi` is refused. No GPU key may appear here (`amd.com/gpu`, `gpu`, or
   * any key ending in `/gpu`): the GPU count comes only from the request's `resources.gpus`,
   * so admission, which counts that one key, sees every GPU the pod gets. Whatever is finally
   * dispatched, SaFE enforces as the container's hard limit (exceeding memory is
   * an OOM kill). A key the manifest leaves out has no manifest maximum.
   */
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
  /**
   * The template names the grant made available, as JSON: `{ role: { cards: name } }`
   * (see app-sandbox-templates.ts). Injected only when a grant was issued; the
   * names are the ones Agent Sandbox returned, never derived from the manifest.
   */
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
  /**
   * Default and upper bound of the grant's `max_sandboxes`: the request's value
   * when it gives one, else this, and never more than this or the platform cap
   * (the smallest of the three that are set).
   */
  max_sandboxes?: number;
  /** Maximum run time: the grant's `max_runtime_sec` is the smaller of this and the request. */
  max_runtime_sec?: number;
  /** The only thing Claw checks about `input`: its size. */
  input_max_bytes?: number;
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
  env_map?: AppEnvMap;
  events?: AppEvents;
  mcp?: AppMcp;
  sandbox_templates?: AppSandboxTemplate[];
  sandbox_roles?: AppSandboxRoles;
  restart?: AppRestart;
  /** Seconds to wait after SIGTERM on cancel. Default 900. */
  stop_grace_sec?: number;
  limits?: AppLimits;
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";
const ENV_NAME_RE = new RegExp(ENV_NAME_PATTERN);
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
        max_sandboxes: posInt,
        max_runtime_sec: posInt,
        input_max_bytes: posInt,
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

/**
 * The variables Claw itself sets in an application's sandbox. Code that injects
 * one of them uses this table, not a literal, so a new one is a new entry here and
 * is reserved by construction (the brain test `app-reserved-env.test.ts`, added
 * with the runner, also scans the injection code for names missing from the rules).
 */
export const APP_PLATFORM_ENV = {
  session_id: "CLAW_SESSION_ID",
  app_run_id: "CLAW_APP_RUN_ID",
  node_name: "NODE_NAME",
  user_data_path: "USER_DATA_PATH",
  topology_handoff_file: "TOPOLOGY_HANDOFF_FILE",
} as const;

const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set(Object.values(APP_PLATFORM_ENV));
/**
 * Families the platform and Agent Sandbox own wholesale: `E2B_*`, `AWS_*`, the
 * multi-node variables Brain injects (`HYPERLOOM_MN_EXT_*`, `INFERENCE_OPTIMIZER_*`).
 * (`CLAW_*`, `HANDS_*` and `BASH_FUNC_*` come from the user-env rules below.)
 */
const RESERVED_ENV_PREFIXES = ["E2B_", "AWS_", "HYPERLOOM_MN_EXT_", "INFERENCE_OPTIMIZER_"] as const;

/** RFC 7230 `token`: what a header name may be made of. */
const HTTP_HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Headers the platform sets on a request to the application's MCP, or that the
 * transport owns. The MCP token's header may not shadow one of them: the config's
 * `headers` are applied over `Authorization` and `x-session-id`.
 */
const RESERVED_MCP_HEADERS: ReadonlySet<string> = new Set([
  "authorization", "x-session-id", "x-internal-token", "x-hands-token", "mcp-session-id",
  "host", "content-type", "content-length", "accept", "connection", "transfer-encoding", "upgrade", "cookie",
]);

/**
 * True when a manifest may not set or map this variable: the platform owns it.
 * One source with user env: everything `USER_ENV_DENY_LIST` (the linker, shell and
 * runtime hooks, the platform's credentials and contracts), the `CLAW_*`, `HANDS_*`
 * and `BASH_FUNC_*` families, plus what only an app run injects.
 */
export function isReservedAppEnv(name: string): boolean {
  return RESERVED_ENV_NAMES.has(name)
    || USER_ENV_DENY_LIST.has(name)
    || isClawInternalEnv(name)
    || isHandsInternalEnv(name)
    || isBashFuncInjection(name)
    || RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p));
}

/** True for a resource name that counts GPUs: `gpu`, `amd.com/gpu`, `nvidia.com/gpu`, ... */
export function isGpuResourceKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return k === "gpu" || k.endsWith("/gpu");
}

/** `name` or `prefix/name`, as Kubernetes spells a resource: lower-case DNS-like prefix, then a name. */
const RESOURCE_NAME_RE = /^(?:[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const STATE_DIR_VARS = new Set(["USER_DATA_PATH", "run_id"]);

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

  // container.resources: no GPU key (the count is the request's alone), a Kubernetes
  // resource name for every key, and a readable quantity for every value, so a
  // manifest that could never run is refused when it is registered and not on every
  // submitter's request.
  for (const [k, v] of Object.entries(obj(obj(value.container).resources))) {
    if (isGpuResourceKey(k)) {
      bad(`container.resources.${k}`, "a GPU key is not allowed here: the GPU count comes only from the request's resources.gpus");
      continue;
    }
    if (!RESOURCE_NAME_RE.test(k)) bad(`container.resources.${k}`, "not a Kubernetes resource name");
    if (typeof v === "string" && parseQuantity(v) === undefined) {
      bad(`container.resources.${k}`, `${JSON.stringify(v)} is not a readable quantity (for example "8", "500m", "32Gi")`);
    }
  }

  // Variables: no collisions, nothing the platform owns.
  const envMap = obj(value.env_map);
  const targets = new Map<string, string>();
  const mapTarget = (path: string, name: unknown): void => {
    if (typeof name !== "string") return;
    if (isReservedAppEnv(name)) bad(path, `${name} is reserved for the platform and cannot be mapped`);
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
  {
    for (const k of Object.keys(obj(value.env))) {
      const p = `env.${k}`;
      if (!ENV_NAME_RE.test(k)) bad(p, `${JSON.stringify(k)} is not a valid variable name; must match ${ENV_NAME_PATTERN}`);
      else if (isReservedAppEnv(k)) bad(p, `${k} is reserved for the platform and cannot be set`);
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
    // is linear however many `$` the string repeats. Only the two complete
    // spellings `${USER_DATA_PATH}` and `${run_id}` may contain a `$`.
    const dir = value.state_dir;
    const only = "only ${USER_DATA_PATH} and ${run_id} are expanded";
    // The contract: a path under `${USER_DATA_PATH}/` or an absolute path, with no `..`
    // segment, and `${run_id}` in it so two runs of one app never share a directory.
    if (dir.split("/").includes("..")) bad("state_dir", "must not contain a .. segment");
    if (!dir.startsWith("/") && !dir.startsWith("${USER_DATA_PATH}/")) {
      bad("state_dir", "must be an absolute path or start with ${USER_DATA_PATH}/");
    }
    if (!dir.includes("${run_id}")) bad("state_dir", "must contain ${run_id}, or concurrent runs of one app share a directory");
    for (let at = dir.indexOf("$"); at !== -1; ) {
      if (dir.startsWith("${", at)) {
        const close = dir.indexOf("}", at + 2);
        if (close === -1) {
          bad("state_dir", `unterminated placeholder at offset ${at}; ${only}`);
          break;
        }
        const name = dir.slice(at + 2, close);
        if (!STATE_DIR_VARS.has(name)) bad("state_dir", `unknown placeholder \${${name.slice(0, 40)}}; ${only}`);
        at = dir.indexOf("$", close + 1);
      } else {
        bad("state_dir", `a bare $ at offset ${at} is not allowed; ${only}`);
        break;
      }
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
  if (typeof mcp.token_header === "string") {
    if (!HTTP_HEADER_TOKEN.test(mcp.token_header)) bad("mcp.token_header", "must be an HTTP header name (RFC 7230 token)");
    else if (RESERVED_MCP_HEADERS.has(mcp.token_header.toLowerCase())) {
      bad("mcp.token_header", "must not be a header the platform sets on the request");
    }
  }

  // Restart needs a backoff to apply.
  const restart = obj(value.restart);
  if (typeof restart.max_restarts === "number" && restart.max_restarts > 0 &&
      Array.isArray(restart.backoff_sec) && restart.backoff_sec.length === 0) {
    bad("restart.backoff_sec", "must have at least 1 item when max_restarts > 0");
  }

  return issues;
}

